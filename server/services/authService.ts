/**
 * @module services/authService
 * Real Google SSO on the backend.
 *
 * Flow:
 * 1. The React app obtains a Google ID token (`credential`, a signed JWT) through
 *    `@react-oauth/google` and POSTs it to `/api/auth/google`.
 * 2. {@link verifyGoogleCredential} checks the signature against Google's public keys
 *    (JWKS), the issuer, the audience (our `GOOGLE_CLIENT_ID`), the expiry and
 *    `email_verified`. The user's email is taken ONLY from this verified payload.
 * 3. {@link issueSession} signs our own short-lived session JWT (HS256).
 * 4. Protected routes call {@link getSessionUser} with the `Authorization: Bearer`
 *    header. Identity is therefore never taken from the request body.
 *
 * Environment variables:
 * - GOOGLE_CLIENT_ID        OAuth client id (must match the one used by the frontend).
 * - SESSION_SECRET          At least 32 characters. If missing, a random secret is
 *                           generated at startup (sessions die on every restart).
 * - ALLOWED_EMAILS          Optional comma-separated allow-list of emails.
 * - ALLOWED_EMAIL_DOMAINS   Optional comma-separated allow-list of domains (e.g. `uai.cl`).
 *                           When neither allow-list is set, any verified Google account
 *                           is accepted (development convenience only).
 */
import { createRemoteJWKSet, jwtVerify, SignJWT } from "npm:jose@5.9.6";

const GOOGLE_JWKS_URL = new URL("https://www.googleapis.com/oauth2/v3/certs");
const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];
const SESSION_ISSUER = "voting-survey-system";
const SESSION_TTL_SECONDS = 8 * 60 * 60;
const MIN_SECRET_LENGTH = 32;

/** Machine-readable failure reasons returned to the client. */
export type AuthErrorCode =
  | "SSO_NOT_CONFIGURED"
  | "INVALID_CREDENTIAL"
  | "UNAUTHORIZED_USER";

/** Error carrying the HTTP status and a stable code for the client. */
export class AuthServiceError extends Error {
  readonly status: number;
  readonly code: AuthErrorCode;

  constructor(status: number, code: AuthErrorCode, message: string) {
    super(message);
    this.name = "AuthServiceError";
    this.status = status;
    this.code = code;
  }
}

/** Authenticated user derived from a verified token. */
export interface SessionUser {
  name: string;
  email: string;
  picture?: string;
}

/** Result of a successful login. */
export interface SessionGrant {
  user: SessionUser;
  token: string;
  /** ISO timestamp at which the session token expires. */
  expiresAt: string;
}

let googleKeys: ReturnType<typeof createRemoteJWKSet> | null = null;
let sessionSecret: Uint8Array | null = null;

/** Lazily creates the remote key set (keys are cached and refreshed by `jose`). */
function getGoogleKeys(): ReturnType<typeof createRemoteJWKSet> {
  googleKeys ??= createRemoteJWKSet(GOOGLE_JWKS_URL);
  return googleKeys;
}

/** Returns the HMAC secret, generating an ephemeral one if none is configured. */
function getSessionSecret(): Uint8Array {
  if (sessionSecret) return sessionSecret;

  const configured = Deno.env.get("SESSION_SECRET");
  if (configured && configured.length >= MIN_SECRET_LENGTH) {
    sessionSecret = new TextEncoder().encode(configured);
  } else {
    console.warn(
      `[auth] SESSION_SECRET is missing or shorter than ${MIN_SECRET_LENGTH} characters. ` +
        "Using a random ephemeral secret: sessions will be invalidated on restart.",
    );
    sessionSecret = crypto.getRandomValues(new Uint8Array(MIN_SECRET_LENGTH));
  }
  return sessionSecret;
}

/** Splits a comma-separated environment variable into trimmed, lower-cased items. */
function readList(name: string): string[] {
  return (Deno.env.get(name) ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item !== "");
}

/**
 * Checks the optional allow-lists. With no allow-list configured every verified
 * account is accepted.
 */
export function isAuthorizedEmail(email: string): boolean {
  const normalized = email.trim().toLowerCase();
  const emails = readList("ALLOWED_EMAILS");
  const domains = readList("ALLOWED_EMAIL_DOMAINS");
  if (emails.length === 0 && domains.length === 0) return true;
  if (emails.includes(normalized)) return true;
  const domain = normalized.split("@")[1] ?? "";
  return domains.includes(domain);
}

/**
 * Verifies a Google ID token and returns the user it identifies.
 *
 * @param credential The `credential` string returned by Google Identity Services.
 * @throws {AuthServiceError} 500 SSO_NOT_CONFIGURED, 401 INVALID_CREDENTIAL,
 *         403 UNAUTHORIZED_USER.
 */
export async function verifyGoogleCredential(credential: string): Promise<SessionUser> {
  const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
  if (!clientId) {
    throw new AuthServiceError(500, "SSO_NOT_CONFIGURED", "GOOGLE_CLIENT_ID is not configured.");
  }

  let payload: Record<string, unknown>;
  try {
    const verified = await jwtVerify(credential, getGoogleKeys(), {
      issuer: GOOGLE_ISSUERS,
      audience: clientId,
    });
    payload = verified.payload as Record<string, unknown>;
  } catch {
    throw new AuthServiceError(401, "INVALID_CREDENTIAL", "Invalid Google credential.");
  }

  const email = typeof payload.email === "string" ? payload.email.toLowerCase() : "";
  if (email === "" || payload.email_verified !== true) {
    throw new AuthServiceError(401, "INVALID_CREDENTIAL", "Google account email is not verified.");
  }
  if (!isAuthorizedEmail(email)) {
    throw new AuthServiceError(403, "UNAUTHORIZED_USER", "This account is not authorized.");
  }

  return {
    name: typeof payload.name === "string" && payload.name !== "" ? payload.name : email,
    email,
    picture: typeof payload.picture === "string" ? payload.picture : undefined,
  };
}

/** Signs a session token for an already verified user. */
export async function issueSession(user: SessionUser): Promise<SessionGrant> {
  const expiresAtSeconds = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const token = await new SignJWT({ name: user.name, picture: user.picture })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.email)
    .setIssuer(SESSION_ISSUER)
    .setIssuedAt()
    .setExpirationTime(expiresAtSeconds)
    .sign(getSessionSecret());

  return { user, token, expiresAt: new Date(expiresAtSeconds * 1000).toISOString() };
}

/**
 * Resolves the user behind an `Authorization: Bearer <token>` header.
 *
 * @returns The user, or `null` when the header is missing, malformed, expired,
 *          tampered with, or the user is no longer authorized.
 */
export async function getSessionUser(
  authorizationHeader: string | null,
): Promise<SessionUser | null> {
  const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader ?? "");
  if (!match) return null;

  try {
    const { payload } = await jwtVerify(match[1], getSessionSecret(), {
      issuer: SESSION_ISSUER,
      algorithms: ["HS256"],
    });
    const email = typeof payload.sub === "string" ? payload.sub : "";
    if (email === "" || !isAuthorizedEmail(email)) return null;
    return {
      name: typeof payload.name === "string" ? payload.name : email,
      email,
      picture: typeof payload.picture === "string" ? payload.picture : undefined,
    };
  } catch {
    return null;
  }
}