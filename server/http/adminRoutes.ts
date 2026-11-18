/**
 * @module http/adminRoutes
 * Admin portal API (every route requires the admin role).
 *
 * GET  /api/admin/summary                                   dashboard figures
 * GET  /api/admin/elections                                 elections with participation
 * POST /api/admin/elections                    (multipart)  create + import voters + send invitations
 *      fields: title, description, motions (JSON array of {title, description, options[]}),
 *              votersCsv (file), attachments (0-5 files), lang (en|es),
 *              requestId (optional idempotency key: a retried submission returns the
 *              election created the first time instead of creating and mailing again)
 * POST /api/admin/csv/validate                 (multipart)  check a voters CSV without saving it
 * GET  /api/admin/elections/:id                             motions, results (once closed), integrity
 * GET  /api/admin/elections/:id/voters?search&status&page   paginated voters
 * POST /api/admin/elections/:id/voters         (multipart)  add voters (votersCsv, lang)
 * POST /api/admin/elections/:id/voters/:voterId/resend      new link for a voter who has not voted
 * POST /api/admin/elections/:id/status         { status }   open / close
 * GET  /api/admin/elections/:id/attachments/:attachmentId   download
 *
 * Former endpoints kept for compatibility:
 * POST /api/admin/dispatch        (multipart: title, description, options, attachment, votersCsv)
 * POST /api/admin/voters/upload?motionId=<electionId>   (text/csv body)
 */
import type { Context, Router } from "@oak/oak";
import { AppError, validationError } from "../errors.ts";
import { type CsvParseResult, parseVotersCsv } from "../services/csvService.ts";
import { mimeTypeFor, prepareAttachments } from "../services/attachmentService.ts";
import {
  addVoters,
  createElection,
  findElectionByRequestId,
  getAttachmentFile,
  getDashboardSummary,
  getElectionDetail,
  listElections,
  listVoters,
  rotateVoterToken,
  sendInvitations,
  setElectionStatus,
  validateElectionMetadata,
} from "../services/electionService.ts";
import {
  type AppDeps,
  emailLanguage,
  filesOf,
  intParam,
  readFormData,
  readJsonBody,
  readLimitedText,
  requireAdmin,
  sendDownload,
  textOf,
} from "./helpers.ts";

const MAX_CSV_BYTES = 1_000_000;
const MAX_ELECTION_REQUEST_BYTES = 12 * 1024 * 1024;

/** Reads and validates the voters CSV of a multipart form. */
async function readVotersCsv(form: FormData): Promise<CsvParseResult> {
  const [file] = filesOf(form, "votersCsv");
  if (!file) throw validationError("A voters CSV file is required.", [{ code: "CSV_REQUIRED", message: "votersCsv", field: "votersCsv" }]);
  if (!file.name.toLowerCase().endsWith(".csv")) {
    throw validationError("The voters list must be a .csv file.", [{ code: "CSV_EXTENSION", message: file.name, field: "votersCsv" }]);
  }
  if (file.size > MAX_CSV_BYTES) throw new AppError(413, "CSV_TOO_LARGE", "The voters CSV exceeds 1 MB.");
  return parseVotersCsv(await file.text());
}

function assertValidCsv(result: CsvParseResult): void {
  if (result.errors.length > 0) {
    throw new AppError(422, "CSV_VALIDATION_FAILED", "The voters CSV has errors. Nothing was saved.", result.errors);
  }
}

function parseMotionsField(raw: string): unknown {
  if (raw.trim() === "") return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    throw validationError("motions must be a JSON array.", [{ code: "MOTIONS_INVALID_JSON", message: "motions", field: "motions" }]);
  }
}

/** Shared implementation of the new and the legacy creation endpoints. */
async function handleCreate(ctx: Context, deps: AppDeps, legacy: boolean): Promise<void> {
  const admin = await requireAdmin(ctx, deps);
  const form = await readFormData(ctx, MAX_ELECTION_REQUEST_BYTES);

  const requestId = textOf(form, "requestId").trim().slice(0, 100) || null;
  if (requestId) {
    const existing = await findElectionByRequestId(deps, requestId);
    if (existing) {
      // A retry of a submission that already succeeded: nothing is created or mailed again.
      ctx.response.status = 200;
      ctx.response.body = { ...existing, motionId: existing.electionId, duplicate: true };
      return;
    }
  }

  const title = textOf(form, "title");
  const description = textOf(form, "description");
  const motions = legacy
    ? [{ title, description, options: textOf(form, "options") }]
    : parseMotionsField(textOf(form, "motions"));
  const metadata = validateElectionMetadata(title, description, motions);

  const csv = await readVotersCsv(form);
  assertValidCsv(csv);
  const attachments = await prepareAttachments(filesOf(form, legacy ? "attachment" : "attachments"));

  const { electionId, invitations } = await createElection(
    deps,
    { ...metadata, voters: csv.rows, attachments },
    admin.email,
    requestId,
  );
  const delivery = await sendInvitations(deps, electionId, invitations, emailLanguage(deps, textOf(form, "lang")));

  ctx.response.status = 201;
  ctx.response.body = {
    electionId,
    motionId: electionId, // Former response field.
    imported: invitations.length,
    emailsSent: delivery.sent,
    emailsFailed: delivery.failed,
    deliveryMode: delivery.mode,
  };
}

export function registerAdminRoutes(router: Router, deps: AppDeps): void {
  router.get("/api/admin/summary", async (ctx) => {
    await requireAdmin(ctx, deps);
    ctx.response.body = await getDashboardSummary(deps);
  });

  router.get("/api/admin/elections", async (ctx) => {
    await requireAdmin(ctx, deps);
    ctx.response.body = { elections: await listElections(deps) };
  });

  router.post("/api/admin/elections", (ctx) => handleCreate(ctx, deps, false));
  router.post("/api/admin/dispatch", (ctx) => handleCreate(ctx, deps, true));

  router.post("/api/admin/csv/validate", async (ctx) => {
    await requireAdmin(ctx, deps);
    const form = await readFormData(ctx, MAX_CSV_BYTES + 64 * 1024);
    const result = await readVotersCsv(form);
    ctx.response.body = {
      totalRecords: result.totalRecords,
      validRecords: result.rows.length,
      errors: result.errors,
      totalWeight: result.rows.reduce((sum, row) => sum + row.weight, 0),
      preview: result.rows.slice(0, 5).map(({ email, name, gender, weight }) => ({ email, name, gender, weight })),
    };
  });

  router.get("/api/admin/elections/:id", async (ctx) => {
    await requireAdmin(ctx, deps);
    ctx.response.body = await getElectionDetail(deps, ctx.params.id);
  });

  router.get("/api/admin/elections/:id/voters", async (ctx) => {
    await requireAdmin(ctx, deps);
    const params = ctx.request.url.searchParams;
    const status = params.get("status");
    ctx.response.body = await listVoters(deps, ctx.params.id, {
      search: params.get("search") ?? "",
      status: status === "voted" || status === "pending" ? status : "all",
      page: Number(params.get("page") ?? 1) || 1,
      pageSize: Number(params.get("pageSize") ?? 25) || 25,
    });
  });

  router.post("/api/admin/elections/:id/voters", async (ctx) => {
    await requireAdmin(ctx, deps);
    const form = await readFormData(ctx, MAX_CSV_BYTES + 64 * 1024);
    const csv = await readVotersCsv(form);
    assertValidCsv(csv);
    const invitations = await addVoters(deps, ctx.params.id, csv.rows);
    const delivery = await sendInvitations(deps, ctx.params.id, invitations, emailLanguage(deps, textOf(form, "lang")));
    ctx.response.status = 201;
    ctx.response.body = {
      imported: invitations.length,
      emailsSent: delivery.sent,
      emailsFailed: delivery.failed,
      deliveryMode: delivery.mode,
    };
  });

  router.post("/api/admin/elections/:id/voters/:voterId/resend", async (ctx) => {
    await requireAdmin(ctx, deps);
    const invitation = await rotateVoterToken(deps, ctx.params.id, intParam(ctx.params.voterId, "VOTER_NOT_FOUND"));
    const delivery = await sendInvitations(
      deps, ctx.params.id, [invitation], emailLanguage(deps, ctx.request.url.searchParams.get("lang")),
    );
    ctx.response.body = { emailsSent: delivery.sent, emailsFailed: delivery.failed, deliveryMode: delivery.mode };
  });

  router.post("/api/admin/elections/:id/status", async (ctx) => {
    await requireAdmin(ctx, deps);
    const body = await readJsonBody(ctx, 1024);
    ctx.response.body = await setElectionStatus(deps, ctx.params.id, body.status);
  });

  router.get("/api/admin/elections/:id/attachments/:attachmentId", async (ctx) => {
    await requireAdmin(ctx, deps);
    const file = await getAttachmentFile(deps, ctx.params.id, ctx.params.attachmentId);
    sendDownload(ctx, file.bytes, file.name, mimeTypeFor(file.name));
  });

  // Former endpoint: adds voters (raw CSV body) to an existing election.
  router.post("/api/admin/voters/upload", async (ctx) => {
    await requireAdmin(ctx, deps);
    const electionId = ctx.request.url.searchParams.get("motionId") ?? "";
    if (electionId === "") throw validationError("Missing query parameter: motionId.");
    const csv = parseVotersCsv(await readLimitedText(ctx, MAX_CSV_BYTES));
    assertValidCsv(csv);
    const invitations = await addVoters(deps, electionId, csv.rows);
    const delivery = await sendInvitations(
      deps, electionId, invitations, emailLanguage(deps, ctx.request.url.searchParams.get("lang")),
    );
    ctx.response.status = 201;
    ctx.response.body = {
      imported: invitations.length,
      emails: invitations.map((invitation) => invitation.email),
      emailsSent: delivery.sent,
      emailsFailed: delivery.failed,
      deliveryMode: delivery.mode,
    };
  });
}
