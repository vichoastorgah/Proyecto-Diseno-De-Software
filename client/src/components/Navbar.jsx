import { useState } from "react";
import { Link, NavLink, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { useLanguage } from "../context/LanguageContext";

function Navbar() {
  const { user, logout } = useAuth();
  const { t, language, setLanguage } = useLanguage();
  const navigate = useNavigate();
  const [isOpen, setIsOpen] = useState(false);

  const closeMenu = () => setIsOpen(false);

  const handleLogout = () => {
    logout();
    closeMenu();
    navigate("/login", { replace: true });
  };

  const handleLanguageToggle = () => {
    setLanguage(language === "en" ? "es" : "en");
  };

  const navLinkClass = ({ isActive }) =>
    isActive ? "nav-link active" : "nav-link";

  return (
    <nav className="navbar navbar-expand-lg navbar-dark bg-dark">
      <div className="container">
        <Link className="navbar-brand" to="/" onClick={closeMenu}>
          {t("nav.brand")}
        </Link>

        <button
          className="navbar-toggler"
          type="button"
          aria-controls="mainNavbar"
          aria-expanded={isOpen}
          aria-label="Toggle navigation"
          onClick={() => setIsOpen((previous) => !previous)}
        >
          <span className="navbar-toggler-icon"></span>
        </button>

        <div
          className={`collapse navbar-collapse ${isOpen ? "show" : ""}`}
          id="mainNavbar"
        >
          <ul className="navbar-nav me-auto mb-2 mb-lg-0">
            <li className="nav-item">
              <NavLink className={navLinkClass} to="/" end onClick={closeMenu}>
                {t("nav.home")}
              </NavLink>
            </li>
            {user && (
              <li className="nav-item">
                <NavLink className={navLinkClass} to="/admin" onClick={closeMenu}>
                  {t("nav.admin")}
                </NavLink>
              </li>
            )}
          </ul>

          <div className="d-flex flex-column flex-lg-row align-items-stretch align-items-lg-center gap-2">
            {user && (
              <span className="navbar-text text-white me-lg-2">
                {t("nav.welcome")}, <strong>{user.name}</strong>
              </span>
            )}

            <button
              type="button"
              className="btn btn-outline-light btn-sm"
              onClick={handleLanguageToggle}
            >
              {language === "en" ? "ES" : "EN"}
            </button>

            {user && (
              <button
                type="button"
                className="btn btn-danger btn-sm"
                onClick={handleLogout}
              >
                {t("nav.logout")}
              </button>
            )}
          </div>
        </div>
      </div>
    </nav>
  );
}

export default Navbar;