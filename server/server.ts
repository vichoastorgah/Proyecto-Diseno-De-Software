/**
 * @module server
 * Oak HTTP layer. Business logic lives in `services/voterService.ts`,
 * `services/votingService.ts`, `services/surveyService.ts`, `services/adminService.ts`,
 * `services/emailService.ts` and `services/authService.ts`.
 *
 * Run (from the repository root, so that `.env` is found):
 *   deno run --allow-net --allow-read --allow-write --allow-env --allow-sys server/server.ts
 */
import "jsr:@std/dotenv/load";
import { Application, type Context, Router } from "jsr:@oak/oak@^17";
import { fromFileUrl } from "jsr:@std/path@^1";
import {
  appendVoters,
  buildVoterRecords,
  parseVotersCsv,
  type VoterRecord,
} from "./services/voterService.ts";
import {
  getMotionById,
  getVotingContext,
  type Motion,
  processVote,
  VotingServiceError,
} from "./services/votingService.ts";
import {
  answerQuestion,
  createSurvey,
  delegateResponsibility,
  SurveyServiceError,
} from "./services/surveyService.ts";
import { AdminServiceError, processAdminDispatch } from "./services/adminService.ts";
import {
  type DeliveryMode,
  type EmailLanguage,
  sendRealPersonalizedEmail,
} from "./services/emailService.ts";
import {
  AuthServiceError,
  getSessionUser,
  issueSession,
  type SessionUser,
  verifyGoogleCredential,
} from "./services/authService.ts";

const PORT = Number(Deno.env.get("PORT") ?? 8000);
const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") ?? "http://localhost:5173";
const MAX_BODY_BYTES = 1_000_000; // 1 MB
const MAX_DISPATCH_BYTES = 12 * 1024 * 1024; // 10 MB attachment + 1 MB CSV + multipart overhead

/** Standard JSON error payload. `code` is a stable identifier the frontend can translate. */
interface ErrorResponse {
  error: string;
  code?: string;
  details?: string[];
}

/** Successful upload payload (tokens are never returned to the client). */
interface UploadResponse {
  imported: number;
  emails: string[];
  emailsSent: number;
  emailsFailed: string[];
  deliveryMode: DeliveryMode;
}

/** Sets an error status and JSON body on the response. */
function sendError(
  ctx: Context,
  status: number,
  error: string,
  details?: string[],
  code?: string,
): void {
  const body: ErrorResponse = { error };
  if (code) body.code = code;
  if (details) body.details = details;
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

/** Maps a voting service failure to an HTTP error response. */
function sendVotingError(ctx: Context, error: unknown, fallbackMessage: string): void {
  if (error instanceof VotingServiceError) {
    return sendError(ctx, error.status, error.message, undefined, error.code);
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

/**
 * Requires a valid session (Google SSO). Sends 401 and returns null otherwise.
 * The caller must `return` when the result is null.
 */
async function requireUser(ctx: Context): Promise<SessionUser | null> {
  const user = await getSessionUser(ctx.request.headers.get("authorization"));
  if (!user) {
    sendError(ctx, 401, "Authentication required.", undefined, "UNAUTHENTICATED");
    return null;
  }
  return user;
}

/**
 * Resolves who is acting on the survey.
 * - A valid session (Google SSO) always wins: the identity is verified by the server.
 * - Without a session, the email in the request body is accepted ONLY when the server runs
 *   in demo mode (`ALLOW_DEMO_SURVEY_IDENTITY=true`), which lets a presenter act as several
 *   colleagues. Otherwise the request is rejected.
 *
 * @returns The acting email, or null when the caller is not allowed to act.
 */
async function resolveSurveyActor(ctx: Context, bodyEmail: unknown): Promise<string | null> {
  const session = await getSessionUser(ctx.request.headers.get("authorization"));
  if (session) return session.email;
  if (Deno.env.get("ALLOW_DEMO_SURVEY_IDENTITY") === "true" && typeof bodyEmail === "string") {
    return bodyEmail;
  }
  return null;
}

/** Parses the optional `lang` query parameter. */
function parseEmailLanguage(value: string | null): EmailLanguage | undefined {
  return value === "en" || value === "es" ? value : undefined;
}

/**
 * Resolves the stored attachment of a motion to an absolute path.
 * Returns undefined when the motion has no attachment or the stored name is suspicious.
 */
function resolveAttachmentPath(motion: Motion): string | undefined {
  const storedName = motion.attachment?.storedName;
  if (!storedName || /[\\/]/.test(storedName) || storedName.includes("..")) return undefined;
  return fromFileUrl(new URL(`./uploads/${storedName}`, import.meta.url));
}

/** Aggregated outcome of sending several invitations. */
interface InvitationSummary {
  sent: number;
  failed: string[];
  mode: DeliveryMode;
}

/**
 * Sends one invitation per voter, sequentially (friendly to SMTP rate limits).
 * A failure for one recipient never aborts the rest.
 */
async function sendInvitations(
  voters: readonly VoterRecord[],
  motion: Motion,
  language: EmailLanguage | undefined,
): Promise<InvitationSummary> {
  const attachmentPath = resolveAttachmentPath(motion);
  const summary: InvitationSummary = { sent: 0, failed: [], mode: "simulated" };

  for (const voter of voters) {
    try {
      const result = await sendRealPersonalizedEmail(voter, voter.token, attachmentPath, {
        language,
        motionTitle: motion.title,
        attachmentName: motion.attachment?.originalName,
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

// ---------- Routes ----------

const router = new Router();

/**
 * POST /api/auth/google
 * Body (JSON): { "credential": "<Google ID token>" }
 * The email is derived from the verified token payload, never from client-supplied fields.
 * 200 -> { user, token, expiresAt }; 400 -> missing credential; 401 -> invalid token;
 * 403 -> account not allowed; 500 -> SSO not configured.
 */
router.post("/api/auth/google", async (ctx) => {
  const body = await readJsonObject(ctx);
  const credential = body?.credential;
  if (typeof credential !== "string" || credential === "") {
    return sendError(ctx, 400, "Missing required field: credential.", undefined, "INVALID_CREDENTIAL");
  }

  try {
    const user = await verifyGoogleCredential(credential);
    ctx.response.status = 200;
    ctx.response.body = await issueSession(user);
  } catch (error) {
    if (error instanceof AuthServiceError) {
      return sendError(ctx, error.status, error.message, undefined, error.code);
    }
    console.error("Google sign-in failed:", error);
    sendError(ctx, 500, "Sign-in failed.");
  }
});

/**
 * POST /api/admin/voters/upload?motionId=<id>[&lang=en|es]
 * Body: raw CSV text with header `email,name,birthdate,gender,weight`.
 * Imports voters for an EXISTING motion (each gets a unique token that expires in 48 hours)
 * and sends the personalized emails (real SMTP, or console simulation without credentials).
 * 201 -> imported; 400 -> bad request; 401 -> not signed in; 404 -> unknown motion;
 * 409 -> duplicates; 413 -> too large; 422 -> invalid CSV.
 */
router.post("/api/admin/voters/upload", async (ctx) => {
  if (!await requireUser(ctx)) return;

  const motionId = ctx.request.url.searchParams.get("motionId");
  if (!motionId) {
    return sendError(ctx, 400, "Missing query parameter: motionId.");
  }

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

  let motion: Motion | undefined;
  try {
    motion = await getMotionById(motionId);
  } catch (error) {
    console.error("Failed to read motions:", error);
    return sendError(ctx, 500, "Failed to read motions.");
  }
  if (!motion) {
    return sendError(ctx, 404, "Motion not found.", undefined, "MOTION_NOT_FOUND");
  }

  const { rows, errors } = parseVotersCsv(csv);
  if (errors.length > 0) {
    return sendError(
      ctx,
      422,
      "CSV validation failed.",
      errors.slice(0, 50).map((e) => (e.record > 0 ? `Record ${e.record}: ${e.message}` : e.message)),
    );
  }

  const voters = buildVoterRecords(rows, motion.id);

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
  const delivery = await sendInvitations(
    voters,
    motion,
    parseEmailLanguage(ctx.request.url.searchParams.get("lang")),
  );

  const body: UploadResponse = {
    imported: voters.length,
    emails: voters.map((v) => v.email),
    emailsSent: delivery.sent,
    emailsFailed: delivery.failed,
    deliveryMode: delivery.mode,
  };
  ctx.response.status = 201;
  ctx.response.body = body;
});

/**
 * POST /api/admin/dispatch
 * Body: multipart/form-data with fields
 *   `title` (text), `description` (text), `attachment` (file), `votersCsv` (file, .csv),
 *   `options` (optional text, comma or newline separated; defaults to approve/reject).
 * Creates the motion, imports the voters (unique token each, bound to the new `motionId`),
 * stores the attachment in `server/uploads/` and dispatches the personalized emails.
 * 201 -> { motionId, imported, emailsSent, emailsFailed, deliveryMode }; 400 -> invalid form;
 * 401 -> not signed in; 413 -> too large; 415 -> not multipart; 422 -> invalid CSV;
 * 500 -> persistence failure.
 */
router.post("/api/admin/dispatch", async (ctx) => {
  if (!await requireUser(ctx)) return;

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
 * GET /api/vote/context?token=...
 * Returns the motion (title, description, options) and the voter status
 * (hasVoted, isExpired) behind a voting link.
 * 200 -> context; 400 -> missing token; 404 -> invalid token or unknown motion.
 */
router.get("/api/vote/context", async (ctx) => {
  const token = ctx.request.url.searchParams.get("token");
  if (!token) {
    return sendError(ctx, 400, "Missing query parameter: token.", undefined, "INVALID_TOKEN");
  }

  try {
    const votingContext = await getVotingContext(token);
    ctx.response.headers.set("Cache-Control", "no-store");
    ctx.response.status = 200;
    ctx.response.body = votingContext;
  } catch (error) {
    sendVotingError(ctx, error, "Failed to load the voting context.");
  }
});

/**
 * POST /api/vote
 * Body (JSON): { "token": "...", "motionId": "...", "choice": "..." }
 * 200 -> Success; 400 -> missing fields or invalid option; 404 -> invalid token (or token of
 * another motion) / unknown motion; 403 -> already voted or token expired.
 * Error bodies carry a `code`: INVALID_TOKEN, TOKEN_EXPIRED, ALREADY_VOTED, MOTION_NOT_FOUND,
 * INVALID_OPTION.
 */
router.post("/api/vote", async (ctx) => {
  const body = await readJsonObject(ctx);
  if (!body) return sendError(ctx, 400, "Request body must be a valid JSON object.");

  const { token, motionId, choice } = body;
  if (
    typeof token !== "string" || typeof motionId !== "string" || typeof choice !== "string" ||
    token === "" || motionId === "" || choice === ""
  ) {
    return sendError(ctx, 400, "Missing required fields: token, motionId, and choice.");
  }

  try {
    await processVote(token, motionId, choice);
    ctx.response.status = 200;
    ctx.response.body = { message: "Vote successfully registered." };
  } catch (error) {
    sendVotingError(ctx, error, "Internal server error while processing the vote.");
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
 * POST /api/survey/create  (requires a signed-in user)
 * Body (JSON): { "title": "...", "initialRecipient": "ceo@company.com",
 *                "questions": ["How is the budget?", ...], "force"?: true }
 * Questions are categorized automatically by keyword matching.
 * 201 -> { message, survey }; 400 -> invalid input; 401 -> not signed in;
 * 409 -> the current survey already has answers (send `force: true` to replace it).
 */
router.post("/api/survey/create", async (ctx) => {
  if (!await requireUser(ctx)) return;

  const body = await readJsonObject(ctx);
  if (!body) return sendError(ctx, 400, "Request body must be a valid JSON object.");

  const { title, initialRecipient, questions, force } = body;
  if (
    typeof title !== "string" || typeof initialRecipient !== "string" ||
    !Array.isArray(questions) || !questions.every((q) => typeof q === "string")
  ) {
    return sendError(
      ctx,
      400,
      "Required fields: title (string), initialRecipient (string), questions (string[]).",
    );
  }

  try {
    const survey = await createSurvey(questions as string[], {
      title,
      initialRecipient,
      force: force === true,
    });
    ctx.response.status = 201;
    ctx.response.body = { message: "Survey created.", survey };
  } catch (error) {
    sendSurveyError(ctx, error, "Failed to create the survey.");
  }
});

/**
 * POST /api/survey/answer
 * Body (JSON): { "questionId": "q-002", "userEmail": "ceo@company.com", "answerText": "..." }
 * With a valid `Authorization: Bearer` session, the caller's email comes from the session and
 * `userEmail` is ignored. Without a session, `userEmail` is accepted only in demo mode
 * (`ALLOW_DEMO_SURVEY_IDENTITY=true`).
 * 200 -> { message, survey }; 400 -> invalid input; 401 -> no identity; 403 -> caller is not the
 * question owner; 404 -> unknown question; 409 -> already answered.
 */
router.post("/api/survey/answer", async (ctx) => {
  const body = await readJsonObject(ctx);
  if (!body) return sendError(ctx, 400, "Request body must be a valid JSON object.");

  const { questionId, userEmail, answerText } = body;
  if (typeof questionId !== "string" || typeof answerText !== "string") {
    return sendError(ctx, 400, "Missing required fields: questionId and answerText.");
  }
  const actorEmail = await resolveSurveyActor(ctx, userEmail);
  if (actorEmail === null) {
    return sendError(ctx, 401, "Authentication required.", undefined, "UNAUTHENTICATED");
  }

  try {
    const survey = await answerQuestion(questionId, actorEmail, answerText);
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
 * owned by the caller in that category). Identity rules are the same as for `/api/survey/answer`:
 * session first, body field only in demo mode.
 * 200 -> { message, transferredQuestionIds, survey }; 400 -> invalid input; 401 -> no identity;
 * 403 -> caller is not the owner; 404 -> unknown question/category; 409 -> nothing pending.
 */
router.post("/api/survey/delegate", async (ctx) => {
  const body = await readJsonObject(ctx);
  if (!body) return sendError(ctx, 400, "Request body must be a valid JSON object.");

  const { questionId, category, currentOwnerEmail, newOwnerEmail } = body;
  if (typeof newOwnerEmail !== "string") {
    return sendError(ctx, 400, "Missing required field: newOwnerEmail.");
  }
  const actorEmail = await resolveSurveyActor(ctx, currentOwnerEmail);
  if (actorEmail === null) {
    return sendError(ctx, 401, "Authentication required.", undefined, "UNAUTHENTICATED");
  }

  try {
    const result = await delegateResponsibility({
      questionId: typeof questionId === "string" ? questionId : undefined,
      category: typeof category === "string" ? category : undefined,
      currentOwnerEmail: actorEmail,
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
  ctx.response.headers.set("Vary", "Origin");
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