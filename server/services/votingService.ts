/**
 * @module services/votingService
 * Voter side: opening a ballot from a unique link and casting it.
 *
 * Rules enforced on the server (never only in the UI):
 * - The link token must exist (looked up by its SHA-256 hash), not be expired, and its
 *   election must be open.
 * - One ballot per voter: the ballot covers every motion of the election and is stored
 *   atomically. `UPDATE ... WHERE has_voted = 0` guarantees that two concurrent requests
 *   with the same link cannot both succeed.
 * - The weight comes from the voter record (CSV), never from the request.
 * - Ballots are stored without any reference to the voter (secret vote).
 */
import { AppError, notFound, validationError } from "../errors.ts";
import { all, get, run, transaction } from "../db/database.ts";
import type { ServiceContext } from "../context.ts";
import { hashToken, isWellFormedToken } from "./tokenService.ts";
import type { AttachmentSummary } from "./electionService.ts";

interface VoterRecord {
  id: number;
  election_id: string;
  name: string;
  weight: number;
  has_voted: number;
  token_expires_at: string | null;
}

export interface BallotContext {
  election: { id: string; title: string; description: string; status: "open" | "closed" };
  motions: { id: string; title: string; description: string; options: string[] }[];
  attachments: AttachmentSummary[];
  voter: { name: string; hasVoted: boolean; isExpired: boolean; tokenExpiresAt: string | null };
}

function invalidToken(): AppError {
  return notFound("INVALID_TOKEN", "Invalid voting link.");
}

/** Legacy records imported from JSON may have no expiry: they never expire. */
function isExpired(expiresAt: string | null, now = Date.now()): boolean {
  if (expiresAt === null) return false;
  const time = Date.parse(expiresAt);
  return Number.isNaN(time) || time <= now;
}

function findVoter(ctx: ServiceContext, token: unknown): VoterRecord {
  if (!isWellFormedToken(token)) throw invalidToken();
  const voter = get<VoterRecord>(
    ctx.db,
    "SELECT id, election_id, name, weight, has_voted, token_expires_at FROM voters WHERE token_hash = ?",
    hashToken(token),
  );
  if (!voter) throw invalidToken();
  return voter;
}

function loadMotions(ctx: ServiceContext, electionId: string) {
  const motions = all<{ id: string; title: string; description: string }>(
    ctx.db, "SELECT id, title, description FROM motions WHERE election_id = ? ORDER BY position", electionId,
  );
  const options = all<{ motion_id: string; id: number; label: string }>(
    ctx.db,
    `SELECT o.motion_id, o.id, o.label FROM motion_options o JOIN motions m ON m.id = o.motion_id
     WHERE m.election_id = ? ORDER BY o.position`,
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
export function getBallot(ctx: ServiceContext, token: unknown): BallotContext {
  const voter = findVoter(ctx, token);
  const election = get<{ id: string; title: string; description: string; status: "open" | "closed" }>(
    ctx.db, "SELECT id, title, description, status FROM elections WHERE id = ?", voter.election_id,
  );
  if (!election) throw invalidToken();

  const attachments = all<{ id: string; original_name: string; mime_type: string; size: number }>(
    ctx.db, "SELECT id, original_name, mime_type, size FROM attachments WHERE election_id = ? ORDER BY created_at, id", election.id,
  ).map((row) => ({ id: row.id, name: row.original_name, mimeType: row.mime_type, size: Number(row.size) }));

  return {
    election,
    motions: loadMotions(ctx, election.id).map((motion) => ({
      id: motion.id,
      title: motion.title,
      description: motion.description,
      options: motion.options.map((option) => option.label),
    })),
    attachments,
    voter: {
      name: voter.name,
      hasVoted: voter.has_voted === 1,
      isExpired: isExpired(voter.token_expires_at),
      tokenExpiresAt: voter.token_expires_at,
    },
  };
}

/** Returns the election an attachment download is allowed for (the link's election). */
export function getElectionIdForToken(ctx: ServiceContext, token: unknown): string {
  return findVoter(ctx, token).election_id;
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
export function castBallot(ctx: ServiceContext, token: unknown, choices: Record<string, string>): void {
  const tokenHash = isWellFormedToken(token) ? hashToken(token) : null;
  if (tokenHash === null) throw invalidToken();

  transaction(ctx.db, () => {
    // Re-read inside the transaction: the state cannot change until COMMIT.
    const voter = get<VoterRecord>(
      ctx.db,
      "SELECT id, election_id, name, weight, has_voted, token_expires_at FROM voters WHERE token_hash = ?",
      tokenHash,
    );
    if (!voter) throw invalidToken();
    if (voter.has_voted === 1) throw new AppError(403, "ALREADY_VOTED", "This link has already been used to vote.");
    if (isExpired(voter.token_expires_at)) throw new AppError(403, "TOKEN_EXPIRED", "This voting link has expired.");

    const election = get<{ status: string }>(ctx.db, "SELECT status FROM elections WHERE id = ?", voter.election_id);
    if (!election) throw invalidToken();
    if (election.status !== "open") throw new AppError(403, "ELECTION_CLOSED", "This election is closed.");

    const motions = loadMotions(ctx, voter.election_id);
    // The former single-motion links used the election id as motion id.
    if (motions.length === 1 && choices[voter.election_id] !== undefined && choices[motions[0].id] === undefined) {
      choices = { [motions[0].id]: choices[voter.election_id] };
    }

    const known = new Set(motions.map((motion) => motion.id));
    if (Object.keys(choices).some((motionId) => !known.has(motionId))) {
      throw new AppError(400, "INVALID_MOTION", "The ballot contains a motion of another election.");
    }
    const missing = motions.filter((motion) => choices[motion.id] === undefined);
    if (missing.length > 0) {
      throw new AppError(400, "INCOMPLETE_BALLOT", "A choice is required for every motion.", missing.map((motion) => ({
        code: "MOTION_WITHOUT_CHOICE",
        message: motion.title,
        value: motion.id,
      })));
    }

    const selections = motions.map((motion) => {
      const option = motion.options.find((candidate) => candidate.label === choices[motion.id]);
      if (!option) throw new AppError(400, "INVALID_OPTION", "Invalid option for a motion.");
      return { motionId: motion.id, optionId: option.id };
    });

    const weight = Number(voter.weight);
    if (!Number.isFinite(weight) || weight <= 0) throw new Error(`Voter #${voter.id} has an invalid weight.`);

    // Burn the link first; zero changed rows means a concurrent request already voted.
    const changed = run(
      ctx.db,
      "UPDATE voters SET has_voted = 1, voted_at = ? WHERE id = ? AND has_voted = 0",
      new Date().toISOString(), voter.id,
    );
    if (changed !== 1) throw new AppError(403, "ALREADY_VOTED", "This link has already been used to vote.");

    const insert = ctx.db.prepare(
      "INSERT INTO ballots (id, motion_id, option_id, weight, source) VALUES (?, ?, ?, ?, 'vote')",
    );
    for (const selection of selections) {
      insert.run(crypto.randomUUID(), selection.motionId, selection.optionId, weight);
    }
  });
}
