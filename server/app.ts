/**
 * @module app
 * Builds the Oak application from explicit dependencies, so the same app runs in
 * production (`server.ts`) and in the integration tests (`app.handle(request)`).
 */
import { Application, isHttpError, Router } from "@oak/oak";
import { AppError } from "./errors.ts";
import type { AppDeps } from "./http/helpers.ts";
import { registerAuthRoutes } from "./http/authRoutes.ts";
import { registerAdminRoutes } from "./http/adminRoutes.ts";
import { registerVotingRoutes } from "./http/votingRoutes.ts";
import { registerSurveyRoutes } from "./http/surveyRoutes.ts";

export type { AppDeps } from "./http/helpers.ts";

/** Fixed-window limiter per client IP, applied to public and sign-in endpoints. */
function createRateLimiter(limitPerMinute: number) {
  const windows = new Map<string, { count: number; resetAt: number }>();
  return (key: string): boolean => {
    if (limitPerMinute <= 0) return true;
    const now = Date.now();
    const window = windows.get(key);
    if (!window || window.resetAt <= now) {
      if (windows.size > 10_000) windows.clear();
      windows.set(key, { count: 1, resetAt: now + 60_000 });
      return true;
    }
    window.count += 1;
    return window.count <= limitPerMinute;
  };
}

export function createApp(deps: AppDeps): Application {
  const app = new Application();
  const allowRequest = createRateLimiter(deps.rateLimitPerMinute);

  // Error handler first so it also covers CORS/limiter failures. Internals never leak.
  app.use(async (ctx, next) => {
    try {
      await next();
    } catch (error) {
      if (error instanceof AppError) {
        ctx.response.status = error.status;
        ctx.response.body = { error: error.message, code: error.code, ...(error.details ? { details: error.details } : {}) };
      } else if (isHttpError(error)) {
        ctx.response.status = error.status;
        ctx.response.body = { error: error.expose ? error.message : "Request failed.", code: "HTTP_ERROR" };
      } else {
        console.error("Unhandled error:", error);
        ctx.response.status = 500;
        ctx.response.body = { error: "Internal server error.", code: "INTERNAL_ERROR" };
      }
    }
  });

  // Security headers + CORS (exact origin allow-list).
  app.use(async (ctx, next) => {
    const headers = ctx.response.headers;
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Referrer-Policy", "no-referrer");
    headers.set("X-Frame-Options", "DENY");
    headers.set("Cache-Control", "no-store");
    headers.set("Vary", "Origin");

    const origin = ctx.request.headers.get("origin");
    if (origin && deps.config.allowedOrigins.includes(origin.toLowerCase())) {
      headers.set("Access-Control-Allow-Origin", origin);
      headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Act-As");
      headers.set("Access-Control-Expose-Headers", "Content-Disposition");
      headers.set("Access-Control-Max-Age", "600");
    }
    if (ctx.request.method === "OPTIONS") {
      ctx.response.status = 204;
      return;
    }
    await next();
  });

  app.use(async (ctx, next) => {
    const path = ctx.request.url.pathname;
    if (path.startsWith("/api/vote") || path === "/api/auth/google") {
      let ip = "unknown";
      try {
        ip = ctx.request.ip || "unknown";
      } catch {
        // No connection info (e.g. tests calling app.handle()).
      }
      if (!allowRequest(ip)) throw new AppError(429, "RATE_LIMITED", "Too many requests. Try again in a minute.");
    }
    await next();
  });

  const router = new Router();
  router.get("/api/health", (ctx) => {
    ctx.response.body = { status: "ok" };
  });
  registerAuthRoutes(router, deps);
  registerAdminRoutes(router, deps);
  registerVotingRoutes(router, deps);
  registerSurveyRoutes(router, deps);

  app.use(router.routes());
  app.use(router.allowedMethods());
  app.use((ctx) => {
    throw new AppError(404, "NOT_FOUND", `No route for ${ctx.request.method} ${ctx.request.url.pathname}.`);
  });

  return app;
}
