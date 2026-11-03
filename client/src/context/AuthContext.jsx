import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { googleLogout } from "@react-oauth/google";
import { API_BASE_URL } from "../config";

/**
 * @typedef {Object} AuthUser
 * @property {string} name     - Display name taken from the verified Google token.
 * @property {string} email    - Email verified by the backend (never typed by the user).
 * @property {string} [picture] - Optional avatar URL.
 */

/**
 * @typedef {Object} AuthSession
 * @property {AuthUser} user      - Authenticated user.
 * @property {string} token       - Backend-issued session token (Bearer).
 * @property {string} expiresAt   - ISO timestamp at which the session expires.
 */

/**
 * @typedef {Object} AuthContextValue
 * @property {AuthUser|null} user                         - Current user, or null when signed out.
 * @property {(credential: string) => Promise<void>} loginWithGoogle - Exchanges a Google ID token for a session.
 * @property {() => void} logout                          - Clears the session.
 * @property {() => Record<string, string>} authHeaders   - Headers to send on protected API calls.
 */

const STORAGE_KEY = "auth.session";

/** Error with a stable `code` that the UI maps to a translated message. */
export class AuthError extends Error {
  /**
   * @param {string} code - Machine-readable reason (e.g. "UNAUTHORIZED_USER", "NETWORK").
   */
  constructor(code) {
    super(code);
    this.name = "AuthError";
    this.code = code;
  }
}

/** @type {import("react").Context<AuthContextValue|null>} */
export const AuthContext = createContext(null);

/** Restores a still-valid session from sessionStorage, or returns null. */
function readStoredSession() {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const session = JSON.parse(raw);
    const isValid =
      typeof session?.token === "string" &&
      typeof session?.user?.email === "string" &&
      Date.parse(session.expiresAt) > Date.now();
    if (!isValid) {
      window.sessionStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return session;
  } catch {
    return null;
  }
}

/** Persists (or clears) the session so a page refresh does not sign the user out. */
function storeSession(session) {
  try {
    if (session) {
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    } else {
      window.sessionStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // Storage can be unavailable; the in-memory session still works.
  }
}

/**
 * Provides authentication state to the whole component tree.
 *
 * Flow: Google returns an ID token -> `loginWithGoogle` sends it to the backend, which
 * verifies it and answers with a signed session token. The user's email always comes
 * from that verified payload.
 *
 * @param {{ children: import("react").ReactNode }} props
 */
export function AuthProvider({ children }) {
  /** @type {[AuthSession|null, Function]} */
  const [session, setSession] = useState(readStoredSession);

  const loginWithGoogle = useCallback(async (credential) => {
    let response;
    try {
      response = await fetch(`${API_BASE_URL}/api/auth/google`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credential }),
      });
    } catch {
      throw new AuthError("NETWORK");
    }

    /** @type {{ code?: string, user?: AuthUser, token?: string, expiresAt?: string }|null} */
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.user || !payload?.token || !payload?.expiresAt) {
      throw new AuthError(payload?.code ?? "UNEXPECTED");
    }

    const nextSession = {
      user: payload.user,
      token: payload.token,
      expiresAt: payload.expiresAt,
    };
    storeSession(nextSession);
    setSession(nextSession);
  }, []);

  const logout = useCallback(() => {
    googleLogout();
    storeSession(null);
    setSession(null);
  }, []);

  const token = session?.token ?? null;
  const authHeaders = useCallback(
    () => (token ? { Authorization: `Bearer ${token}` } : {}),
    [token]
  );

  const value = useMemo(
    () => ({ user: session?.user ?? null, loginWithGoogle, logout, authHeaders }),
    [session, loginWithGoogle, logout, authHeaders]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/**
 * Hook to access the authentication context.
 *
 * @returns {AuthContextValue}
 * @throws {Error} If used outside of an AuthProvider.
 */
export function useAuth() {
  const context = useContext(AuthContext);
  if (context === null) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}

export default AuthContext;