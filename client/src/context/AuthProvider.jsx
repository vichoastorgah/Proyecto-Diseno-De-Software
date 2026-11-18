import { useCallback, useEffect, useMemo, useState } from "react";
import { googleLogout } from "@react-oauth/google";
import { ApiError, apiRequest } from "../api/client";
import { AuthContext } from "./authContext";

/**
 * Session management.
 *
 * Flow: Google returns an ID token -> `loginWithGoogle` sends it to the API, which verifies
 * it and answers with a signed session token. The email and the role always come from the
 * server. The session lives in sessionStorage (closed with the tab) and is re-validated on
 * load through `/api/auth/me`. Any 401 on an authenticated call ends the session and the
 * login page explains that it expired.
 */
const SESSION_KEY = "auth.session";
const ACT_AS_KEY = "auth.actAs";

function readStoredSession() {
  try {
    const session = JSON.parse(window.sessionStorage.getItem(SESSION_KEY) || "null");
    const valid =
      typeof session?.token === "string" &&
      typeof session?.user?.email === "string" &&
      Date.parse(session.expiresAt) > Date.now();
    if (!valid) window.sessionStorage.removeItem(SESSION_KEY);
    return valid ? session : null;
  } catch {
    return null;
  }
}

function writeStorage(key, value) {
  try {
    if (value) window.sessionStorage.setItem(key, typeof value === "string" ? value : JSON.stringify(value));
    else window.sessionStorage.removeItem(key);
  } catch {
    // Storage unavailable: the in-memory state still works.
  }
}

function readActAs() {
  try {
    return window.sessionStorage.getItem(ACT_AS_KEY) || "";
  } catch {
    return "";
  }
}

export function AuthProvider({ children }) {
  const [session, setSession] = useState(readStoredSession);
  const [demoSurveyIdentity, setDemoSurveyIdentity] = useState(false);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [actAs, setActAsState] = useState(readActAs);

  const endSession = useCallback((expired) => {
    try {
      googleLogout();
    } catch {
      // Google script not loaded: nothing to revoke locally.
    }
    writeStorage(SESSION_KEY, null);
    writeStorage(ACT_AS_KEY, null);
    setSession(null);
    setActAsState("");
    setDemoSurveyIdentity(false);
    setSessionExpired(expired);
  }, []);

  const token = session?.token ?? null;

  /** Authenticated API call. `withActAs` adds the demo impersonation header. */
  const request = useCallback(
    async (path, options = {}) => {
      const { withActAs, ...rest } = options;
      try {
        const impersonate = withActAs && demoSurveyIdentity && actAs ? actAs : undefined;
        return await apiRequest(path, { ...rest, token, actAs: impersonate });
      } catch (error) {
        if (error instanceof ApiError && error.status === 401 && token) endSession(true);
        throw error;
      }
    },
    [token, actAs, demoSurveyIdentity, endSession]
  );

  // Re-validate a restored session and refresh the role and demo flag.
  useEffect(() => {
    if (!token) return undefined;
    const controller = new AbortController();
    apiRequest("/api/auth/me", { token, signal: controller.signal })
      .then((payload) => {
        setDemoSurveyIdentity(Boolean(payload.demoSurveyIdentity));
        setSession((current) => {
          if (!current) return current;
          const next = { ...current, user: payload.user };
          writeStorage(SESSION_KEY, next);
          return next;
        });
      })
      .catch((error) => {
        if (error instanceof ApiError && error.status === 401) endSession(true);
      });
    return () => controller.abort();
  }, [token, endSession]);

  // End the session exactly when it expires.
  useEffect(() => {
    if (!session?.expiresAt) return undefined;
    const remaining = Date.parse(session.expiresAt) - Date.now();
    const timer = setTimeout(() => endSession(true), Math.max(0, Math.min(remaining, 2 ** 31 - 1)));
    return () => clearTimeout(timer);
  }, [session?.expiresAt, endSession]);

  const loginWithGoogle = useCallback(async (credential) => {
    const payload = await apiRequest("/api/auth/google", { method: "POST", json: { credential } });
    const next = { user: payload.user, token: payload.token, expiresAt: payload.expiresAt };
    writeStorage(SESSION_KEY, next);
    setSessionExpired(false);
    setSession(next);
    return payload.user;
  }, []);

  const logout = useCallback(() => endSession(false), [endSession]);

  const setActAs = useCallback((email) => {
    const value = (email || "").trim().toLowerCase();
    writeStorage(ACT_AS_KEY, value || null);
    setActAsState(value);
  }, []);

  const user = session?.user ?? null;
  const value = useMemo(
    () => ({
      user,
      isAdmin: Boolean(user?.isAdmin),
      demoSurveyIdentity,
      actAs: demoSurveyIdentity ? actAs : "",
      setActAs,
      sessionExpired,
      loginWithGoogle,
      logout,
      request,
    }),
    [user, demoSurveyIdentity, actAs, setActAs, sessionExpired, loginWithGoogle, logout, request]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
