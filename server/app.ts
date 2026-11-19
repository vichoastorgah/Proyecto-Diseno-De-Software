/**
 * @module app
 * Builds the Oak application from explicit dependencies, so the same app runs in
 * production (`server.ts`) and in the integration tests (`app.handle(request)`).
 */
import { Application, type Context, isHttpError, Router, send } from "@oak/oak";
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

/**
 * Serves the built frontend (single-service deployment). Real files are returned as is;
 * any other non-API path gets `index.html` so client-side routes such as `/vote?token=...`
 * work on reload. Hashed assets are cached for a year, the HTML is always revalidated.
 */
async function serveFrontend(ctx: Context, root: string): Promise<boolean> {
  const path = ctx.request.url.pathname;
  const method = ctx.request.method;
  if (path === "/api" || path.startsWith("/api/") || (method !== "GET" && method !== "HEAD")) return false;

  const headers = ctx.response.headers;
  // Google Sign-In needs the page origin as referrer; the path/query (vote token) is never sent cross-origin.
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  try {
    await send(ctx, path, { root, index: "index.html" });
    headers.set("Cache-Control", path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache");
    return true;
  } catch {
    // A missing file with an extension (e.g. /assets/old.js) is a real 404, not an app route.
    if (/\.[a-z0-9]+$/i.test(path)) return false;
    await send(ctx, "/index.html", { root });
    headers.set("Cache-Control", "no-cache");
    return true;
  }
}

export function createApp(deps: AppDeps): Application {
  // Behind Render's proxy the client address comes from X-Forwarded-For; otherwise every
  // visitor would share the proxy's IP (and a single rate-limit bucket).
  const app = new Application({ proxy: deps.config.ephemeralDisk });
  const allowRequest = createRateLimiter(deps.rateLimitPerMinute);

  // Error handler first so it also covers CORS/limiter failures. Internals never leak.
  app.use(async (ctx, next) => {
    try {
      await next();
      // No route matched (404) or the method is not allowed (405, set by allowedMethods()).
      const status = ctx.response.status;
      if (ctx.response.body === undefined && (status === 404 || status === 405)) {
        const notAllowed = status === 405;
        ctx.response.status = status; // Explicit: setting a body would otherwise imply 200.
        ctx.response.body = {
          error: notAllowed ? "Method not allowed." : `No route for ${ctx.request.method} ${ctx.request.url.pathname}.`,
          code: notAllowed ? "METHOD_NOT_ALLOWED" : "NOT_FOUND",
        };
      }
    } catch (error) {
      if (error instanceof AppError) {
        ctx.response.status = error.status;
        ctx.response.body = { error: error.message, code: error.code, ...(error.details ? { details: error.details } : {}) };
      } else if ((error as { code?: unknown })?.code === "23505") {
        // Unique violation that slipped past a pre-check because of a concurrent request.
        ctx.response.status = 409;
        ctx.response.body = { error: "The data changed meanwhile. Reload and try again.", code: "CONFLICT" };
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
    // Hosted deployments are HTTPS-only: browsers must never fall back to plain HTTP.
    if (deps.config.ephemeralDisk) headers.set("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
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
  // Public, non-secret settings the frontend reads at runtime (one image for any environment).
  router.get("/api/config", (ctx) => {
    ctx.response.headers.set("Cache-Control", "public, max-age=300");
    ctx.response.body = { googleClientId: deps.config.googleClientId };
  });
  registerAuthRoutes(router, deps);
  registerAdminRoutes(router, deps);
  registerVotingRoutes(router, deps);
  registerSurveyRoutes(router, deps);

  app.use(router.routes());
  app.use(router.allowedMethods());

  if (deps.config.staticDir) {
    const root = deps.config.staticDir;
    app.use(async (ctx, next) => {
      if (!await serveFrontend(ctx, root)) await next();
    });
  }

  return app;
}
