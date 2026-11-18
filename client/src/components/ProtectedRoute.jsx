import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../context/useAuth";
import { useLanguage } from "../context/useLanguage";
import { EmptyState } from "./ui/Feedback";

/**
 * Guards nested routes. Without a session it redirects to /login (remembering the target);
 * with `requireAdmin`, non-admins see a "no access" message. The server enforces the same
 * rules on every endpoint: this guard only improves the experience.
 */
export default function ProtectedRoute({ requireAdmin = false }) {
  const { user, isAdmin } = useAuth();
  const { t } = useLanguage();
  const location = useLocation();

  if (!user) {
    return <Navigate replace to="/login" state={{ from: `${location.pathname}${location.search}` }} />;
  }
  if (requireAdmin && !isAdmin) {
    return (
      <div className="card app-card">
        <EmptyState icon="lock" title={t("errors.noAccessTitle")}>
          {t("errors.noAccessText")}
        </EmptyState>
      </div>
    );
  }
  return <Outlet />;
}
