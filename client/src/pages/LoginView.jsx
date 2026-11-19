import { useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { GoogleLogin, GoogleOAuthProvider } from "@react-oauth/google";
import { useAuth } from "../context/useAuth";
import { useLanguage } from "../context/useLanguage";
import { GOOGLE_CLIENT_ID } from "../config";
import { apiRequest } from "../api/client";
import { useResource } from "../hooks/useResource";
import { ErrorNotice, LoadingState, Notice } from "../components/ui/Feedback";
import Icon from "../components/ui/Icon";

const FEATURES = ["login.features.elections", "login.features.weighted", "login.features.surveys", "login.features.security"];

/**
 * Google OAuth client id: from the build (VITE_GOOGLE_CLIENT_ID, local development) or, when the
 * same image serves every environment, from the API at runtime (`/api/config`, public value).
 */
function fetchGoogleClientId(signal) {
  if (GOOGLE_CLIENT_ID) return Promise.resolve(GOOGLE_CLIENT_ID);
  return apiRequest("/api/config", { signal }).then((config) => config.googleClientId || "");
}

/** Google SSO sign-in. Identity and role are decided by the server. */
export default function LoginView() {
  const { user, isAdmin, loginWithGoogle, sessionExpired } = useAuth();
  const { t, language } = useLanguage();
  const navigate = useNavigate();
  const location = useLocation();
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState(null);
  const [googleFailed, setGoogleFailed] = useState(false);
  const { data: clientId, error: configError, loading: loadingConfig, reload: reloadConfig } = useResource(fetchGoogleClientId);

  const target = location.state?.from;
  if (user) return <Navigate replace to={target || (isAdmin ? "/admin" : "/surveys")} />;

  const handleSuccess = async ({ credential }) => {
    if (!credential) {
      setGoogleFailed(true);
      return;
    }
    setError(null);
    setGoogleFailed(false);
    setSigningIn(true);
    try {
      const signedIn = await loginWithGoogle(credential);
      navigate(target || (signedIn.isAdmin ? "/admin" : "/surveys"), { replace: true });
    } catch (caught) {
      setError(caught);
      setSigningIn(false);
    }
  };

  return (
    <div className="login-shell">
      <div className="row g-0 w-100 justify-content-center">
        <div className="col-12 col-lg-10 col-xl-9">
          <div className="card app-card overflow-hidden">
            <div className="row g-0">
              <aside className="col-lg-6 login-aside p-4 p-md-5">
                <span className="brand-mark mb-3" style={{ width: "2.75rem", height: "2.75rem" }}>
                  <Icon name="ballot" size={24} />
                </span>
                <h1 className="h3 fw-bold mb-2" tabIndex={-1}>
                  {t("nav.brand")}
                </h1>
                <p className="opacity-75 mb-4">{t("login.tagline")}</p>
                <ul className="list-unstyled mb-0">
                  {FEATURES.map((key) => (
                    <li key={key} className="d-flex gap-2">
                      <Icon name="check" className="mt-1" />
                      <span>{t(key)}</span>
                    </li>
                  ))}
                </ul>
              </aside>

              <div className="col-lg-6 p-4 p-md-5 d-flex flex-column justify-content-center">
                <h2 className="h4 fw-semibold mb-1">{t("login.title")}</h2>
                <p className="text-body-secondary mb-4">{t("login.subtitle")}</p>

                {sessionExpired && !error && <Notice variant="warning">{t("login.sessionExpired")}</Notice>}
                {!loadingConfig && !configError && !clientId && <Notice variant="danger">{t("login.missingClientId")}</Notice>}
                <ErrorNotice error={configError} onRetry={reloadConfig} />
                {googleFailed && <Notice variant="danger">{t("login.googleFailed")}</Notice>}
                <ErrorNotice error={error} />

                {loadingConfig && !clientId && <LoadingState compact />}
                {signingIn ? (
                  <div className="d-flex align-items-center gap-2 py-2" role="status">
                    <span className="spinner-border spinner-border-sm" aria-hidden="true" />
                    {t("login.signingIn")}
                  </div>
                ) : (
                  clientId && (
                    <GoogleOAuthProvider clientId={clientId}>
                      <div className="d-flex">
                        <GoogleLogin
                          onSuccess={handleSuccess}
                          onError={() => setGoogleFailed(true)}
                          locale={language}
                          text="signin_with"
                          shape="rectangular"
                          width="280"
                        />
                      </div>
                    </GoogleOAuthProvider>
                  )
                )}

                <p className="small text-body-secondary mt-4 mb-0 d-flex gap-2">
                  <Icon name="shield" className="mt-1" />
                  <span>{t("login.ssoNotice")}</span>
                </p>
                <p className="small text-body-secondary mt-2 mb-0 d-flex gap-2">
                  <Icon name="mail" className="mt-1" />
                  <span>{t("login.votersNotice")}</span>
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
