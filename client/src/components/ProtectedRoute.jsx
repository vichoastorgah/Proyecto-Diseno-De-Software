import { Navigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";

/**
 * Guards a route behind authentication.
 * Redirects to /login when there is no authenticated user.
 *
 * @param {{ children: import("react").ReactNode }} props
 */
function ProtectedRoute({ children }) {
  const { user } = useAuth();

  if (!user) {
    return <Navigate replace to="/login" />;
  }

  return children;
}

export default ProtectedRoute;