/**
 * @module http/votingRoutes
 * Public voting API (the unique link token is the only credential).
 *
 * GET  /api/vote/context?token=...                         ballot (motions, options, status)
 * POST /api/vote  { token, choices: { motionId: option } } cast the ballot (once)
 *                 (the former body { token, motionId, choice } is also accepted)
 * GET  /api/vote/attachments/:attachmentId?token=...       download a document of the election
 */
import type { Router } from "@oak/oak";
import { AppError } from "../errors.ts";
import { castBallot, getBallot, getElectionIdForToken, readChoices } from "../services/votingService.ts";
import { getAttachmentFile } from "../services/electionService.ts";
import { mimeTypeFor } from "../services/attachmentService.ts";
import { type AppDeps, readJsonBody, sendDownload } from "./helpers.ts";

export function registerVotingRoutes(router: Router, deps: AppDeps): void {
  router.get("/api/vote/context", async (ctx) => {
    const token = ctx.request.url.searchParams.get("token");
    if (!token) throw new AppError(400, "INVALID_TOKEN", "Missing query parameter: token.");
    ctx.response.body = await getBallot(deps, token);
  });

  router.post("/api/vote", async (ctx) => {
    const body = await readJsonBody(ctx, 64 * 1024);
    await castBallot(deps, body.token, readChoices(body));
    ctx.response.body = { message: "Vote successfully registered." };
  });

  router.get("/api/vote/attachments/:attachmentId", async (ctx) => {
    const electionId = await getElectionIdForToken(deps, ctx.request.url.searchParams.get("token"));
    const file = await getAttachmentFile(deps, electionId, ctx.params.attachmentId);
    sendDownload(ctx, file.bytes, file.name, mimeTypeFor(file.name));
  });
}
