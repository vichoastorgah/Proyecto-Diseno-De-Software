import { useEffect } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { useLanguage } from "../context/useLanguage";
import Navbar from "./Navbar";

/** Shell shared by every page: skip link, navbar, main content and footer. */
export default function AppLayout() {
  const { t } = useLanguage();
  const location = useLocation();

  // Move focus to the page title after navigation (screen readers announce the new page).
  useEffect(() => {
    const heading = document.querySelector("main h1");
    if (heading) heading.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }, [location.pathname]);

  return (
    <>
      <a href="#main-content" className="visually-hidden-focusable position-absolute top-0 start-0 m-2 btn btn-light btn-sm">
        {t("nav.skipToContent")}
      </a>
      <Navbar />
      <main id="main-content" className="app-main">
        <div className="container-xl py-4 py-md-5">
          <Outlet />
        </div>
      </main>
      <footer className="app-footer border-top py-3">
        <div className="container-xl d-flex flex-column flex-sm-row justify-content-between gap-1">
          <span>{t("footer.product")}</span>
          <span>{t("footer.course")}</span>
        </div>
      </footer>
    </>
  );
}
