/**
 * Runtime configuration read from Vite environment variables (see `client/.env.example`).
 * Only variables prefixed with `VITE_` are exposed to the browser.
 */

/** Base URL of the Deno API (no trailing slash). */
export const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8000").replace(
  /\/+$/,
  "",
);

/** Google OAuth client id used by the SSO button. Empty when not configured. */
export const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID ?? "";