import { useState } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../context/useAuth";
import { useLanguage } from "../context/useLanguage";
import { initials } from "../utils/format";
import Icon from "./ui/Icon";

export default function Navbar() {
  const { user, isAdmin, logout } = useAuth();
  const { t, language, setLanguage } = useLanguage();
  const navigate = useNavigate();
  const location = useLocation();
  const [isOpen, setIsOpen] = useState(false);


  const handleLogout = () => {
    logout();
    navigate("/login", { replace: true });
  };

  const linkClass = ({ isActive }) => `nav-link d-flex align-items-center gap-2${isActive ? " active" : ""}`;

  return (
    <nav className="navbar navbar-expand-lg navbar-dark app-navbar" aria-label={t("nav.main")}>
      <div className="container-xl">
        <Link className="navbar-brand d-flex align-items-center gap-2" to="/">
          <span className="brand-mark">
            <Icon name="ballot" size={18} />
          </span>
          <span className="d-none d-sm-inline">{t("nav.brand")}</span>
          <span className="d-sm-none">{t("nav.brandShort")}</span>
        </Link>

        <button
          className="navbar-toggler border-0"
          type="button"
          aria-controls="mainNavbar"
          aria-expanded={isOpen}
          aria-label={t("nav.toggleMenu")}
          onClick={() => setIsOpen((open) => !open)}
        >
          <span className="navbar-toggler-icon" />
        </button>

        {/* Clicking any link inside closes the mobile menu. */}
        <div
          className={`collapse navbar-collapse ${isOpen ? "show" : ""}`}
          id="mainNavbar"
          onClick={(event) => {
            if (event.target.closest("a")) setIsOpen(false);
          }}
        >
          <ul className="navbar-nav me-auto mt-3 mt-lg-0 gap-lg-1">
            {isAdmin && (
              <li className="nav-item">
                <NavLink className={linkClass} to="/admin" end>
                  <Icon name="chart" size={16} />
                  {t("nav.dashboard")}
                </NavLink>
              </li>
            )}
            {isAdmin && (
              <li className="nav-item">
                <NavLink className={linkClass} to="/admin/elections/new">
                  <Icon name="ballot" size={16} />
                  {t("nav.newElection")}
                </NavLink>
              </li>
            )}
            {user && (
              <li className="nav-item">
                <NavLink className={linkClass} to="/surveys">
                  <Icon name="survey" size={16} />
                  {t("nav.surveys")}
                </NavLink>
              </li>
            )}
          </ul>

          <div className="d-flex flex-column flex-lg-row align-items-stretch align-items-lg-center gap-2 py-3 py-lg-0">
            <div className="btn-group btn-group-sm" role="group" aria-label={t("nav.language")}>
              {["es", "en"].map((code) => (
                <button
                  key={code}
                  type="button"
                  className={`btn ${language === code ? "btn-light" : "btn-outline-light"}`}
                  aria-pressed={language === code}
                  onClick={() => setLanguage(code)}
                  lang={code}
                >
                  {code.toUpperCase()}
                </button>
              ))}
            </div>

            {user && (
              <div className="d-flex align-items-center gap-2 text-white ms-lg-2">
                <span className="avatar" aria-hidden="true">
                  {user.picture ? <img src={user.picture} alt="" referrerPolicy="no-referrer" /> : initials(user.name)}
                </span>
                <span className="small lh-sm min-w-0">
                  <span className="d-block fw-semibold text-truncate" style={{ maxWidth: "14rem" }}>
                    {user.name}
                  </span>
                  <span className="d-block text-white-50">{isAdmin ? t("roles.admin") : t("roles.participant")}</span>
                </span>
                <button type="button" className="btn btn-sm btn-outline-light ms-auto ms-lg-2" onClick={handleLogout}>
                  <Icon name="logout" size={16} className="me-1" />
                  {t("nav.logout")}
                </button>
              </div>
            )}
            {!user && location.pathname !== "/login" && (
              <Link className="btn btn-sm btn-light" to="/login">
                {t("nav.login")}
              </Link>
            )}
          </div>
        </div>
      </div>
    </nav>
  );
}
