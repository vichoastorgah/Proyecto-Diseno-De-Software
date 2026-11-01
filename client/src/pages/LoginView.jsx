import { useEffect, useRef, useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { useLanguage } from "../context/LanguageContext";

/** Simulated OAuth redirect delay in milliseconds. */
const MOCK_SSO_DELAY_MS = 1000;

/** Mock identity returned by the simulated Google Identity provider. */
const MOCK_SSO_USER = Object.freeze({
  name: "Admin",
  email: "admin@uai.cl",
});

function LoginView() {
  const { user, login } = useAuth();
  const { t } = useLanguage();
  const navigate = useNavigate();
  const [isLoading, setIsLoading] = useState(false);
  const timeoutRef = useRef(null);

  // Clear the pending timer if the component unmounts mid-"redirect".
  useEffect(() => {
    return () => {
      if (timeoutRef.current !== null) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  // Already authenticated users do not need to see the login screen.
  if (user) {
    return <Navigate replace to="/admin" />;
  }

  const handleSsoLogin = () => {
    if (isLoading) {
      return;
    }
    setIsLoading(true);

    timeoutRef.current = setTimeout(() => {
      timeoutRef.current = null;
      login({ ...MOCK_SSO_USER });
      navigate("/admin", { replace: true });
    }, MOCK_SSO_DELAY_MS);
  };

  return (
    <div className="container py-5">
      <div className="row justify-content-center">
        <div className="col-12 col-sm-10 col-md-8 col-lg-5 col-xl-4">
          <div className="card shadow-sm border-0">
            <div className="card-body p-4 p-md-5 text-center">
              <h1 className="h3 fw-bold mb-2">{t("login.title")}</h1>
              <p className="text-muted mb-4">{t("login.subtitle")}</p>

              <button
                type="button"
                className="btn btn-primary btn-lg w-100 d-flex align-items-center justify-content-center gap-2"
                onClick={handleSsoLogin}
                disabled={isLoading}
              >
                {isLoading ? (
                  <>
                    <span
                      className="spinner-border spinner-border-sm"
                      role="status"
                      aria-hidden="true"
                    ></span>
                    <span>{t("login.signingIn")}</span>
                  </>
                ) : (
                  <>
                    <i className="bi bi-google" aria-hidden="true"></i>
                    <span>{t("login.googleButton")}</span>
                  </>
                )}
              </button>

              <p className="small text-muted mt-4 mb-0">{t("login.mockNotice")}</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default LoginView;