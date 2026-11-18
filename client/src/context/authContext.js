import { createContext } from "react";

/**
 * Authentication context. Value shape (see AuthProvider):
 * `{ user, isAdmin, demoSurveyIdentity, actAs, setActAs, sessionExpired,
 *    loginWithGoogle, logout, request }`.
 */
export const AuthContext = createContext(null);
