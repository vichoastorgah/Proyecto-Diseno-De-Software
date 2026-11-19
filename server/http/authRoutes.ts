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
    // Outcome only (never the email or the token): enough to tell, from the host logs,
    // whether a sign-in reached the server and why it was rejected.
    try {
      const grant = await deps.auth.signInWithGoogle(body.credential);
      console.log(`[auth] Google sign-in accepted (role: ${grant.user.isAdmin ? "admin" : "participant"}).`);
      ctx.response.body = grant;
    } catch (error) {
      console.warn(`[auth] Google sign-in rejected: ${error instanceof AppError ? error.code : "INTERNAL_ERROR"}.`);
      throw error;
    }
  });

  router.get("/api/auth/me", async (ctx) => {
    const user = await requireUser(ctx, deps);
    ctx.response.body = {
      user,
      demoSurveyIdentity: deps.config.demoSurveyIdentity && user.isAdmin,
    };
  });
}
