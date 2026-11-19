/**
 * @module config
 * Typed view of the environment variables. Read once at startup (`loadConfig`) and passed
 * explicitly to the services, so tests can build their own configuration.
 */
import { fromFileUrl, isAbsolute, join } from "@std/path";

/** Absolute path of the `server/` directory. */
export const SERVER_DIR = fromFileUrl(new URL(".", import.meta.url));

export interface AppConfig {
  port: number;
  /** Origins allowed by CORS (exact match). */
  allowedOrigins: string[];
  /** PostgreSQL connection string (Supabase). Empty -> embedded PGlite at `databasePath`. */
  databaseUrl: string;
  /** PGlite data folder (local development). `:memory:` is accepted (tests). */
  databasePath: string;
  /** Directory where attachments are stored when Supabase Storage is not configured. */
  uploadsDir: string;
  /** Supabase Storage (production). All three are required to use it. */
  supabaseUrl: string;
  supabaseServiceKey: string;
  supabaseBucket: string;
  /** Directory that may contain the legacy `voters.json`, `motions.json` and `data.json`. */
  legacyDataDir: string;
  googleClientId: string;
  /** HMAC secret for session tokens (>= 32 chars). Empty -> random secret per process. */
  sessionSecret: string;
  /** Admin role. When both lists are empty, the `allowed*` lists are used instead. */
  adminEmails: string[];
  adminDomains: string[];
  /** Who may sign in (besides admins and survey participants). */
  allowedEmails: string[];
  allowedDomains: string[];
  /** Lets an authenticated admin act as another person in surveys (live demos only). */
  demoSurveyIdentity: boolean;
  /** Public URL of the voting page; the token is appended as `?token=`. */
  voteBaseUrl: string;
  /** Public URL of the web app (used for survey links in emails). */
  appBaseUrl: string;
  /** Lifetime of a voting link, in hours. */
  tokenTtlHours: number;
  defaultEmailLanguage: "en" | "es";
  /** Built frontend served by the API (single-service deployment). Empty -> API only. */
  staticDir: string;
  /** True on Render (or any host whose disk is wiped on restart). */
  ephemeralDisk: boolean;
}

type Env = Record<string, string | undefined>;

/** Splits a comma-separated variable into trimmed, lower-cased, non-empty items. */
function readList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item !== "");
}

function readPath(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  if (value === ":memory:") return value;
  return isAbsolute(value) ? value : join(Deno.cwd(), value);
}

function readPositiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Builds the configuration from environment variables (defaults suit local development).
 *
 * On Render, `RENDER_EXTERNAL_URL` (the public https URL, set by the platform) is the default
 * app URL and CORS origin, so a single-service deployment needs no URL variables.
 */
export function loadConfig(env: Env = Deno.env.toObject()): AppConfig {
  const appBaseUrl = (env.APP_BASE_URL ?? env.RENDER_EXTERNAL_URL ?? "http://localhost:5173").replace(/\/+$/, "");
  const origins = readList(env.ALLOWED_ORIGIN);
  return {
    port: readPositiveNumber(env.PORT, 8000),
    allowedOrigins: origins.length > 0 ? origins : [appBaseUrl.toLowerCase()],
    databaseUrl: env.DATABASE_URL ?? "",
    databasePath: readPath(env.DATABASE_PATH, join(SERVER_DIR, "storage", "pgdata")),
    uploadsDir: readPath(env.UPLOADS_DIR, join(SERVER_DIR, "uploads")),
    supabaseUrl: env.SUPABASE_URL ?? "",
    supabaseServiceKey: env.SUPABASE_SERVICE_ROLE_KEY ?? "",
    supabaseBucket: env.SUPABASE_BUCKET ?? "attachments",
    legacyDataDir: readPath(env.LEGACY_DATA_DIR, SERVER_DIR),
    googleClientId: env.GOOGLE_CLIENT_ID ?? "",
    sessionSecret: env.SESSION_SECRET ?? "",
    adminEmails: readList(env.ADMIN_EMAILS),
    adminDomains: readList(env.ADMIN_EMAIL_DOMAINS),
    allowedEmails: readList(env.ALLOWED_EMAILS),
    allowedDomains: readList(env.ALLOWED_EMAIL_DOMAINS),
    demoSurveyIdentity: env.ALLOW_DEMO_SURVEY_IDENTITY === "true",
    voteBaseUrl: (env.VOTE_BASE_URL ?? `${appBaseUrl}/vote`).replace(/\/+$/, ""),
    appBaseUrl,
    tokenTtlHours: readPositiveNumber(env.VOTE_TOKEN_TTL_HOURS, 48),
    defaultEmailLanguage: env.DEFAULT_EMAIL_LANGUAGE === "es" ? "es" : "en",
    staticDir: env.STATIC_DIR ? readPath(env.STATIC_DIR, "") : "",
    ephemeralDisk: env.RENDER === "true" || env.EPHEMERAL_DISK === "true",
  };
}

/**
 * Configuration problems that would lose data or make a deployment unsafe.
 * On a host whose disk is wiped on every restart or redeploy (Render), a local database or a
 * local uploads folder would silently lose data, so the server refuses to start instead.
 */
export function productionProblems(config: AppConfig): string[] {
  const problems: string[] = [];
  if (!config.ephemeralDisk) return problems;
  if (!config.databaseUrl) problems.push("DATABASE_URL is required (a local database would be lost on restart).");
  if (!config.supabaseUrl || !config.supabaseServiceKey) {
    problems.push("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required (local attachments would be lost on restart).");
  }
  if (!config.googleClientId) problems.push("GOOGLE_CLIENT_ID is required for sign-in.");
  const noAdminList = config.adminEmails.length === 0 && config.adminDomains.length === 0 &&
    config.allowedEmails.length === 0 && config.allowedDomains.length === 0;
  if (noAdminList) problems.push("ADMIN_EMAILS is required (otherwise every Google account would be an administrator).");
  return problems;
}
