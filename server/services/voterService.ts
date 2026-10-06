/**
 * @module voterService
 * Pure, side-effect-free voter logic (except the mock email logger).
 * No HTTP and no file-system access here: the HTTP layer lives in `server.ts`.
 */

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

/** Default token lifetime (7 days). */
export const DEFAULT_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

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

/**
 * Turns validated CSV rows into voter records with a fresh token each.
 *
 * @param rows Validated rows from {@link parseVotersCsv}.
 * @param ttlMs Token lifetime in milliseconds.
 * @param now Injectable clock (keeps the function testable).
 */
export function buildVoterRecords(
  rows: readonly VoterCsvRow[],
  ttlMs: number = DEFAULT_TOKEN_TTL_MS,
  now: Date = new Date(),
): VoterRecord[] {
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
  return rows.map((row) => ({
    ...row,
    token: generateVoteToken(),
    tokenExpiresAt: expiresAt,
    hasVoted: false,
  }));
}

/** Builds the personalized salutation from the voter's gender and name. */
function buildGreeting(voter: VoterCsvRow): string {
  switch (voter.gender) {
    case "male":
    case "m":
      return `Dear Mr. ${voter.name}`;
    case "female":
    case "f":
      return `Dear Ms. ${voter.name}`;
    default:
      return `Dear ${voter.name}`;
  }
}

/**
 * MOCK: simulates sending a personalized email by logging it to the console.
 * Replace the body with a real SMTP/API provider later; the signature stays.
 *
 * @param voter Recipient.
 * @param token Single-use token embedded in the voting link.
 */
export function sendPersonalizedEmail(voter: VoterCsvRow, token: string): void {
  const baseUrl = Deno.env.get("VOTE_BASE_URL") ?? "http://localhost:5173/vote";
  const link = `${baseUrl}?token=${encodeURIComponent(token)}`;
  console.log(
    [
      "---------- [MOCK EMAIL] ----------",
      `To: ${voter.email}`,
      "Subject: Your personal voting link",
      "",
      `${buildGreeting(voter)},`,
      "",
      "You have been invited to vote. Use your personal, single-use link:",
      link,
      "----------------------------------",
    ].join("\n"),
  );
}