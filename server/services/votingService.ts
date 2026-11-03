/**
 * @module services/votingService
 * Voting engine: token validation, single-vote enforcement and server-side weighting.
 *
 * Unified `motions.json` schema (an array):
 * `[{ id, title, description, options: string[], results: Record<string, number> }]`
 * Extra fields written by the admin dispatch (`attachment`, `voterCount`, `createdAt`)
 * are preserved. Legacy files are migrated transparently: a `{ "motions": [...] }`
 * wrapper is unwrapped, a missing `options` defaults to `approve`/`reject` and a
 * missing `results` starts at zero. The file is rewritten in the unified shape on the
 * next vote.
 */
import { withWriteLock } from "../utils/fileLock.ts";

const VOTERS_FILE = new URL("../voters.json", import.meta.url);
const MOTIONS_FILE = new URL("../motions.json", import.meta.url);
const VOTERS_TEMP_FILE = new URL("../voters.json.tmp", import.meta.url);
const MOTIONS_TEMP_FILE = new URL("../motions.json.tmp", import.meta.url);

/** Options used when a motion does not define its own. */
export const DEFAULT_MOTION_OPTIONS: readonly string[] = ["approve", "reject"];

/** Stable machine-readable reasons, mapped to translations by the frontend. */
export type VotingErrorCode =
  | "INVALID_TOKEN"
  | "TOKEN_EXPIRED"
  | "ALREADY_VOTED"
  | "MOTION_NOT_FOUND"
  | "INVALID_OPTION";

/** Error carrying the HTTP status the HTTP layer should answer with. */
export class VotingServiceError extends Error {
  readonly status: number;
  readonly code: VotingErrorCode;

  constructor(status: number, code: VotingErrorCode, message: string) {
    super(message);
    this.name = "VotingServiceError";
    this.status = status;
    this.code = code;
  }
}

/** File stored for a motion by the admin dispatch. */
export interface MotionAttachment {
  originalName: string;
  storedName: string;
  mimeType: string;
  size: number;
}

/** A motion as stored in `motions.json`. */
export interface Motion {
  id: string;
  title: string;
  description: string;
  options: string[];
  results: Record<string, number>;
  attachment?: MotionAttachment;
  voterCount?: number;
  createdAt?: string;
}

/** A voter as stored in `voters.json` (only the fields this service relies on). */
interface StoredVoter {
  email: string;
  name: string;
  weight: number;
  token: string;
  hasVoted: boolean;
  motionId?: string;
  tokenExpiresAt?: string;
  [extra: string]: unknown;
}

/** Data the voting page needs, without leaking other voters or weights. */
export interface VotingContext {
  motion: {
    id: string;
    title: string;
    description: string;
    options: string[];
  };
  voter: {
    name: string;
    hasVoted: boolean;
    isExpired: boolean;
    tokenExpiresAt: string | null;
  };
}

// ---------- Persistence helpers (never call withWriteLock from here) ----------

/** Coerces any stored motion into the unified schema; returns null if it has no id. */
function normalizeMotion(raw: unknown): Motion | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;

  const id = record.id;
  if (typeof id !== "string" || id === "") return null;

  const declaredOptions = Array.isArray(record.options)
    ? record.options
      .filter((option): option is string => typeof option === "string")
      .map((option) => option.trim())
      .filter((option) => option !== "")
    : [];
  const options = [...new Set(declaredOptions.length > 0 ? declaredOptions : DEFAULT_MOTION_OPTIONS)];

  const rawResults = typeof record.results === "object" && record.results !== null &&
      !Array.isArray(record.results)
    ? record.results as Record<string, unknown>
    : {};
  const results: Record<string, number> = {};
  for (const [key, value] of Object.entries(rawResults)) {
    const amount = Number(value);
    if (Number.isFinite(amount) && amount >= 0) results[key] = amount;
  }
  for (const option of options) results[option] ??= 0;

  return {
    ...record,
    id,
    title: typeof record.title === "string" ? record.title : "",
    description: typeof record.description === "string" ? record.description : "",
    options,
    results,
  } as Motion;
}

/**
 * Reads and normalizes every motion.
 * Accepts the unified array and the legacy `{ motions: [] }` wrapper.
 *
 * @returns The motions, or an empty list if the file does not exist yet.
 */
export async function readMotions(): Promise<Motion[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await Deno.readTextFile(MOTIONS_FILE));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw error;
  }

  const list: unknown = Array.isArray(parsed)
    ? parsed
    : (parsed as { motions?: unknown } | null)?.motions;
  if (!Array.isArray(list)) throw new Error("motions.json is corrupted.");

  return list.map(normalizeMotion).filter((motion): motion is Motion => motion !== null);
}

/** Finds one motion by id, or `undefined`. */
export async function getMotionById(motionId: string): Promise<Motion | undefined> {
  return (await readMotions()).find((motion) => motion.id === motionId);
}

/** Reads the voters file, also returning the raw text so a failed vote can be rolled back. */
async function readVotersFile(): Promise<{ voters: StoredVoter[]; raw: string }> {
  let raw: string;
  try {
    raw = await Deno.readTextFile(VOTERS_FILE);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return { voters: [], raw: "[]" };
    throw error;
  }
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("voters.json is corrupted.");
  return { voters: parsed as StoredVoter[], raw };
}

/** Writes JSON through a temp file + rename so a crash never leaves partial JSON. */
async function writeJsonAtomic(file: URL, tempFile: URL, data: unknown): Promise<void> {
  await Deno.writeTextFile(tempFile, JSON.stringify(data, null, 2));
  await Deno.rename(tempFile, file);
}

/**
 * Tells whether a voter's token has expired.
 * Legacy records without `tokenExpiresAt` never expire; an unparsable date fails closed.
 */
function isTokenExpired(voter: StoredVoter, now: Date): boolean {
  if (typeof voter.tokenExpiresAt !== "string") return false;
  const expiresAt = Date.parse(voter.tokenExpiresAt);
  return Number.isNaN(expiresAt) || expiresAt <= now.getTime();
}

/** Builds the generic "invalid token" error (also used for tokens of another motion). */
function invalidToken(): VotingServiceError {
  return new VotingServiceError(404, "INVALID_TOKEN", "Invalid voting token.");
}

// ---------- Public API ----------

/**
 * Returns the motion and voter status behind a voting link (read-only, no lock needed:
 * writers replace files atomically, so a reader always sees a complete file).
 *
 * @param token Single-use token from the email link.
 * @throws {VotingServiceError} 404 INVALID_TOKEN or MOTION_NOT_FOUND.
 */
export async function getVotingContext(token: string): Promise<VotingContext> {
  if (typeof token !== "string" || token === "") throw invalidToken();

  const { voters } = await readVotersFile();
  const voter = voters.find((candidate) => candidate.token === token);
  if (!voter || typeof voter.motionId !== "string") throw invalidToken();

  const motion = await getMotionById(voter.motionId);
  if (!motion) {
    throw new VotingServiceError(404, "MOTION_NOT_FOUND", "Motion not found.");
  }

  return {
    motion: {
      id: motion.id,
      title: motion.title,
      description: motion.description,
      options: motion.options,
    },
    voter: {
      name: voter.name,
      hasVoted: voter.hasVoted === true,
      isExpired: isTokenExpired(voter, new Date()),
      tokenExpiresAt: typeof voter.tokenExpiresAt === "string" ? voter.tokenExpiresAt : null,
    },
  };
}

/**
 * Registers one weighted vote.
 *
 * Order of checks: token exists and belongs to `motionId` -> not already used ->
 * not expired -> motion exists -> `choice` is one of the motion's options.
 * The voter's `weight` is added to the chosen option on the server; the client
 * never sends a weight.
 *
 * @throws {VotingServiceError} 404 INVALID_TOKEN / MOTION_NOT_FOUND, 403 ALREADY_VOTED /
 *         TOKEN_EXPIRED, 400 INVALID_OPTION.
 */
export function processVote(token: string, motionId: string, choice: string): Promise<void> {
  return withWriteLock(async () => {
    if (typeof token !== "string" || token === "") throw invalidToken();

    // 1. Load voters and locate the token.
    const { voters, raw: votersRaw } = await readVotersFile();
    const voterIndex = voters.findIndex((candidate) => candidate.token === token);
    if (voterIndex === -1) throw invalidToken();

    // 2. A token issued for one motion must never be accepted for another one.
    const voter = voters[voterIndex];
    if (voter.motionId !== motionId) throw invalidToken();

    // 3. Block double voting and expired links.
    if (voter.hasVoted) {
      throw new VotingServiceError(403, "ALREADY_VOTED", "Voter has already cast a vote.");
    }
    if (isTokenExpired(voter, new Date())) {
      throw new VotingServiceError(403, "TOKEN_EXPIRED", "Voting token has expired.");
    }

    // 4. Load the motion and validate the chosen option.
    const motions = await readMotions();
    const motion = motions.find((candidate) => candidate.id === motionId);
    if (!motion) {
      throw new VotingServiceError(404, "MOTION_NOT_FOUND", "Motion not found.");
    }
    if (!motion.options.includes(choice)) {
      throw new VotingServiceError(400, "INVALID_OPTION", "Invalid voting option.");
    }

    // 5. Weight and count the vote (weight comes from the voters CSV).
    const weight = Number(voter.weight);
    if (!Number.isFinite(weight) || weight <= 0) {
      throw new Error(`Voter ${voter.email} has an invalid weight.`);
    }
    motion.results[choice] = (motion.results[choice] ?? 0) + weight;

    // 6. Burn the token first, then store the tally. If the tally cannot be saved,
    //    restore the voters file so the voter is not locked out without a counted vote.
    voter.hasVoted = true;
    await writeJsonAtomic(VOTERS_FILE, VOTERS_TEMP_FILE, voters);
    try {
      await writeJsonAtomic(MOTIONS_FILE, MOTIONS_TEMP_FILE, motions);
    } catch (error) {
      await Deno.writeTextFile(VOTERS_FILE, votersRaw);
      throw error;
    }
  });
}