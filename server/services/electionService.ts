/**
 * @module services/electionService
 * Admin side of the voting system: elections ("votaciones") with one or more motions,
 * voter lists imported from CSV, attachments, personalized invitations and results.
 *
 * Invariants (enforced by the schema and by the code below):
 * - A voter belongs to exactly one election and appears at most once in it (UNIQUE).
 * - Only the SHA-256 hash of each voting token is stored.
 * - Ballots are anonymous; for every motion the weight of its ballots must equal the
 *   weight of the voters who voted. `getElectionDetail` reports that integrity check.
 */
import { AppError, notFound, validationError, type ErrorDetail } from "../errors.ts";
import { all, get, run, transaction } from "../db/database.ts";
import type { ServiceContext } from "../context.ts";
import type { Gender, VoterRow } from "./csvService.ts";
import { generateToken, hashToken } from "./tokenService.ts";
import {
  type PreparedAttachment,
  removeStoredFiles,
  resolveStoredPath,
  writeAttachment,
} from "./attachmentService.ts";
import { type DeliveryMode, type EmailLanguage, renderInvitation } from "./emailService.ts";

export const DEFAULT_OPTIONS: readonly string[] = ["approve", "reject"];
export const MAX_MOTIONS = 20;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 10;
const MAX_OPTION_LENGTH = 60;
const MAX_TITLE_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 5000;
const WEIGHT_EPSILON = 1e-6;

// ---------- Contracts ----------

export interface MotionInput {
  title: string;
  description: string;
  options: string[];
}

export interface ElectionInput {
  title: string;
  description: string;
  motions: MotionInput[];
  voters: VoterRow[];
  attachments: PreparedAttachment[];
}

/** Data needed to email one voter. The plain token only lives in memory. */
export interface Invitation {
  voterId: number;
  email: string;
  name: string;
  gender: Gender;
  token: string;
  tokenExpiresAt: string;
}

export interface DeliverySummary {
  sent: number;
  failed: string[];
  mode: DeliveryMode;
}

export type ElectionStatus = "open" | "closed";
export type InvitationStatus = "pending" | "sent" | "simulated" | "failed" | "legacy";

export interface ElectionStats {
  motionCount: number;
  voterCount: number;
  votedCount: number;
  pendingCount: number;
  participation: number;
  totalWeight: number;
  votedWeight: number;
  weightedParticipation: number;
}

export interface ElectionSummary {
  id: string;
  title: string;
  description: string;
  status: ElectionStatus;
  createdAt: string;
  closedAt: string | null;
  createdBy: string | null;
  stats: ElectionStats;
}

export interface OptionResult {
  id: number;
  label: string;
  weight: number;
  votes: number;
  percentage: number;
}

export interface MotionResult {
  id: string;
  position: number;
  title: string;
  description: string;
  options: OptionResult[];
  totalWeight: number;
  /** Number of individual ballots (legacy tallies excluded). */
  ballotCount: number;
  /** True when part of the tally was imported from the former JSON storage. */
  includesLegacyTally: boolean;
  integrity: { ok: boolean; expectedWeight: number; recordedWeight: number };
}

export interface AttachmentSummary {
  id: string;
  name: string;
  mimeType: string;
  size: number;
}

export interface ElectionDetail extends ElectionSummary {
  motions: MotionResult[];
  attachments: AttachmentSummary[];
  invitations: Record<InvitationStatus, number>;
}

// ---------- Validation ----------

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Parses the options of one motion (array, or comma/newline separated text). */
function parseOptions(raw: unknown, motionNumber: number, problems: ErrorDetail[]): string[] {
  const list = Array.isArray(raw)
    ? raw.map(asText)
    : asText(raw) === ""
    ? [...DEFAULT_OPTIONS]
    : asText(raw).split(/[\n,]/).map((option) => option.trim());
  const options: string[] = [];
  const seen = new Set<string>();
  for (const option of list) {
    if (option === "" || seen.has(option.toLowerCase())) continue;
    seen.add(option.toLowerCase());
    options.push(option);
  }
  const effective = options.length === 0 ? [...DEFAULT_OPTIONS] : options;

  if (effective.length < MIN_OPTIONS || effective.length > MAX_OPTIONS) {
    problems.push({
      code: "MOTION_OPTIONS_COUNT",
      message: `Motion ${motionNumber}: between ${MIN_OPTIONS} and ${MAX_OPTIONS} different options are required.`,
      row: motionNumber,
      field: "options",
    });
  }
  if (effective.some((option) => option.length > MAX_OPTION_LENGTH)) {
    problems.push({
      code: "MOTION_OPTION_TOO_LONG",
      message: `Motion ${motionNumber}: each option must be at most ${MAX_OPTION_LENGTH} characters.`,
      row: motionNumber,
      field: "options",
    });
  }
  return effective;
}

/**
 * Validates the election metadata and its motions.
 * @throws {AppError} 400 VALIDATION_ERROR with one detail per problem.
 */
export function validateElectionMetadata(
  rawTitle: unknown,
  rawDescription: unknown,
  rawMotions: unknown,
): { title: string; description: string; motions: MotionInput[] } {
  const problems: ErrorDetail[] = [];
  const title = asText(rawTitle);
  const description = asText(rawDescription);

  if (title === "" || title.length > MAX_TITLE_LENGTH) {
    problems.push({ code: "ELECTION_TITLE_INVALID", message: `Title is required (max. ${MAX_TITLE_LENGTH} characters).`, field: "title" });
  }
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    problems.push({ code: "ELECTION_DESCRIPTION_TOO_LONG", message: `Description exceeds ${MAX_DESCRIPTION_LENGTH} characters.`, field: "description" });
  }

  const motions: MotionInput[] = [];
  if (!Array.isArray(rawMotions) || rawMotions.length === 0) {
    problems.push({ code: "MOTIONS_REQUIRED", message: "At least one motion is required.", field: "motions" });
  } else if (rawMotions.length > MAX_MOTIONS) {
    problems.push({ code: "MOTIONS_TOO_MANY", message: `At most ${MAX_MOTIONS} motions are allowed.`, field: "motions" });
  } else {
    rawMotions.forEach((raw, index) => {
      const record = typeof raw === "object" && raw !== null ? raw as Record<string, unknown> : {};
      const motionNumber = index + 1;
      const motionTitle = asText(record.title);
      const motionDescription = asText(record.description);
      if (motionTitle === "" || motionTitle.length > MAX_TITLE_LENGTH) {
        problems.push({
          code: "MOTION_TITLE_INVALID",
          message: `Motion ${motionNumber}: title is required (max. ${MAX_TITLE_LENGTH} characters).`,
          row: motionNumber,
          field: "title",
        });
      }
      if (motionDescription.length > MAX_DESCRIPTION_LENGTH) {
        problems.push({
          code: "MOTION_DESCRIPTION_TOO_LONG",
          message: `Motion ${motionNumber}: description exceeds ${MAX_DESCRIPTION_LENGTH} characters.`,
          row: motionNumber,
          field: "description",
        });
      }
      motions.push({ title: motionTitle, description: motionDescription, options: parseOptions(record.options, motionNumber, problems) });
    });
  }

  if (problems.length > 0) throw validationError("Invalid election data.", problems);
  return { title, description, motions };
}

// ---------- Creation ----------

function tokenExpiry(ctx: ServiceContext, now = Date.now()): string {
  return new Date(now + ctx.config.tokenTtlHours * 3_600_000).toISOString();
}

/** Inserts voters with fresh tokens. Must run inside a transaction. */
function insertVoters(ctx: ServiceContext, electionId: string, voters: readonly VoterRow[]): Invitation[] {
  const now = new Date().toISOString();
  const expiresAt = tokenExpiry(ctx);
  const insert = ctx.db.prepare(
    `INSERT INTO voters (election_id, email, name, birthdate, gender, weight, token_hash, token_expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  return voters.map((voter) => {
    const token = generateToken();
    const result = insert.run(
      electionId, voter.email, voter.name, voter.birthdate, voter.gender, voter.weight,
      hashToken(token), expiresAt, now,
    );
    return {
      voterId: Number(result.lastInsertRowid),
      email: voter.email,
      name: voter.name,
      gender: voter.gender,
      token,
      tokenExpiresAt: expiresAt,
    };
  });
}

/**
 * Creates an election with its motions, attachments and voters in one transaction.
 * Attachment files are written first and deleted again if the transaction fails.
 */
export async function createElection(
  ctx: ServiceContext,
  input: ElectionInput,
  actorEmail: string,
): Promise<{ electionId: string; invitations: Invitation[] }> {
  if (input.voters.length === 0) {
    throw validationError("The voter list is empty.", [{ code: "CSV_NO_ROWS", message: "No voters." }]);
  }

  const storedNames: string[] = [];
  try {
    for (const attachment of input.attachments) {
      storedNames.push(await writeAttachment(ctx.config.uploadsDir, attachment));
    }
  } catch (error) {
    await removeStoredFiles(ctx.config.uploadsDir, storedNames);
    console.error("Failed to store attachments:", error);
    throw new AppError(500, "ATTACHMENT_STORAGE_FAILED", "Failed to store the attachments.");
  }

  const electionId = crypto.randomUUID();
  const now = new Date().toISOString();
  try {
    const invitations = transaction(ctx.db, () => {
      run(
        ctx.db,
        "INSERT INTO elections (id, title, description, status, created_by, created_at) VALUES (?, ?, ?, 'open', ?, ?)",
        electionId, input.title, input.description, actorEmail, now,
      );
      input.motions.forEach((motion, index) => {
        const motionId = crypto.randomUUID();
        run(
          ctx.db,
          "INSERT INTO motions (id, election_id, position, title, description) VALUES (?, ?, ?, ?, ?)",
          motionId, electionId, index + 1, motion.title, motion.description,
        );
        motion.options.forEach((label, optionIndex) => {
          run(ctx.db, "INSERT INTO motion_options (motion_id, position, label) VALUES (?, ?, ?)", motionId, optionIndex + 1, label);
        });
      });
      input.attachments.forEach((attachment, index) => {
        run(
          ctx.db,
          `INSERT INTO attachments (id, election_id, original_name, stored_name, mime_type, size, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          crypto.randomUUID(), electionId, attachment.originalName, storedNames[index],
          attachment.mimeType, attachment.bytes.byteLength, now,
        );
      });
      return insertVoters(ctx, electionId, input.voters);
    });
    return { electionId, invitations };
  } catch (error) {
    await removeStoredFiles(ctx.config.uploadsDir, storedNames);
    throw error;
  }
}

// ---------- Invitations ----------

/**
 * Emails each invitation (sequentially, friendly to SMTP rate limits) and records the
 * outcome per voter. One failed recipient never stops the others.
 */
export async function sendInvitations(
  ctx: ServiceContext,
  electionId: string,
  invitations: readonly Invitation[],
  language: EmailLanguage,
): Promise<DeliverySummary> {
  const election = get<{ title: string }>(ctx.db, "SELECT title FROM elections WHERE id = ?", electionId);
  if (!election) throw notFound("ELECTION_NOT_FOUND", "Election not found.");
  const motionTitles = all<{ title: string }>(
    ctx.db, "SELECT title FROM motions WHERE election_id = ? ORDER BY position", electionId,
  ).map((row) => row.title);
  const attachments = all<{ original_name: string; stored_name: string }>(
    ctx.db, "SELECT original_name, stored_name FROM attachments WHERE election_id = ? ORDER BY created_at, id", electionId,
  ).flatMap((row) => {
    const path = resolveStoredPath(ctx.config.uploadsDir, row.stored_name);
    return path ? [{ filename: row.original_name, path }] : [];
  });

  const summary: DeliverySummary = { sent: 0, failed: [], mode: ctx.mailer.mode };
  const markStatus = ctx.db.prepare("UPDATE voters SET invitation_status = ?, invited_at = ? WHERE id = ?");

  for (const invitation of invitations) {
    const message = renderInvitation({
      name: invitation.name,
      gender: invitation.gender,
      language,
      electionTitle: election.title,
      motionTitles,
      link: `${ctx.config.voteBaseUrl}?token=${encodeURIComponent(invitation.token)}`,
      expiresAt: invitation.tokenExpiresAt,
      attachmentCount: attachments.length,
    });
    try {
      await ctx.mailer.send({ to: invitation.email, ...message, attachments });
      markStatus.run(ctx.mailer.mode === "smtp" ? "sent" : "simulated", new Date().toISOString(), invitation.voterId);
      summary.sent += 1;
    } catch (error) {
      console.error(`Invitation delivery failed (voter #${invitation.voterId}):`, error instanceof Error ? error.message : error);
      markStatus.run("failed", new Date().toISOString(), invitation.voterId);
      summary.failed.push(invitation.email);
    }
  }
  return summary;
}

// ---------- Queries ----------

interface ElectionRow {
  id: string;
  title: string;
  description: string;
  status: ElectionStatus;
  created_at: string;
  closed_at: string | null;
  created_by: string | null;
  motion_count: number;
  voter_count: number;
  voted_count: number | null;
  total_weight: number | null;
  voted_weight: number | null;
}

const ELECTION_SUMMARY_SQL = `
  SELECT e.id, e.title, e.description, e.status, e.created_at, e.closed_at, e.created_by,
         (SELECT COUNT(*) FROM motions m WHERE m.election_id = e.id) AS motion_count,
         COUNT(v.id) AS voter_count,
         SUM(v.has_voted) AS voted_count,
         SUM(v.weight) AS total_weight,
         SUM(CASE WHEN v.has_voted = 1 THEN v.weight ELSE 0 END) AS voted_weight
  FROM elections e
  LEFT JOIN voters v ON v.election_id = e.id`;

const ratio = (part: number, total: number): number => (total > 0 ? Math.round((part / total) * 1000) / 10 : 0);

function toSummary(row: ElectionRow): ElectionSummary {
  const voterCount = Number(row.voter_count);
  const votedCount = Number(row.voted_count ?? 0);
  const totalWeight = Number(row.total_weight ?? 0);
  const votedWeight = Number(row.voted_weight ?? 0);
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    createdAt: row.created_at,
    closedAt: row.closed_at,
    createdBy: row.created_by,
    stats: {
      motionCount: Number(row.motion_count),
      voterCount,
      votedCount,
      pendingCount: voterCount - votedCount,
      participation: ratio(votedCount, voterCount),
      totalWeight,
      votedWeight,
      weightedParticipation: ratio(votedWeight, totalWeight),
    },
  };
}

/** Every election, newest first, with participation statistics. */
export function listElections(ctx: ServiceContext): ElectionSummary[] {
  return all<ElectionRow>(ctx.db, `${ELECTION_SUMMARY_SQL} GROUP BY e.id ORDER BY e.created_at DESC`).map(toSummary);
}

function requireElection(ctx: ServiceContext, electionId: string): ElectionSummary {
  const row = get<ElectionRow>(ctx.db, `${ELECTION_SUMMARY_SQL} WHERE e.id = ? GROUP BY e.id`, electionId);
  if (!row) throw notFound("ELECTION_NOT_FOUND", "Election not found.");
  return toSummary(row);
}

/** Election with motions, weighted results per option, integrity check and attachments. */
export function getElectionDetail(ctx: ServiceContext, electionId: string): ElectionDetail {
  const summary = requireElection(ctx, electionId);

  const motions = all<{ id: string; position: number; title: string; description: string }>(
    ctx.db, "SELECT id, position, title, description FROM motions WHERE election_id = ? ORDER BY position", electionId,
  );
  const optionRows = all<{ motion_id: string; id: number; label: string; weight: number; votes: number; legacy: number }>(
    ctx.db,
    `SELECT o.motion_id, o.id, o.label,
            COALESCE(SUM(b.weight), 0) AS weight,
            COALESCE(SUM(CASE WHEN b.source = 'vote' THEN 1 ELSE 0 END), 0) AS votes,
            COALESCE(SUM(CASE WHEN b.source = 'legacy' THEN 1 ELSE 0 END), 0) AS legacy
     FROM motion_options o
     JOIN motions m ON m.id = o.motion_id
     LEFT JOIN ballots b ON b.motion_id = o.motion_id AND b.option_id = o.id
     WHERE m.election_id = ?
     GROUP BY o.id
     ORDER BY o.motion_id, o.position`,
    electionId,
  );

  const results: MotionResult[] = motions.map((motion) => {
    const rows = optionRows.filter((row) => row.motion_id === motion.id);
    const totalWeight = rows.reduce((sum, row) => sum + Number(row.weight), 0);
    const recordedWeight = Math.round(totalWeight * 1e6) / 1e6;
    const expectedWeight = Math.round(summary.stats.votedWeight * 1e6) / 1e6;
    return {
      id: motion.id,
      position: motion.position,
      title: motion.title,
      description: motion.description,
      options: rows.map((row) => ({
        id: row.id,
        label: row.label,
        weight: Number(row.weight),
        votes: Number(row.votes),
        percentage: ratio(Number(row.weight), totalWeight),
      })),
      totalWeight,
      ballotCount: rows.reduce((sum, row) => sum + Number(row.votes), 0),
      includesLegacyTally: rows.some((row) => Number(row.legacy) > 0),
      integrity: {
        ok: Math.abs(recordedWeight - expectedWeight) < WEIGHT_EPSILON,
        expectedWeight,
        recordedWeight,
      },
    };
  });

  const attachments = all<{ id: string; original_name: string; mime_type: string; size: number }>(
    ctx.db, "SELECT id, original_name, mime_type, size FROM attachments WHERE election_id = ? ORDER BY created_at, id", electionId,
  ).map((row) => ({ id: row.id, name: row.original_name, mimeType: row.mime_type, size: Number(row.size) }));

  const invitations: Record<InvitationStatus, number> = { pending: 0, sent: 0, simulated: 0, failed: 0, legacy: 0 };
  for (const row of all<{ invitation_status: InvitationStatus; total: number }>(
    ctx.db, "SELECT invitation_status, COUNT(*) AS total FROM voters WHERE election_id = ? GROUP BY invitation_status", electionId,
  )) {
    invitations[row.invitation_status] = Number(row.total);
  }

  return { ...summary, motions: results, attachments, invitations };
}

export interface VoterListItem {
  id: number;
  email: string;
  name: string;
  gender: Gender;
  weight: number;
  hasVoted: boolean;
  votedAt: string | null;
  invitationStatus: InvitationStatus;
  invitedAt: string | null;
  tokenExpiresAt: string | null;
  isExpired: boolean;
}

export interface VoterListQuery {
  search?: string;
  status?: "voted" | "pending" | "all";
  page?: number;
  pageSize?: number;
}

/** Paginated voter list of an election (birthdates are not exposed: data minimization). */
export function listVoters(
  ctx: ServiceContext,
  electionId: string,
  query: VoterListQuery,
): { items: VoterListItem[]; total: number; page: number; pageSize: number } {
  requireElection(ctx, electionId);
  const pageSize = Math.min(Math.max(Math.trunc(query.pageSize ?? 25), 1), 100);
  const page = Math.max(Math.trunc(query.page ?? 1), 1);
  const search = (query.search ?? "").trim().toLowerCase().slice(0, 100);

  const conditions = ["election_id = ?"];
  const params: (string | number)[] = [electionId];
  if (search !== "") {
    conditions.push("(email LIKE ? ESCAPE '\\' OR lower(name) LIKE ? ESCAPE '\\')");
    const pattern = `%${search.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
    params.push(pattern, pattern);
  }
  if (query.status === "voted") conditions.push("has_voted = 1");
  if (query.status === "pending") conditions.push("has_voted = 0");
  const where = conditions.join(" AND ");

  const total = Number(get<{ total: number }>(ctx.db, `SELECT COUNT(*) AS total FROM voters WHERE ${where}`, ...params)?.total ?? 0);
  const now = Date.now();
  const items = all<{
    id: number; email: string; name: string; gender: Gender; weight: number; has_voted: number;
    voted_at: string | null; invitation_status: VoterListItem["invitationStatus"]; invited_at: string | null;
    token_expires_at: string | null;
  }>(
    ctx.db,
    `SELECT id, email, name, gender, weight, has_voted, voted_at, invitation_status, invited_at, token_expires_at
     FROM voters WHERE ${where} ORDER BY name COLLATE NOCASE, id LIMIT ? OFFSET ?`,
    ...params, pageSize, (page - 1) * pageSize,
  ).map((row) => ({
    id: Number(row.id),
    email: row.email,
    name: row.name,
    gender: row.gender,
    weight: Number(row.weight),
    hasVoted: row.has_voted === 1,
    votedAt: row.voted_at,
    invitationStatus: row.invitation_status,
    invitedAt: row.invited_at,
    tokenExpiresAt: row.token_expires_at,
    isExpired: row.token_expires_at !== null && Date.parse(row.token_expires_at) <= now,
  }));

  return { items, total, page, pageSize };
}

// ---------- Changes ----------

/**
 * Adds voters to an open election. The whole batch is refused if any email is already
 * registered in the election (existing tokens and votes are never touched).
 * @throws {AppError} 404, 409 ELECTION_CLOSED, 409 VOTERS_ALREADY_EXIST.
 */
export function addVoters(ctx: ServiceContext, electionId: string, voters: readonly VoterRow[]): Invitation[] {
  if (voters.length === 0) throw validationError("The voter list is empty.");
  return transaction(ctx.db, () => {
    const election = requireElection(ctx, electionId);
    if (election.status !== "open") throw new AppError(409, "ELECTION_CLOSED", "The election is closed.");

    const existing = new Set(
      all<{ email: string }>(ctx.db, "SELECT email FROM voters WHERE election_id = ?", electionId).map((row) => row.email),
    );
    const duplicates = voters.filter((voter) => existing.has(voter.email));
    if (duplicates.length > 0) {
      throw new AppError(
        409,
        "VOTERS_ALREADY_EXIST",
        "Some voters are already registered in this election. Nothing was imported.",
        duplicates.slice(0, 100).map((voter) => ({ code: "VOTER_ALREADY_EXISTS", message: voter.email, value: voter.email })),
      );
    }
    return insertVoters(ctx, electionId, voters);
  });
}

/**
 * Issues a new link for a voter who has not voted yet (the previous link stops working)
 * and returns the invitation to send.
 * @throws {AppError} 404 VOTER_NOT_FOUND, 409 ALREADY_VOTED / ELECTION_CLOSED.
 */
export function rotateVoterToken(ctx: ServiceContext, electionId: string, voterId: number): Invitation {
  return transaction(ctx.db, () => {
    const election = requireElection(ctx, electionId);
    const voter = get<{ id: number; email: string; name: string; gender: Gender; has_voted: number }>(
      ctx.db, "SELECT id, email, name, gender, has_voted FROM voters WHERE id = ? AND election_id = ?", voterId, electionId,
    );
    if (!voter) throw notFound("VOTER_NOT_FOUND", "Voter not found.");
    if (voter.has_voted === 1) throw new AppError(409, "ALREADY_VOTED", "This voter has already voted.");
    if (election.status !== "open") throw new AppError(409, "ELECTION_CLOSED", "The election is closed.");

    const token = generateToken();
    const expiresAt = tokenExpiry(ctx);
    run(ctx.db, "UPDATE voters SET token_hash = ?, token_expires_at = ? WHERE id = ?", hashToken(token), expiresAt, voterId);
    return { voterId: Number(voter.id), email: voter.email, name: voter.name, gender: voter.gender, token, tokenExpiresAt: expiresAt };
  });
}

/** Opens or closes an election. A closed election rejects every ballot. */
export function setElectionStatus(ctx: ServiceContext, electionId: string, status: unknown): ElectionSummary {
  if (status !== "open" && status !== "closed") {
    throw validationError("status must be 'open' or 'closed'.");
  }
  transaction(ctx.db, () => {
    requireElection(ctx, electionId);
    run(
      ctx.db,
      "UPDATE elections SET status = ?, closed_at = ? WHERE id = ?",
      status, status === "closed" ? new Date().toISOString() : null, electionId,
    );
  });
  return requireElection(ctx, electionId);
}

/** Resolves a stored attachment of an election. */
export function getAttachmentFile(
  ctx: ServiceContext,
  electionId: string,
  attachmentId: string,
): { path: string; name: string } {
  const row = get<{ original_name: string; stored_name: string }>(
    ctx.db, "SELECT original_name, stored_name FROM attachments WHERE id = ? AND election_id = ?", attachmentId, electionId,
  );
  const path = row ? resolveStoredPath(ctx.config.uploadsDir, row.stored_name) : null;
  if (!row || !path) throw notFound("ATTACHMENT_NOT_FOUND", "Attachment not found.");
  return { path, name: row.original_name };
}

/** Figures for the admin dashboard (real data only). */
export function getDashboardSummary(ctx: ServiceContext): Record<string, number> {
  const elections = get<{ total: number; open: number }>(
    ctx.db, "SELECT COUNT(*) AS total, COALESCE(SUM(status = 'open'), 0) AS open FROM elections",
  );
  const voters = get<{ total: number; voted: number }>(
    ctx.db, "SELECT COUNT(*) AS total, COALESCE(SUM(has_voted), 0) AS voted FROM voters",
  );
  const surveys = get<{ total: number }>(ctx.db, "SELECT COUNT(*) AS total FROM surveys");
  const questions = get<{ total: number; answered: number }>(
    ctx.db, "SELECT COUNT(*) AS total, COALESCE(SUM(status = 'answered'), 0) AS answered FROM survey_questions",
  );
  const voterTotal = Number(voters?.total ?? 0);
  const voterVoted = Number(voters?.voted ?? 0);
  const questionTotal = Number(questions?.total ?? 0);
  const questionAnswered = Number(questions?.answered ?? 0);
  return {
    elections: Number(elections?.total ?? 0),
    openElections: Number(elections?.open ?? 0),
    voters: voterTotal,
    votesCast: voterVoted,
    participation: ratio(voterVoted, voterTotal),
    surveys: Number(surveys?.total ?? 0),
    surveyQuestions: questionTotal,
    answeredQuestions: questionAnswered,
    surveyCompletion: ratio(questionAnswered, questionTotal),
  };
}
