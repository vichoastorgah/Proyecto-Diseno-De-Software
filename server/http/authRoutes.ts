/**
 * @module http/authRoutes
 * POST /api/auth/google  { credential }  -> { user, token, expiresAt }
 * GET  /api/auth/me                      -> { user, demoSurveyIdentity }
 */
import type { Router } from "@oak/oak";
import { AppError } from "../errors.ts";
import { type AppDeps, readJsonBody, requireUser } from "./helpers.ts";

export function registerAuthRoutes(router: Router, deps: AppDeps): void {
  router.post("/api/auth/google", async (ctx) => {
    const body = await readJsonBody(ctx, 16 * 1024);
    if (typeof body.credential !== "string" || body.credential === "") {
      throw new AppError(400, "INVALID_CREDENTIAL", "Missing required field: credential.");
    }
    ctx.response.body = await deps.auth.signInWithGoogle(body.credential);
  });

  router.get("/api/auth/me", async (ctx) => {
    const user = await requireUser(ctx, deps);
    ctx.response.body = {
      user,
      demoSurveyIdentity: deps.config.demoSurveyIdentity && user.isAdmin,
    };
  });
}
