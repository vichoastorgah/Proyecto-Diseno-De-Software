/**
 * @module server
 * Oak HTTP layer. Business logic lives in `services/voterService.ts` and `services/votingService.ts`.
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
import { processVote } from "./services/votingService.ts"; // <-- Nueva importación del motor de votos

const PORT = Number(Deno.env.get("PORT") ?? 8000);
const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") ?? "http://localhost:5173";
const MAX_BODY_BYTES = 1_000_000; // 1 MB
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

// ---------- Persistence (serialized to avoid concurrent write races) ----------

let writeQueue: Promise<unknown> = Promise.resolve();

/** Runs `task` after all previously queued tasks have settled. */
function withWriteLock<T>(task: () => Promise<T>): Promise<T> {
  const run = writeQueue.then(task);
  writeQueue = run.catch(() => undefined);
  return run;
}

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
 * POST /api/vote
 * Body (JSON): { "token": "...", "motionId": "...", "choice": "..." }
 * 200 -> Success; 400 -> Missing fields; 404 -> Invalid token; 403 -> Already voted.
 */
router.post("/api/vote", async (ctx) => {
  try {
    const body = await ctx.request.body.json();
    const { token, motionId, choice } = body;

    // Validación defensiva básica
    if (!token || !motionId || !choice) {
      return sendError(ctx, 400, "Missing required fields: token, motionId, and choice.");
    }

    // Procesamos el voto delegando la lógica al servicio
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

// ---------- App ----------

const app = new Application();

// Minimal CORS for the frontend dev server.
app.use(async (ctx, next) => {
  ctx.response.headers.set("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  ctx.response.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
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