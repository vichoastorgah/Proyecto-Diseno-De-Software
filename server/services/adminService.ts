/**
 * @module services/adminService
 * Motion creation, voters CSV import, attachment storage and personalized email
 * dispatch (real SMTP, or console simulation when credentials are missing) for the
 * Admin Portal.
 *
 * Persistence layout (relative to the `server/` directory):
 *   - voters.json   -> one record per voter per motion (unique token, `hasVoted` flag, `motionId`)
 *   - motions.json  -> one record per motion (`options` and `results` follow the unified schema)
 *   - uploads/      -> stored attachments (created programmatically when missing)
 */
import { withWriteLock } from "../utils/fileLock.ts";
import { sendRealPersonalizedEmail, type DeliveryMode } from "./emailService.ts";
import { DEFAULT_TOKEN_TTL_MS } from "./voterService.ts";

const VOTERS_FILE = new URL("../voters.json", import.meta.url);
const MOTIONS_FILE = new URL("../motions.json", import.meta.url);
const VOTERS_TEMP_FILE = new URL("../voters.json.tmp", import.meta.url);
const MOTIONS_TEMP_FILE = new URL("../motions.json.tmp", import.meta.url);
const UPLOADS_DIR = new URL("../uploads/", import.meta.url);

const MAX_TITLE_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 5000;
const MAX_CSV_BYTES = 1_000_000; // 1 MB
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_VOTERS_PER_UPLOAD = 10_000;
const MAX_REPORTED_ERRORS = 50;
const MAX_WEIGHT = 1_000_000;
const REQUIRED_COLUMNS = ["email", "name", "birthdate", "gender", "weight"] as const;
const BLOCKED_ATTACHMENT_EXTENSIONS = new Set([
  ".exe",
  ".bat",
  ".cmd",
  ".com",
  ".msi",
  ".scr",
  ".sh",
  ".js",
  ".vbs",
  ".ps1",
]);
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Voting options used when the form does not provide any. */
const DEFAULT_OPTIONS: readonly string[] = ["approve", "reject"];
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 10;
const MAX_OPTION_LENGTH = 60;

// ---------- Contracts ----------

export type Gender = "male" | "female" | "other";

/** A voter row stored in `voters.json`, bound to a specific motion. */
export interface MotionVoterRecord {
  email: string;
  name: string;
  birthdate: string;
  gender: Gender;
  weight: number;
  token: string;
  /** ISO timestamp after which the token is rejected (48 hours after creation). */
  tokenExpiresAt: string;
  hasVoted: false;
  motionId: string;
}

export interface AttachmentInfo {
  originalName: string;
  storedName: string;
  mimeType: string;
  size: number;
}

/** A motion stored in `motions.json`. */
export interface MotionRecord {
  id: string;
  title: string;
  description: string;
  attachment: AttachmentInfo;
  /** Voting options (unified motions schema). */
  options: string[];
  /** Weighted tally per option; starts at zero. */
  results: Record<string, number>;
  voterCount: number;
  createdAt: string;
}

/** Result returned to the HTTP layer (tokens are never exposed). */
export interface DispatchResult {
  motionId: string;
  imported: number;
  emailsSent: number;
  /** Emails that could not be delivered. */
  emailsFailed: string[];
  /** `smtp` for real delivery, `simulated` for the console fallback. */
  deliveryMode: DeliveryMode;
}

/** Business error carrying the HTTP status the route should answer with. */
export class AdminServiceError extends Error {
  readonly status: number;
  readonly details?: string[];

  constructor(status: number, message: string, details?: string[]) {
    super(message);
    this.name = "AdminServiceError";
    this.status = status;
    this.details = details;
  }
}

interface ParsedVoter {
  email: string;
  name: string;
  birthdate: string;
  gender: Gender;
  weight: number;
}

interface ValidatedDispatchInput {
  title: string;
  description: string;
  attachmentFile: File;
  attachmentBytes: Uint8Array;
  options: string[];
  voters: ParsedVoter[];
}

// ---------- Form validation ----------

function readTextField(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value.trim() : "";
}

function readFileField(formData: FormData, name: string): File | null {
  const value = formData.get(name);
  return value instanceof File ? value : null;
}

/**
 * Parses the optional `options` field (comma or newline separated).
 * Falls back to approve/reject when the field is empty.
 *
 * @throws {AdminServiceError} 400 if there are fewer than 2 or more than 10 unique options,
 *         or an option is too long.
 */
function parseOptions(raw: string): string[] {
  if (raw === "") return [...DEFAULT_OPTIONS];

  const options = [
    ...new Set(
      raw.split(/[\n,]/).map((option) => option.trim()).filter((option) => option !== ""),
    ),
  ];
  if (options.length < MIN_OPTIONS || options.length > MAX_OPTIONS) {
    throw new AdminServiceError(
      400,
      `options must contain between ${MIN_OPTIONS} and ${MAX_OPTIONS} unique values.`,
    );
  }
  if (options.some((option) => option.length > MAX_OPTION_LENGTH)) {
    throw new AdminServiceError(400, `Each option must be at most ${MAX_OPTION_LENGTH} characters.`);
  }
  return options;
}

/** Strips any path and unsafe characters from a user-supplied file name. */
function sanitizeFileName(rawName: string): string {
  const baseName = rawName.split(/[\\/]/).pop() ?? "";
  const cleaned = baseName.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "");
  const truncated = cleaned.slice(0, 100);
  return truncated === "" ? "attachment" : truncated;
}

function getExtension(fileName: string): string {
  const dotIndex = fileName.lastIndexOf(".");
  return dotIndex === -1 ? "" : fileName.slice(dotIndex).toLowerCase();
}

// ---------- CSV parsing ----------

/**
 * Minimal RFC 4180 parser: quoted fields, escaped quotes (""), CRLF/LF,
 * BOM stripping. Fully blank lines are discarded.
 */
function parseCsvRows(text: string): string[][] {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < source.length; i++) {
    const char = source[i];

    if (inQuotes) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && source[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else {
      field += char;
    }
  }

  if (inQuotes) {
    throw new AdminServiceError(422, "CSV validation failed.", [
      "Unterminated quoted field.",
    ]);
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ""));
}

function normalizeGender(raw: string): Gender | null {
  switch (raw.trim().toLowerCase()) {
    case "m":
    case "male":
    case "masculino":
      return "male";
    case "f":
    case "female":
    case "femenino":
      return "female";
    case "o":
    case "x":
    case "other":
    case "non-binary":
    case "nonbinary":
    case "otro":
      return "other";
    default:
      return null;
  }
}

function isValidBirthdate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return false;
  if (parsed.toISOString().slice(0, 10) !== value) return false; // Rejects 2024-02-31, etc.
  return parsed.getUTCFullYear() >= 1900 && parsed.getTime() <= Date.now();
}

/**
 * Parses and validates the voters CSV (`email,name,birthdate,gender,weight`).
 *
 * @throws {AdminServiceError} 422 with per-record details when validation fails.
 */
function parseDispatchCsv(csvText: string): ParsedVoter[] {
  const rows = parseCsvRows(csvText);
  if (rows.length === 0) {
    throw new AdminServiceError(422, "CSV validation failed.", ["The CSV file is empty."]);
  }

  const header = rows[0].map((cell) => cell.trim().toLowerCase());
  const missingColumns = REQUIRED_COLUMNS.filter((column) => !header.includes(column));
  if (missingColumns.length > 0) {
    throw new AdminServiceError(422, "CSV validation failed.", [
      `Missing required column(s): ${missingColumns.join(", ")}.`,
    ]);
  }

  const dataRows = rows.slice(1);
  if (dataRows.length === 0) {
    throw new AdminServiceError(422, "CSV validation failed.", [
      "The CSV file has no voter records.",
    ]);
  }
  if (dataRows.length > MAX_VOTERS_PER_UPLOAD) {
    throw new AdminServiceError(422, "CSV validation failed.", [
      `A maximum of ${MAX_VOTERS_PER_UPLOAD} voters is allowed per upload.`,
    ]);
  }

  const columnIndex = Object.fromEntries(
    REQUIRED_COLUMNS.map((column) => [column, header.indexOf(column)]),
  ) as Record<(typeof REQUIRED_COLUMNS)[number], number>;

  const voters: ParsedVoter[] = [];
  const errors: string[] = [];
  const seenEmails = new Set<string>();

  const reportError = (record: number, message: string): void => {
    if (errors.length < MAX_REPORTED_ERRORS) errors.push(`Record ${record}: ${message}`);
  };

  dataRows.forEach((cells, index) => {
    const record = index + 1;
    const cell = (column: (typeof REQUIRED_COLUMNS)[number]): string =>
      (cells[columnIndex[column]] ?? "").trim();

    if (cells.length > header.length) {
      reportError(record, "has more fields than the header.");
      return;
    }

    const email = cell("email").toLowerCase();
    const name = cell("name");
    const birthdate = cell("birthdate");
    const gender = normalizeGender(cell("gender"));
    const weight = Number(cell("weight"));
    let valid = true;

    if (email.length > 254 || !EMAIL_PATTERN.test(email)) {
      reportError(record, "invalid email address.");
      valid = false;
    } else if (seenEmails.has(email)) {
      reportError(record, `duplicate email "${email}" in the file.`);
      valid = false;
    }
    if (name === "" || name.length > 200) {
      reportError(record, "name is required (max. 200 characters).");
      valid = false;
    }
    if (!isValidBirthdate(birthdate)) {
      reportError(record, "birthdate must be a valid past date in YYYY-MM-DD format.");
      valid = false;
    }
    if (gender === null) {
      reportError(record, "gender must be one of: male, female, other.");
      valid = false;
    }
    if (!Number.isFinite(weight) || weight <= 0 || weight > MAX_WEIGHT) {
      reportError(record, `weight must be a number greater than 0 and at most ${MAX_WEIGHT}.`);
      valid = false;
    }

    if (valid && gender !== null) {
      seenEmails.add(email);
      voters.push({ email, name, birthdate, gender, weight });
    }
  });

  if (errors.length > 0) {
    throw new AdminServiceError(422, "CSV validation failed.", errors);
  }
  return voters;
}

// ---------- Tokens ----------

/** Generates a 256-bit cryptographically secure token (64 hex characters). */
function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function generateUniqueToken(usedTokens: Set<string>): string {
  let token = generateToken();
  while (usedTokens.has(token)) token = generateToken();
  usedTokens.add(token);
  return token;
}

// ---------- Persistence ----------

async function readJsonArray(file: URL, label: string): Promise<Record<string, unknown>[]> {
  try {
    const parsed: unknown = JSON.parse(await Deno.readTextFile(file));
    if (!Array.isArray(parsed)) throw new Error(`${label} is corrupted.`);
    return parsed as Record<string, unknown>[];
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw error;
  }
}

async function removeQuietly(file: URL): Promise<void> {
  try {
    await Deno.remove(file);
  } catch {
    // Nothing to clean up.
  }
}

/**
 * Writes both JSON files using temp files + rename. If the second rename fails,
 * the first file is restored from the in-memory snapshot, so either both files
 * change or neither does.
 */
async function writeVotersAndMotions(
  previousVoters: readonly unknown[],
  nextVoters: readonly unknown[],
  nextMotions: readonly unknown[],
): Promise<void> {
  try {
    await Deno.writeTextFile(VOTERS_TEMP_FILE, JSON.stringify(nextVoters, null, 2));
    await Deno.writeTextFile(MOTIONS_TEMP_FILE, JSON.stringify(nextMotions, null, 2));

    await Deno.rename(VOTERS_TEMP_FILE, VOTERS_FILE);
    try {
      await Deno.rename(MOTIONS_TEMP_FILE, MOTIONS_FILE);
    } catch (error) {
      await Deno.writeTextFile(VOTERS_FILE, JSON.stringify(previousVoters, null, 2));
      throw error;
    }
  } finally {
    await removeQuietly(VOTERS_TEMP_FILE);
    await removeQuietly(MOTIONS_TEMP_FILE);
  }
}

/**
 * Atomically saves the motion and its voters. Tokens are generated inside the
 * write lock so they are guaranteed unique against the persisted data. Every
 * voter record is bound to the motion through `motionId`.
 */
function persistMotion(
  motion: MotionRecord,
  voters: readonly ParsedVoter[],
): Promise<MotionVoterRecord[]> {
  return withWriteLock(async () => {
    const [existingVoters, existingMotions] = await Promise.all([
      readJsonArray(VOTERS_FILE, "voters.json"),
      readJsonArray(MOTIONS_FILE, "motions.json"),
    ]);

    const usedTokens = new Set<string>();
    for (const voter of existingVoters) {
      if (typeof voter.token === "string") usedTokens.add(voter.token);
    }

    const tokenExpiresAt = new Date(Date.now() + DEFAULT_TOKEN_TTL_MS).toISOString();
    const records: MotionVoterRecord[] = voters.map((voter) => ({
      ...voter,
      token: generateUniqueToken(usedTokens),
      tokenExpiresAt,
      hasVoted: false,
      motionId: motion.id,
    }));

    await writeVotersAndMotions(
      existingVoters,
      [...existingVoters, ...records],
      [...existingMotions, motion],
    );
    return records;
  });
}

// ---------- Email dispatch ----------

/** Delivery summary returned by {@link dispatchEmails}. */
export interface DispatchSummary {
  sent: number;
  failed: string[];
  mode: DeliveryMode;
}

/**
 * Sends one personalized email per voter, sequentially, attaching the motion's document.
 * A failure for one recipient never aborts the rest. Without SMTP credentials the
 * messages are printed to the console (see `emailService.ts`).
 *
 * @param motion Motion whose title is used in the message.
 * @param voters Voters (with their tokens) to invite.
 * @param attachmentFile Stored attachment to send along.
 * @param attachmentName Original file name shown to the recipient.
 */
export async function dispatchEmails(
  motion: Pick<MotionRecord, "title">,
  voters: readonly MotionVoterRecord[],
  attachmentFile: URL,
  attachmentName: string,
): Promise<DispatchSummary> {
  const summary: DispatchSummary = { sent: 0, failed: [], mode: "simulated" };

  for (const voter of voters) {
    try {
      const result = await sendRealPersonalizedEmail(voter, voter.token, attachmentFile, {
        motionTitle: motion.title,
        attachmentName,
      });
      summary.mode = result.mode;
      summary.sent += 1;
    } catch (error) {
      console.error(`Failed to send invitation to ${voter.email}:`, error);
      summary.failed.push(voter.email);
    }
  }
  return summary;
}

// ---------- Public API ----------

/** Extracts and validates everything needed from the multipart payload. */
async function validateDispatchInput(formData: FormData): Promise<ValidatedDispatchInput> {
  const title = readTextField(formData, "title");
  const description = readTextField(formData, "description");
  const attachmentFile = readFileField(formData, "attachment");
  const csvFile = readFileField(formData, "votersCsv");

  const problems: string[] = [];
  if (title === "") problems.push("title is required.");
  if (title.length > MAX_TITLE_LENGTH) problems.push(`title exceeds ${MAX_TITLE_LENGTH} characters.`);
  if (description === "") problems.push("description is required.");
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    problems.push(`description exceeds ${MAX_DESCRIPTION_LENGTH} characters.`);
  }
  if (!attachmentFile) problems.push("attachment file is required.");
  if (!csvFile) problems.push("votersCsv file is required.");
  if (problems.length > 0 || !attachmentFile || !csvFile) {
    throw new AdminServiceError(400, "Invalid motion data.", problems);
  }

  if (attachmentFile.size === 0) {
    throw new AdminServiceError(400, "The attachment file is empty.");
  }
  if (attachmentFile.size > MAX_ATTACHMENT_BYTES) {
    throw new AdminServiceError(413, "Attachment too large.");
  }
  if (BLOCKED_ATTACHMENT_EXTENSIONS.has(getExtension(attachmentFile.name))) {
    throw new AdminServiceError(400, "This attachment file type is not allowed.");
  }
  if (!csvFile.name.toLowerCase().endsWith(".csv")) {
    throw new AdminServiceError(400, "The voters list must be a .csv file.");
  }
  if (csvFile.size === 0) {
    throw new AdminServiceError(400, "The voters CSV file is empty.");
  }
  if (csvFile.size > MAX_CSV_BYTES) {
    throw new AdminServiceError(413, "Voters CSV too large.");
  }

  const options = parseOptions(readTextField(formData, "options"));
  const voters = parseDispatchCsv(await csvFile.text());
  const attachmentBytes = new Uint8Array(await attachmentFile.arrayBuffer());

  return { title, description, attachmentFile, attachmentBytes, options, voters };
}

/**
 * Creates a motion, imports its voters, stores the attachment and dispatches
 * one personalized email per voter.
 *
 * Order of operations (fail-safe):
 *   1. Validate form fields and CSV (nothing is written on failure).
 *   2. Ensure `server/uploads/` exists and store the attachment.
 *   3. Atomically persist the motion and voters (attachment removed on failure).
 *   4. Dispatch emails only after the data is safely persisted.
 *
 * @param formData Parsed `multipart/form-data` with fields `title`, `description`,
 *                 `attachment` (file), `votersCsv` (file) and the optional `options`.
 * @throws {AdminServiceError} For any validation or business failure.
 */
export async function processAdminDispatch(formData: FormData): Promise<DispatchResult> {
  const input = await validateDispatchInput(formData);

  const motionId = crypto.randomUUID();
  const safeFileName = sanitizeFileName(input.attachmentFile.name);
  const storedName = `${motionId}-${safeFileName}`;
  const storedFile = new URL(storedName, UPLOADS_DIR);

  try {
    await Deno.mkdir(UPLOADS_DIR, { recursive: true });
    await Deno.writeFile(storedFile, input.attachmentBytes);
  } catch (error) {
    console.error("Failed to store the attachment:", error);
    throw new AdminServiceError(500, "Failed to store the attachment.");
  }

  const motion: MotionRecord = {
    id: motionId,
    title: input.title,
    description: input.description,
    attachment: {
      originalName: safeFileName,
      storedName,
      mimeType: input.attachmentFile.type || "application/octet-stream",
      size: input.attachmentFile.size,
    },
    options: input.options,
    results: Object.fromEntries(input.options.map((option) => [option, 0])),
    voterCount: input.voters.length,
    createdAt: new Date().toISOString(),
  };

  let records: MotionVoterRecord[];
  try {
    records = await persistMotion(motion, input.voters);
  } catch (error) {
    await removeQuietly(storedFile);
    console.error("Failed to persist motion and voters:", error);
    throw new AdminServiceError(500, "Failed to save the motion and voters.");
  }

  const delivery = await dispatchEmails(motion, records, storedFile, safeFileName);

  return {
    motionId,
    imported: records.length,
    emailsSent: delivery.sent,
    emailsFailed: delivery.failed,
    deliveryMode: delivery.mode,
  };
}