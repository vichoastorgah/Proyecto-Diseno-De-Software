import { createContext, useCallback, useContext, useMemo, useState } from "react";

/**
 * @typedef {Object} AuthUser
 * @property {string} name  - Display name of the authenticated user.
 * @property {string} email - Email address returned by the identity provider.
 */

/**
 * @typedef {Object} AuthContextValue
 * @property {AuthUser|null} user               - Current user, or null when signed out.
 * @property {(userData: AuthUser) => void} login - Stores the authenticated user.
 * @property {() => void} logout                - Clears the authenticated user.
 */

/** @type {import("react").Context<AuthContextValue|null>} */
const AuthContext = createContext(null);

/**
 * Provides authentication state to the whole component tree.
 * The user is null by default (signed out).
 *
 * @param {{ children: import("react").ReactNode }} props
 */
export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);

  const login = useCallback((userData) => {
    setUser(userData);
  }, []);

  const logout = useCallback(() => {
    setUser(null);
  }, []);

  const value = useMemo(() => ({ user, login, logout }), [user, login, logout]);

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