/**
 * @module config
 * Typed view of the environment variables. Read once at startup (`loadConfig`) and passed
 * explicitly to the services, so tests can build their own configuration.
 */
import { fromFileUrl, isAbsolute, join } from "jsr:@std/path@^1";

/** Absolute path of the `server/` directory. */
export const SERVER_DIR = fromFileUrl(new URL(".", import.meta.url));

export interface AppConfig {
  port: number;
  /** Origins allowed by CORS (exact match). */
  allowedOrigins: string[];
  /** SQLite file. `:memory:` is accepted (tests). */
  databasePath: string;
  /** Directory where attachments are stored. */
  uploadsDir: string;
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

/** Builds the configuration from environment variables (defaults suit local development). */
export function loadConfig(env: Env = Deno.env.toObject()): AppConfig {
  const appBaseUrl = (env.APP_BASE_URL ?? "http://localhost:5173").replace(/\/+$/, "");
  const origins = readList(env.ALLOWED_ORIGIN);
  return {
    port: readPositiveNumber(env.PORT, 8000),
    allowedOrigins: origins.length > 0 ? origins : ["http://localhost:5173"],
    databasePath: readPath(env.DATABASE_PATH, join(SERVER_DIR, "storage", "app.db")),
    uploadsDir: readPath(env.UPLOADS_DIR, join(SERVER_DIR, "uploads")),
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
  };
}
