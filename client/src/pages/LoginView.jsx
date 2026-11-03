import { useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { GoogleLogin, GoogleOAuthProvider } from "@react-oauth/google";
import { AuthError, useAuth } from "../context/AuthContext";
import { useLanguage } from "../context/LanguageContext";
import { GOOGLE_CLIENT_ID } from "../config";

/** Maps backend error codes to translation keys. */
const ERROR_KEY_BY_CODE = {
  SSO_NOT_CONFIGURED: "login.errors.notConfigured",
  INVALID_CREDENTIAL: "login.errors.invalidCredential",
  UNAUTHORIZED_USER: "login.errors.notAuthorized",
  NETWORK: "login.errors.network",
};

function LoginView() {
  const { user, loginWithGoogle } = useAuth();
  const { t, language } = useLanguage();
  const navigate = useNavigate();
  const [isSigningIn, setIsSigningIn] = useState(false);
  // Holds a translation KEY so the message follows the language switch.
  const [errorKey, setErrorKey] = useState(
    GOOGLE_CLIENT_ID ? null : "login.errors.missingClientId"
  );

  // Already authenticated users do not need to see the login screen.
  if (user) {
    return <Navigate replace to="/admin" />;
  }

  const handleGoogleSuccess = async (credentialResponse) => {
    if (!credentialResponse.credential) {
      setErrorKey("login.errors.googleFailed");
      return;
    }

    setErrorKey(null);
    setIsSigningIn(true);
    try {
      await loginWithGoogle(credentialResponse.credential);
      navigate("/admin", { replace: true });
    } catch (error) {
      const code = error instanceof AuthError ? error.code : "UNEXPECTED";
      setErrorKey(ERROR_KEY_BY_CODE[code] ?? "login.errors.unexpected");
      setIsSigningIn(false);
    }
  };

  return (
    <div className="container py-5">
      <div className="row justify-content-center">
        <div className="col-12 col-sm-10 col-md-8 col-lg-5 col-xl-4">
          <div className="card shadow-sm border-0">
            <div className="card-body p-4 p-md-5 text-center">
              <h1 className="h3 fw-bold mb-2">{t("login.title")}</h1>
              <p className="text-muted mb-4">{t("login.subtitle")}</p>

              {errorKey && (
                <div className="alert alert-danger" role="alert">
                  {t(errorKey)}
                </div>
              )}

              {isSigningIn && (
                <div className="d-flex align-items-center justify-content-center gap-2">
                  <span
                    className="spinner-border spinner-border-sm"
                    role="status"
                    aria-hidden="true"
                  ></span>
                  <span>{t("login.signingIn")}</span>
                </div>
              )}

              {GOOGLE_CLIENT_ID && !isSigningIn && (
                <GoogleOAuthProvider clientId={GOOGLE_CLIENT_ID}>
                  <div className="d-flex justify-content-center">
                    <GoogleLogin
                      onSuccess={handleGoogleSuccess}
                      onError={() => setErrorKey("login.errors.googleFailed")}
                      locale={language}
                      text="signin_with"
                      shape="rectangular"
                      width="280"
                    />
                  </div>
                </GoogleOAuthProvider>
              )}

              <p className="small text-muted mt-4 mb-0">{t("login.ssoNotice")}</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default LoginView;