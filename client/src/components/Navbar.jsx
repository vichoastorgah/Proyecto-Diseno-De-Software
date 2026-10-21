import { useContext, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { LanguageContext } from "../context/LanguageContext";

const NAV_ITEMS = [
  { path: "/admin", labelKey: "nav.admin" },
  { path: "/survey", labelKey: "nav.survey" },
  { path: "/vote", labelKey: "nav.vote" },
];

function Navbar() {
  const { t, language, toggleLanguage } = useContext(LanguageContext);
  const location = useLocation();

  // Collapse state handled in React so Bootstrap's JS bundle is not required
  const [isOpen, setIsOpen] = useState(false);

  const closeMenu = () => setIsOpen(false);

  return (
    <nav className="navbar navbar-expand-lg navbar-dark bg-dark">
      <div className="container">
        <Link className="navbar-brand" to="/vote" onClick={closeMenu}>
          {t("nav.brand")}
        </Link>

        <button
          type="button"
          className="navbar-toggler"
          aria-controls="main-navbar"
          aria-expanded={isOpen}
          aria-label={t("nav.toggleMenu")}
          onClick={() => setIsOpen((prev) => !prev)}
        >
          <span className="navbar-toggler-icon"></span>
        </button>

        <div
          className={`collapse navbar-collapse ${isOpen ? "show" : ""}`}
          id="main-navbar"
        >
          <ul className="navbar-nav me-auto mb-2 mb-lg-0">
            {NAV_ITEMS.map((item) => (
              <li className="nav-item" key={item.path}>
                <Link
                  className={`nav-link ${
                    location.pathname === item.path ? "active" : ""
                  }`}
                  to={item.path}
                  onClick={closeMenu}
                >
                  {t(item.labelKey)}
                </Link>
              </li>
            ))}
          </ul>

          <button
            type="button"
            className="btn btn-outline-light btn-sm w-100 w-lg-auto"
            onClick={toggleLanguage}
            aria-label={t("nav.toggleLanguage")}
            title={t("nav.toggleLanguage")}
          >
            🌐{" "}
            <span className={language === "en" ? "fw-bold" : "opacity-50"}>
              EN
            </span>
            {" / "}
            <span className={language === "es" ? "fw-bold" : "opacity-50"}>
              ES
            </span>
          </button>
        </div>
      </div>
    </nav>
  );
}

export default Navbar;