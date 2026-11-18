/**
 * @module services/authService
 * Google SSO and session tokens, with two roles.
 *
 * Flow:
 * 1. The React app obtains a Google ID token through `@react-oauth/google` and POSTs it to
 *    `/api/auth/google`.
 * 2. The token signature is checked against Google's public keys (JWKS), as well as the
 *    issuer, the audience (GOOGLE_CLIENT_ID), the expiry and `email_verified`. The email is
 *    taken ONLY from this verified payload.
 * 3. The server signs its own short-lived session JWT (HS256, 8 hours).
 * 4. Every protected request sends `Authorization: Bearer <session>`; the role is computed
 *    on each request, so removing someone from the configuration takes effect immediately.
 *
 * Roles:
 * - admin: ADMIN_EMAILS / ADMIN_EMAIL_DOMAINS. When both are empty, ALLOWED_EMAILS /
 *   ALLOWED_EMAIL_DOMAINS are the admins (backwards compatible). When every list is empty,
 *   every verified account is admin (local development only; a warning is printed).
 * - participant: any other verified account that is allowed (ALLOWED_* lists) or that takes
 *   part in a survey (recipient, owner or delegate). Participants only reach their surveys.
 */
import { createRemoteJWKSet, jwtVerify, SignJWT } from "jose";
import { AppError } from "../errors.ts";
import type { AppConfig } from "../config.ts";

const GOOGLE_JWKS_URL = new URL("https://www.googleapis.com/oauth2/v3/certs");
const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];
const SESSION_ISSUER = "voting-survey-system";
export const SESSION_TTL_SECONDS = 8 * 60 * 60;
const MIN_SECRET_LENGTH = 32;

/** Identity proven by Google. */
export interface VerifiedIdentity {
  email: string;
  name: string;
  picture?: string;
}

/** Identity plus role, resolved on every request. */
export interface SessionUser extends VerifiedIdentity {
  isAdmin: boolean;
}

export interface SessionGrant {
  user: SessionUser;
  token: string;
  expiresAt: string;
}

/** Verifies a Google ID token and returns its payload (replaceable in tests). */
export type GoogleTokenVerifier = (credential: string, clientId: string) => Promise<Record<string, unknown>>;

export interface AuthService {
  signInWithGoogle(credential: string): Promise<SessionGrant>;
  issueSession(identity: VerifiedIdentity, ttlSeconds?: number): Promise<SessionGrant>;
  getSessionUser(authorizationHeader: string | null): Promise<SessionUser | null>;
  isAdmin(email: string): boolean;
  /** True when no allow-list is configured (every account is admin). */
  readonly openMode: boolean;
}

let googleKeys: ReturnType<typeof createRemoteJWKSet> | null = null;

/** Default verifier: Google's JWKS (keys are cached and refreshed by `jose`). */
const verifyWithGoogle: GoogleTokenVerifier = async (credential, clientId) => {
  googleKeys ??= createRemoteJWKSet(GOOGLE_JWKS_URL);
  const { payload } = await jwtVerify(credential, googleKeys, { issuer: GOOGLE_ISSUERS, audience: clientId });
  return payload as Record<string, unknown>;
};

function matches(email: string, emails: readonly string[], domains: readonly string[]): boolean {
  const domain = email.split("@")[1] ?? "";
  return emails.includes(email) || domains.includes(domain);
}

export interface AuthServiceOptions {
  config: AppConfig;
  /** Lets survey participants sign in even when they are not in an allow-list. */
  isSurveyParticipant: (email: string) => boolean;
  verifyGoogleToken?: GoogleTokenVerifier;
}

export function createAuthService(options: AuthServiceOptions): AuthService {
  const { config, isSurveyParticipant } = options;
  const verifyGoogleToken = options.verifyGoogleToken ?? verifyWithGoogle;

  const hasAdminList = config.adminEmails.length > 0 || config.adminDomains.length > 0;
  const hasAllowList = config.allowedEmails.length > 0 || config.allowedDomains.length > 0;
  const openMode = !hasAdminList && !hasAllowList;

  let secret: Uint8Array;
  if (config.sessionSecret.length >= MIN_SECRET_LENGTH) {
    secret = new TextEncoder().encode(config.sessionSecret);
  } else {
    console.warn(
      `[auth] SESSION_SECRET is missing or shorter than ${MIN_SECRET_LENGTH} characters: ` +
        "using a random secret, sessions end when the server restarts.",
    );
    secret = crypto.getRandomValues(new Uint8Array(MIN_SECRET_LENGTH));
  }
  if (openMode) {
    console.warn("[auth] No ADMIN_* or ALLOWED_* list configured: every verified Google account is an administrator.");
  }

  const isAdmin = (email: string): boolean => {
    const normalized = email.trim().toLowerCase();
    if (hasAdminList) return matches(normalized, config.adminEmails, config.adminDomains);
    if (hasAllowList) return matches(normalized, config.allowedEmails, config.allowedDomains);
    return true;
  };

  const canSignIn = (email: string): boolean =>
    openMode || isAdmin(email) || matches(email, config.allowedEmails, config.allowedDomains) ||
    isSurveyParticipant(email);

  const issueSession = async (identity: VerifiedIdentity, ttlSeconds = SESSION_TTL_SECONDS): Promise<SessionGrant> => {
    const expiresAtSeconds = Math.floor(Date.now() / 1000) + ttlSeconds;
    const token = await new SignJWT({ name: identity.name, picture: identity.picture })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(identity.email)
      .setIssuer(SESSION_ISSUER)
      .setIssuedAt()
      .setExpirationTime(expiresAtSeconds)
      .sign(secret);
    return {
      user: { ...identity, isAdmin: isAdmin(identity.email) },
      token,
      expiresAt: new Date(expiresAtSeconds * 1000).toISOString(),
    };
  };

  return {
    openMode,
    isAdmin,
    issueSession,

    async signInWithGoogle(credential) {
      if (!config.googleClientId) {
        throw new AppError(500, "SSO_NOT_CONFIGURED", "GOOGLE_CLIENT_ID is not configured.");
      }
      let payload: Record<string, unknown>;
      try {
        payload = await verifyGoogleToken(credential, config.googleClientId);
      } catch {
        throw new AppError(401, "INVALID_CREDENTIAL", "Invalid Google credential.");
      }
      const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
      if (email === "" || payload.email_verified !== true) {
        throw new AppError(401, "INVALID_CREDENTIAL", "The Google account email is not verified.");
      }
      if (!canSignIn(email)) {
        throw new AppError(403, "UNAUTHORIZED_USER", "This account is not authorized.");
      }
      return issueSession({
        email,
        name: typeof payload.name === "string" && payload.name !== "" ? payload.name : email,
        picture: typeof payload.picture === "string" ? payload.picture : undefined,
      });
    },

    async getSessionUser(authorizationHeader) {
      const match = /^Bearer\s+([A-Za-z0-9._-]+)$/.exec(authorizationHeader ?? "");
      if (!match) return null;
      try {
        const { payload } = await jwtVerify(match[1], secret, { issuer: SESSION_ISSUER, algorithms: ["HS256"] });
        const email = typeof payload.sub === "string" ? payload.sub : "";
        if (email === "" || !canSignIn(email)) return null;
        return {
          email,
          name: typeof payload.name === "string" ? payload.name : email,
          picture: typeof payload.picture === "string" ? payload.picture : undefined,
          isAdmin: isAdmin(email),
        };
      } catch {
        return null;
      }
    },
  };
}
