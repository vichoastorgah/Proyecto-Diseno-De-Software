/**
 * @module voterService
 * Voter CSV parsing, token generation and `voters.json` persistence.
 * Parsing and token logic are pure functions. All writes to `voters.json` are serialized
 * through the shared `withWriteLock` queue. Email delivery lives in `emailService.ts`
 * and the HTTP layer lives in `server.ts`.
 */
import { withWriteLock } from "../utils/fileLock.ts";

/** Exact CSV columns required by the upload contract. */
export const EXPECTED_COLUMNS = [
  "email",
  "name",
  "birthdate",
  "gender",
  "weight",
] as const;

/** Maximum number of voter rows accepted in a single upload. */
export const MAX_CSV_ROWS = 10_000;

/** Default token lifetime (48 hours). */
export const DEFAULT_TOKEN_TTL_MS = 48 * 60 * 60 * 1000;

const MAX_EMAIL_LENGTH = 254;
const MAX_NAME_LENGTH = 120;
const MAX_GENDER_LENGTH = 32;
const EMAIL_PATTERN = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
// deno-lint-ignore no-control-regex
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g;

/** A validated row of the voters CSV. */
export interface VoterCsvRow {
  /** Lower-cased, unique within an upload. */
  email: string;
  name: string;
  /** ISO date (YYYY-MM-DD). */
  birthdate: string;
  /** Lower-cased free text (e.g. "male", "female"). */
  gender: string;
  /** Positive vote weight used for server-side weighting. */
  weight: number;
}

/** A validation problem found while parsing the CSV. */
export interface CsvRowError {
  /** 1-based record number (the header is record 1). 0 means file-level. */
  record: number;
  message: string;
}

/** Result of parsing a voters CSV. `rows` is only trustworthy if `errors` is empty. */
export interface CsvParseResult {
  rows: VoterCsvRow[];
  errors: CsvRowError[];
}

/** Persisted voter entry, including the single-use token. */
export interface VoterRecord extends VoterCsvRow {
  /** Cryptographically secure, single-use voting token. */
  token: string;
  /** ISO timestamp after which the token must be rejected. */
  tokenExpiresAt: string;
  hasVoted: boolean;
  /** Motion this token is bound to; it is rejected for any other motion. */
  motionId: string;
}

/** Thrown internally when the CSV text is structurally malformed. */
class CsvFormatError extends Error {}

/**
 * Splits CSV text into records (RFC 4180 subset: quoted fields, escaped
 * quotes, CRLF/LF line endings, newlines inside quotes). Blank lines are skipped.
 * Time complexity: O(n) in the input length.
 *
 * @throws {CsvFormatError} If a quoted field is never closed.
 */
function parseCsvRecords(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let inQuotes = false;

  const pushRecord = (): void => {
    record.push(field);
    // Skip blank lines (a single empty field).
    if (!(record.length === 1 && record[0] === "")) records.push(record);
    record = [];
    field = "";
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"' && field === "") {
      inQuotes = true;
    } else if (ch === ",") {
      record.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      pushRecord();
    } else {
      field += ch;
    }
  }

  if (inQuotes) throw new CsvFormatError("Unterminated quoted field.");
  if (field !== "" || record.length > 0) pushRecord();
  return records;
}

/** Returns true if `value` is a real calendar date (YYYY-MM-DD) that is not in the future. */
function isValidPastDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) &&
    date.toISOString().slice(0, 10) === value &&
    date.getTime() <= Date.now();
}

/**
 * Parses and validates a voters CSV string.
 * Header must contain exactly `email, name, birthdate, gender, weight` (any order).
 * Never throws on bad input: every problem is reported in `errors`.
 *
 * @param csv Raw CSV text.
 * @returns Validated rows plus every validation error found.
 */
export function parseVotersCsv(csv: string): CsvParseResult {
  const rows: VoterCsvRow[] = [];
  const errors: CsvRowError[] = [];

  let records: string[][];
  try {
    // Strip UTF-8 BOM (common in Excel exports).
    records = parseCsvRecords(csv.replace(/^\uFEFF/, ""));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Malformed CSV.";
    return { rows, errors: [{ record: 0, message }] };
  }

  if (records.length === 0) {
    return { rows, errors: [{ record: 0, message: "CSV is empty." }] };
  }

  // Header validation: exact column set, no extras, no duplicates.
  const header = records[0].map((h) => h.trim().toLowerCase());
  const columnIndex = new Map<string, number>();
  header.forEach((name, index) => columnIndex.set(name, index));
  const headerValid = header.length === EXPECTED_COLUMNS.length &&
    columnIndex.size === EXPECTED_COLUMNS.length &&
    EXPECTED_COLUMNS.every((column) => columnIndex.has(column));
  if (!headerValid) {
    return {
      rows,
      errors: [{
        record: 1,
        message: `Invalid header. Expected exactly: ${EXPECTED_COLUMNS.join(", ")}.`,
      }],
    };
  }

  if (records.length - 1 > MAX_CSV_ROWS) {
    return {
      rows,
      errors: [{
        record: 0,
        message: `Too many rows. Maximum allowed is ${MAX_CSV_ROWS}.`,
      }],
    };
  }

  const seenEmails = new Set<string>();

  for (let r = 1; r < records.length; r++) {
    const recordNumber = r + 1;
    const cells = records[r];
    const rowErrorsBefore = errors.length;
    const fail = (message: string): void => {
      errors.push({ record: recordNumber, message });
    };

    if (cells.length !== EXPECTED_COLUMNS.length) {
      fail(`Expected ${EXPECTED_COLUMNS.length} columns but found ${cells.length}.`);
      continue;
    }

    const get = (column: typeof EXPECTED_COLUMNS[number]): string =>
      (cells[columnIndex.get(column) as number] ?? "").replace(CONTROL_CHARS, "").trim();

    const email = get("email").toLowerCase();
    const name = get("name");
    const birthdate = get("birthdate");
    const gender = get("gender").toLowerCase();
    const weightRaw = get("weight");
    const weight = Number(weightRaw);

    if (!EMAIL_PATTERN.test(email) || email.length > MAX_EMAIL_LENGTH) {
      fail("Invalid email address.");
    } else if (seenEmails.has(email)) {
      fail(`Duplicate email in file: ${email}.`);
    }
    if (name === "" || name.length > MAX_NAME_LENGTH) {
      fail(`Name is required and must be at most ${MAX_NAME_LENGTH} characters.`);
    }
    if (!isValidPastDate(birthdate)) {
      fail("Invalid birthdate. Use a real past date in YYYY-MM-DD format.");
    }
    if (gender === "" || gender.length > MAX_GENDER_LENGTH) {
      fail(`Gender is required and must be at most ${MAX_GENDER_LENGTH} characters.`);
    }
    if (weightRaw === "" || !Number.isFinite(weight) || weight <= 0) {
      fail("Weight must be a positive number.");
    }

    if (errors.length === rowErrorsBefore) {
      seenEmails.add(email);
      rows.push({ email, name, birthdate, gender, weight });
    }
  }

  return { rows, errors };
}

/**
 * Generates a cryptographically secure, single-use voting token
 * using the native Web Crypto API (UUID v4, 122 random bits).
 */
export function generateVoteToken(): string {
  return crypto.randomUUID();
}

// ---------- Persistence (every write is serialized through `withWriteLock`) ----------

const VOTERS_FILE = new URL("../voters.json", import.meta.url);
const VOTERS_TEMP_FILE = new URL("../voters.json.tmp", import.meta.url);

/** Reads all stored voters; returns an empty list if the file does not exist yet. */
export async function readVoters(): Promise<VoterRecord[]> {
  try {
    const parsed: unknown = JSON.parse(await Deno.readTextFile(VOTERS_FILE));
    if (!Array.isArray(parsed)) throw new Error("voters.json is corrupted.");
    return parsed as VoterRecord[];
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw error;
  }
}

/** Atomically writes voters (temp file + rename). Call it only while holding the lock. */
async function writeVoters(voters: readonly VoterRecord[]): Promise<void> {
  await Deno.writeTextFile(VOTERS_TEMP_FILE, JSON.stringify(voters, null, 2));
  await Deno.rename(VOTERS_TEMP_FILE, VOTERS_FILE);
}

/**
 * Appends new voters, refusing the whole batch if any email already exists for the same
 * motion (protects existing tokens and `hasVoted` state). The same email may legitimately
 * appear in different motions: each motion issues its own token.
 *
 * @returns Conflicting emails, or an empty array if the batch was saved.
 */
export function appendVoters(newVoters: readonly VoterRecord[]): Promise<string[]> {
  return withWriteLock(async () => {
    const existing = await readVoters();
    const taken = new Set(existing.map((voter) => `${voter.motionId}|${voter.email}`));
    const conflicts = newVoters
      .filter((voter) => taken.has(`${voter.motionId}|${voter.email}`))
      .map((voter) => voter.email);
    if (conflicts.length > 0) return conflicts;
    await writeVoters([...existing, ...newVoters]);
    return [];
  });
}

/**
 * Turns validated CSV rows into voter records with a fresh token each.
 *
 * @param rows Validated rows from {@link parseVotersCsv}.
 * @param motionId Motion the tokens are bound to.
 * @param ttlMs Token lifetime in milliseconds (default 48 hours).
 * @param now Injectable clock (keeps the function testable).
 */
export function buildVoterRecords(
  rows: readonly VoterCsvRow[],
  motionId: string,
  ttlMs: number = DEFAULT_TOKEN_TTL_MS,
  now: Date = new Date(),
): VoterRecord[] {
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
  return rows.map((row) => ({
    ...row,
    token: generateVoteToken(),
    tokenExpiresAt: expiresAt,
    hasVoted: false,
    motionId,
  }));
}