/**
 * @module server
 * Oak HTTP layer. Business logic lives in `services/voterService.ts`,
 * `services/votingService.ts`, `services/surveyService.ts` and
 * `services/adminService.ts`.
 *
 * Run: deno run --allow-net --allow-read --allow-write --allow-env server/server.ts
 */
import { Application, type Context, Router } from "jsr:@oak/oak@^17";
import {
  buildVoterRecords,
  parseVotersCsv,
  sendPersonalizedEmail,
  type VoterRecord,
} from "./services/voterService.ts";
import { processVote } from "./services/votingService.ts"; // Voting engine
import {
  answerQuestion,
  delegateResponsibility,
  SurveyServiceError,
} from "./services/surveyService.ts"; // Massive survey engine
import {
  AdminServiceError,
  assertTokenMatchesMotion,
  processAdminDispatch,
  withWriteLock,
} from "./services/adminService.ts"; // Motion creation + email dispatch

const PORT = Number(Deno.env.get("PORT") ?? 8000);
const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") ?? "http://localhost:5173";
const MAX_BODY_BYTES = 1_000_000; // 1 MB
const MAX_DISPATCH_BYTES = 12 * 1024 * 1024; // 10 MB attachment + 1 MB CSV + multipart overhead
const VOTERS_FILE = new URL("./voters.json", import.meta.url);

/** Standard JSON error payload. */
interface ErrorResponse {
  error: string;
  details?: string[];
}

/** Successful upload payload (tokens are never returned to the client). */
interface UploadResponse {
  imported: number;
  emails: string[];
}

/** Sets an error status and JSON body on the response. */
function sendError(ctx: Context, status: number, error: string, details?: string[]): void {
  const body: ErrorResponse = details ? { error, details } : { error };
  ctx.response.status = status;
  ctx.response.body = body;
}

/**
 * Maps a survey service failure to an HTTP error response.
 * Known business errors keep their status; anything else becomes a generic 500.
 */
function sendSurveyError(ctx: Context, error: unknown, fallbackMessage: string): void {
  if (error instanceof SurveyServiceError) {
    return sendError(ctx, error.status, error.message);
  }
  console.error(fallbackMessage, error);
  sendError(ctx, 500, fallbackMessage);
}

/** Reads a JSON object from the request body; returns null if it is missing or malformed. */
async function readJsonObject(ctx: Context): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await ctx.request.body.json();
    if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
    return body as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ---------- Persistence (serialized to avoid concurrent write races) ----------
// The write lock (`withWriteLock`) is shared with `adminService.ts` so that every
// writer of `voters.json` is serialized through the same queue.

/** Reads all stored voters; returns an empty list if the file does not exist yet. */
async function readVoters(): Promise<VoterRecord[]> {
  try {
    const parsed: unknown = JSON.parse(await Deno.readTextFile(VOTERS_FILE));
    if (!Array.isArray(parsed)) throw new Error("voters.json is corrupted.");
    return parsed as VoterRecord[];
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw error;
  }
}

/** Atomically writes voters (temp file + rename) so a crash never leaves partial JSON. */
async function writeVoters(voters: readonly VoterRecord[]): Promise<void> {
  const tempFile = new URL("./voters.json.tmp", import.meta.url);
  await Deno.writeTextFile(tempFile, JSON.stringify(voters, null, 2));
  await Deno.rename(tempFile, VOTERS_FILE);
}

/**
 * Appends new voters, refusing the whole batch if any email already exists
 * (protects existing tokens and `hasVoted` state).
 *
 * @returns Conflicting emails, or an empty array if the batch was saved.
 */
function appendVoters(newVoters: readonly VoterRecord[]): Promise<string[]> {
  return withWriteLock(async () => {
    const existing = await readVoters();
    const existingEmails = new Set(existing.map((v) => v.email));
    const conflicts = newVoters.filter((v) => existingEmails.has(v.email)).map((v) => v.email);
    if (conflicts.length > 0) return conflicts;
    await writeVoters([...existing, ...newVoters]);
    return [];
  });
}

// ---------- Routes ----------

const router = new Router();

/**
 * POST /api/admin/voters/upload
 * Body: raw CSV text with header `email,name,birthdate,gender,weight`.
 * 201 -> imported; 400 -> bad request; 413 -> too large; 409 -> duplicates; 422 -> invalid CSV.
 * TODO: protect with SSO/admin middleware.
 */
router.post("/api/admin/voters/upload", async (ctx) => {
  const declaredLength = Number(ctx.request.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_BODY_BYTES) {
    return sendError(ctx, 413, "Payload too large.");
  }

  let csv: string;
  try {
    csv = await ctx.request.body.text();
  } catch {
    return sendError(ctx, 400, "Unable to read request body.");
  }
  if (csv.length > MAX_BODY_BYTES) return sendError(ctx, 413, "Payload too large.");
  if (csv.trim() === "") return sendError(ctx, 400, "Request body is empty.");

  const { rows, errors } = parseVotersCsv(csv);
  if (errors.length > 0) {
    return sendError(
      ctx,
      422,
      "CSV validation failed.",
      errors.slice(0, 50).map((e) => (e.record > 0 ? `Record ${e.record}: ${e.message}` : e.message)),
    );
  }

  const voters = buildVoterRecords(rows);

  let conflicts: string[];
  try {
    conflicts = await appendVoters(voters);
  } catch (error) {
    console.error("Failed to persist voters:", error);
    return sendError(ctx, 500, "Failed to save voters.");
  }
  if (conflicts.length > 0) {
    return sendError(ctx, 409, "Some voters already exist. Nothing was imported.", conflicts);
  }

  // Emails are sent only after the data is safely persisted.
  for (const voter of voters) sendPersonalizedEmail(voter, voter.token);

  const body: UploadResponse = { imported: voters.length, emails: voters.map((v) => v.email) };
  ctx.response.status = 201;
  ctx.response.body = body;
});

/**
 * POST /api/admin/dispatch
 * Body: multipart/form-data with fields
 *   `title` (text), `description` (text), `attachment` (file), `votersCsv` (file, .csv).
 * Creates the motion, imports the voters (unique token each, bound to the new `motionId`),
 * stores the attachment in `server/uploads/` and dispatches the personalized emails
 * (simulated via console logging).
 * 201 -> { motionId, imported, emailsSent }; 400 -> invalid form data; 413 -> too large;
 * 415 -> not multipart; 422 -> invalid CSV; 500 -> persistence failure.
 * TODO: protect with SSO/admin middleware (the prototype relies on frontend routing only).
 */
router.post("/api/admin/dispatch", async (ctx) => {
  const contentType = ctx.request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
    return sendError(ctx, 415, "Content-Type must be multipart/form-data.");
  }

  const declaredLength = Number(ctx.request.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_DISPATCH_BYTES) {
    return sendError(ctx, 413, "Payload too large.");
  }

  // Oak 17 equivalent of the legacy `request.body({ type: "form-data" })` API.
  let formData: FormData;
  try {
    formData = await ctx.request.body.formData();
  } catch {
    return sendError(ctx, 400, "Unable to read multipart form data.");
  }

  try {
    const result = await processAdminDispatch(formData);
    ctx.response.status = 201;
    ctx.response.body = result;
  } catch (error) {
    if (error instanceof AdminServiceError) {
      return sendError(ctx, error.status, error.message, error.details);
    }
    console.error("Failed to process admin dispatch:", error);
    sendError(ctx, 500, "Failed to create the motion and dispatch emails.");
  }
});

/**
 * POST /api/vote
 * Body (JSON): { "token": "...", "motionId": "...", "choice": "..." }
 * 200 -> Success; 400 -> Missing fields; 404 -> Invalid token (or token of another motion);
 * 403 -> Already voted.
 */
router.post("/api/vote", async (ctx) => {
  try {
    const body = await ctx.request.body.json();
    const { token, motionId, choice } = body;

    // Basic defensive validation
    if (!token || !motionId || !choice) {
      return sendError(ctx, 400, "Missing required fields: token, motionId, and choice.");
    }

    // A token issued for one motion must never be accepted for another one.
    await assertTokenMatchesMotion(token, motionId);

    // Delegate the vote processing to the service layer
    await processVote(token, motionId, choice);

    ctx.response.status = 200;
    ctx.response.body = { message: "Vote successfully registered." };
  } catch (error: any) {
    const msg = error.message || "";

    if (msg.includes("Invalid Token") || msg.includes("not found")) {
      return sendError(ctx, 404, "Invalid voting token.");
    }

    if (msg.includes("Already Voted") || msg.includes("has already voted")) {
      return sendError(ctx, 403, "Voter has already cast a vote.");
    }

    console.error("Error processing vote:", error);
    return sendError(ctx, 500, "Internal server error while processing the vote.");
  }
});

/**
 * GET /api/survey
 * Fetches the massive survey data (Survey Dashboard).
 */
router.get("/api/survey", async (ctx) => {
  try {
    const surveyFile = new URL("./data.json", import.meta.url);
    const data = await Deno.readTextFile(surveyFile);
    ctx.response.status = 200;
    ctx.response.body = JSON.parse(data);
  } catch (error) {
    console.error("Error reading survey data:", error);
    sendError(ctx, 500, "Failed to load survey data.");
  }
});

/**
 * POST /api/survey/answer
 * Body (JSON): { "questionId": "q-002", "userEmail": "ceo@company.com", "answerText": "..." }
 * 200 -> { message, survey }; 400 -> invalid input; 403 -> caller is not the question owner;
 * 404 -> unknown question; 409 -> already answered.
 * TODO: derive `userEmail` from the authenticated SSO session instead of the request body.
 */
router.post("/api/survey/answer", async (ctx) => {
  const body = await readJsonObject(ctx);
  if (!body) return sendError(ctx, 400, "Request body must be a valid JSON object.");

  const { questionId, userEmail, answerText } = body;
  if (
    typeof questionId !== "string" || typeof userEmail !== "string" ||
    typeof answerText !== "string"
  ) {
    return sendError(ctx, 400, "Missing required fields: questionId, userEmail, and answerText.");
  }

  try {
    const survey = await answerQuestion(questionId, userEmail, answerText);
    ctx.response.status = 200;
    ctx.response.body = { message: "Answer saved.", survey };
  } catch (error) {
    sendSurveyError(ctx, error, "Failed to save the answer.");
  }
});

/**
 * POST /api/survey/delegate
 * Body (JSON): { "questionId"?: "q-002", "category"?: "finance",
 *                "currentOwnerEmail": "...", "newOwnerEmail": "..." }
 * Provide exactly one of `questionId` (single question) or `category` (all pending questions
 * owned by the caller in that category).
 * 200 -> { message, transferredQuestionIds, survey }; 400 -> invalid input; 403 -> caller is not
 * the owner; 404 -> unknown question/category; 409 -> nothing pending to delegate.
 * TODO: derive `currentOwnerEmail` from the authenticated SSO session.
 */
router.post("/api/survey/delegate", async (ctx) => {
  const body = await readJsonObject(ctx);
  if (!body) return sendError(ctx, 400, "Request body must be a valid JSON object.");

  const { questionId, category, currentOwnerEmail, newOwnerEmail } = body;
  if (typeof currentOwnerEmail !== "string" || typeof newOwnerEmail !== "string") {
    return sendError(ctx, 400, "Missing required fields: currentOwnerEmail and newOwnerEmail.");
  }

  try {
    const result = await delegateResponsibility({
      questionId: typeof questionId === "string" ? questionId : undefined,
      category: typeof category === "string" ? category : undefined,
      currentOwnerEmail,
      newOwnerEmail,
    });
    ctx.response.status = 200;
    ctx.response.body = {
      message: `Responsibility transferred for ${result.transferredQuestionIds.length} question(s).`,
      transferredQuestionIds: result.transferredQuestionIds,
      survey: result.survey,
    };
  } catch (error) {
    sendSurveyError(ctx, error, "Failed to delegate responsibility.");
  }
});

// ---------- App ----------

const app = new Application();

// Minimal CORS for the frontend dev server.
app.use(async (ctx, next) => {
  ctx.response.headers.set("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  ctx.response.headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
  ctx.response.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (ctx.request.method === "OPTIONS") {
    ctx.response.status = 204;
    return;
  }
  await next();
});

// Last-resort error handler: never leak internals.
app.use(async (ctx, next) => {
  try {
    await next();
  } catch (error) {
    console.error("Unhandled error:", error);
    sendError(ctx, 500, "Internal server error.");
  }
});

app.use(router.routes());
app.use(router.allowedMethods());

console.log(`Server listening on http://localhost:${PORT}`);
await app.listen({ port: PORT });