import { useContext } from "react";
import { AuthContext } from "./authContext";

/**
 * Access to the session and to the authenticated API client.
 * @throws {Error} When used outside of an AuthProvider.
 */
export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within an AuthProvider");
  return context;
}
