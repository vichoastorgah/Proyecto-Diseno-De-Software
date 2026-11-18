/**
 * @module services/votingService
 * Voter side: opening a ballot from a unique link and casting it.
 *
 * Rules enforced on the server (never only in the UI):
 * - The link token must exist (looked up by its SHA-256 hash), not be expired, and its
 *   election must be open.
 * - One ballot per voter: the ballot covers every motion of the election and is stored
 *   atomically. `UPDATE ... WHERE has_voted = false` locks the voter row, so two concurrent
 *   requests with the same link cannot both succeed (the second one changes zero rows).
 * - The weight comes from the voter record (CSV), never from the request.
 * - Ballots are stored without any reference to the voter (secret vote).
 */
import { AppError, notFound, validationError } from "../errors.ts";
import type { Db } from "../db/database.ts";
import type { ServiceContext } from "../context.ts";
import { hashToken, isWellFormedToken } from "./tokenService.ts";
import type { AttachmentSummary } from "./electionService.ts";

interface VoterRecord {
  id: number;
  election_id: string;
  name: string;
  weight: number;
  has_voted: boolean;
  token_expires_at: string | null;
}

export interface BallotContext {
  election: { id: string; title: string; description: string; status: "open" | "closed" };
  motions: { id: string; title: string; description: string; options: string[] }[];
  attachments: AttachmentSummary[];
  voter: { name: string; hasVoted: boolean; isExpired: boolean; tokenExpiresAt: string | null };
}

const VOTER_COLUMNS = "id, election_id, name, weight, has_voted, token_expires_at";

function invalidToken(): AppError {
  return notFound("INVALID_TOKEN", "Invalid voting link.");
}

/** Legacy records imported from JSON may have no expiry: they never expire. */
function isExpired(expiresAt: string | null, now = Date.now()): boolean {
  if (expiresAt === null) return false;
  const time = Date.parse(expiresAt);
  return Number.isNaN(time) || time <= now;
}

async function findVoter(db: Db, token: unknown): Promise<VoterRecord> {
  if (!isWellFormedToken(token)) throw invalidToken();
  const voter = await db.get<VoterRecord>(`SELECT ${VOTER_COLUMNS} FROM voters WHERE token_hash = $1`, hashToken(token));
  if (!voter) throw invalidToken();
  return voter;
}

async function loadMotions(db: Db, electionId: string) {
  const motions = await db.all<{ id: string; title: string; description: string }>(
    "SELECT id, title, description FROM motions WHERE election_id = $1 ORDER BY position", electionId,
  );
  const options = await db.all<{ motion_id: string; id: number; label: string }>(
    `SELECT o.motion_id, o.id, o.label FROM motion_options o JOIN motions m ON m.id = o.motion_id
     WHERE m.election_id = $1 ORDER BY o.position`,
    electionId,
  );
  return motions.map((motion) => ({
    ...motion,
    options: options.filter((option) => option.motion_id === motion.id),
  }));
}

/**
 * Returns what the ballot page needs for a link (no other voter, no weight, no results).
 * @throws {AppError} 404 INVALID_TOKEN.
 */
export async function getBallot(ctx: ServiceContext, token: unknown): Promise<BallotContext> {
  const voter = await findVoter(ctx.db, token);
  const election = await ctx.db.get<{ id: string; title: string; description: string; status: "open" | "closed" }>(
    "SELECT id, title, description, status FROM elections WHERE id = $1", voter.election_id,
  );
  if (!election) throw invalidToken();

  const attachments = (await ctx.db.all<{ id: string; original_name: string; mime_type: string; size: number }>(
    "SELECT id, original_name, mime_type, size FROM attachments WHERE election_id = $1 ORDER BY created_at, id", election.id,
  )).map((row) => ({ id: row.id, name: row.original_name, mimeType: row.mime_type, size: Number(row.size) }));

  return {
    election,
    motions: (await loadMotions(ctx.db, election.id)).map((motion) => ({
      id: motion.id,
      title: motion.title,
      description: motion.description,
      options: motion.options.map((option) => option.label),
    })),
    attachments,
    voter: {
      name: voter.name,
      hasVoted: voter.has_voted,
      isExpired: isExpired(voter.token_expires_at),
      tokenExpiresAt: voter.token_expires_at,
    },
  };
}

/** Returns the election an attachment download is allowed for (the link's election). */
export async function getElectionIdForToken(ctx: ServiceContext, token: unknown): Promise<string> {
  return (await findVoter(ctx.db, token)).election_id;
}

/**
 * Normalizes the request body into `{ motionId: optionLabel }`.
 * Also accepts the former single-motion body `{ motionId, choice }`.
 */
export function readChoices(body: Record<string, unknown>): Record<string, string> {
  if (typeof body.choices === "object" && body.choices !== null && !Array.isArray(body.choices)) {
    const choices: Record<string, string> = {};
    for (const [motionId, choice] of Object.entries(body.choices as Record<string, unknown>)) {
      if (typeof choice !== "string") throw validationError("Every choice must be a string.");
      choices[motionId] = choice;
    }
    return choices;
  }
  if (typeof body.motionId === "string" && typeof body.choice === "string") {
    return { [body.motionId]: body.choice };
  }
  throw validationError("Missing choices.");
}

/**
 * Casts the ballot of the voter behind `token`.
 * @param choices `{ motionId: optionLabel }` for EVERY motion of the election.
 * @throws {AppError} 404 INVALID_TOKEN; 403 ALREADY_VOTED / TOKEN_EXPIRED / ELECTION_CLOSED;
 *         400 INCOMPLETE_BALLOT / INVALID_MOTION / INVALID_OPTION.
 */
export async function castBallot(ctx: ServiceContext, token: unknown, choices: Record<string, string>): Promise<void> {
  if (!isWellFormedToken(token)) throw invalidToken();
  const tokenHash = hashToken(token);

  await ctx.db.transaction(async (tx) => {
    // FOR UPDATE: a concurrent ballot with the same link waits here until this one commits.
    const voter = await tx.get<VoterRecord>(`SELECT ${VOTER_COLUMNS} FROM voters WHERE token_hash = $1 FOR UPDATE`, tokenHash);
    if (!voter) throw invalidToken();
    if (voter.has_voted) throw new AppError(403, "ALREADY_VOTED", "This link has already been used to vote.");
    if (isExpired(voter.token_expires_at)) throw new AppError(403, "TOKEN_EXPIRED", "This voting link has expired.");

    const election = await tx.get<{ status: string }>("SELECT status FROM elections WHERE id = $1", voter.election_id);
    if (!election) throw invalidToken();
    if (election.status !== "open") throw new AppError(403, "ELECTION_CLOSED", "This election is closed.");

    const motions = await loadMotions(tx, voter.election_id);
    // The former single-motion links used the election id as motion id.
    let effective = choices;
    if (motions.length === 1 && choices[voter.election_id] !== undefined && choices[motions[0].id] === undefined) {
      effective = { [motions[0].id]: choices[voter.election_id] };
    }

    const known = new Set(motions.map((motion) => motion.id));
    if (Object.keys(effective).some((motionId) => !known.has(motionId))) {
      throw new AppError(400, "INVALID_MOTION", "The ballot contains a motion of another election.");
    }
    const missing = motions.filter((motion) => effective[motion.id] === undefined);
    if (missing.length > 0) {
      throw new AppError(400, "INCOMPLETE_BALLOT", "A choice is required for every motion.", missing.map((motion) => ({
        code: "MOTION_WITHOUT_CHOICE",
        message: motion.title,
        value: motion.id,
      })));
    }

    const selections = motions.map((motion) => {
      const option = motion.options.find((candidate) => candidate.label === effective[motion.id]);
      if (!option) throw new AppError(400, "INVALID_OPTION", "Invalid option for a motion.");
      return { motionId: motion.id, optionId: Number(option.id) };
    });

    const weight = Number(voter.weight);
    if (!Number.isFinite(weight) || weight <= 0) throw new Error(`Voter #${voter.id} has an invalid weight.`);

    // Burn the link first; zero changed rows means another request already voted.
    const changed = await tx.run(
      "UPDATE voters SET has_voted = true, voted_at = $1 WHERE id = $2 AND has_voted = false",
      new Date().toISOString(), voter.id,
    );
    if (changed !== 1) throw new AppError(403, "ALREADY_VOTED", "This link has already been used to vote.");

    for (const selection of selections) {
      await tx.run(
        "INSERT INTO ballots (id, motion_id, option_id, weight, source) VALUES ($1, $2, $3, $4, 'vote')",
        crypto.randomUUID(), selection.motionId, selection.optionId, weight,
      );
    }
  });
}
