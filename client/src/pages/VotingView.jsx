import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useLanguage } from "../context/LanguageContext";
import { API_BASE_URL } from "../config";

const CONTEXT_URL = `${API_BASE_URL}/api/vote/context`;
const VOTE_URL = `${API_BASE_URL}/api/vote`;

/** Maps backend error codes to translation keys. */
const ERROR_KEY_BY_CODE = {
  INVALID_TOKEN: "voting.errors.invalidToken",
  TOKEN_EXPIRED: "voting.errors.expired",
  ALREADY_VOTED: "voting.errors.alreadyVoted",
  MOTION_NOT_FOUND: "voting.errors.motionNotFound",
  INVALID_OPTION: "voting.errors.invalidOption",
};

/** Errors after which voting is no longer possible with this link. */
const BLOCKING_CODES = new Set([
  "INVALID_TOKEN",
  "TOKEN_EXPIRED",
  "ALREADY_VOTED",
  "MOTION_NOT_FOUND",
]);

/** Reads a JSON body without throwing on empty or invalid payloads. */
async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/** Picks the translation key for a failed response (code first, HTTP status as fallback). */
function errorKeyFor(code, status) {
  if (code && ERROR_KEY_BY_CODE[code]) {
    return ERROR_KEY_BY_CODE[code];
  }
  return status === 404 ? ERROR_KEY_BY_CODE.INVALID_TOKEN : "voting.errors.unexpected";
}

/** Bootstrap button style for an option; unknown options get a neutral style. */
function buttonClassFor(option) {
  switch (option.toLowerCase()) {
    case "approve":
      return "btn-success";
    case "reject":
      return "btn-danger";
    default:
      return "btn-outline-primary";
  }
}

function VotingView() {
  const { t, language } = useLanguage();
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token");

  // loading | ready | voted | blocked | loadFailed
  const [status, setStatus] = useState(token ? "loading" : "blocked");
  const [votingContext, setVotingContext] = useState(null);
  // Stores a translation KEY (not the final text) so the message
  // re-renders correctly if the user switches language afterwards.
  const [errorKey, setErrorKey] = useState(token ? null : "voting.errors.invalidToken");
  const [submittingOption, setSubmittingOption] = useState(null);
  const [reloadCounter, setReloadCounter] = useState(0);

  // Load the motion and voter status behind the link.
  useEffect(() => {
    if (!token) {
      return undefined;
    }

    const controller = new AbortController();

    async function loadContext() {
      try {
        const response = await fetch(`${CONTEXT_URL}?token=${encodeURIComponent(token)}`, {
          signal: controller.signal,
        });
        const payload = await readJson(response);

        if (!response.ok || !payload?.motion) {
          setErrorKey(errorKeyFor(payload?.code, response.status));
          setStatus("blocked");
          return;
        }

        setVotingContext(payload);
        if (payload.voter.hasVoted) {
          setErrorKey("voting.errors.alreadyVoted");
          setStatus("blocked");
        } else if (payload.voter.isExpired) {
          setErrorKey("voting.errors.expired");
          setStatus("blocked");
        } else {
          setErrorKey(null);
          setStatus("ready");
        }
      } catch (error) {
        if (error.name === "AbortError") {
          return;
        }
        setErrorKey("voting.errors.network");
        setStatus("loadFailed");
      }
    }

    loadContext();
    return () => controller.abort();
  }, [token, reloadCounter]);

  const handleRetry = useCallback(() => {
    setStatus("loading");
    setErrorKey(null);
    setReloadCounter((count) => count + 1);
  }, []);

  const handleVote = async (option) => {
    if (status !== "ready" || submittingOption !== null || !votingContext) {
      return;
    }

    setSubmittingOption(option);
    setErrorKey(null);

    try {
      const response = await fetch(VOTE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          motionId: votingContext.motion.id,
          choice: option,
        }),
      });

      if (response.ok) {
        setStatus("voted");
        return;
      }

      const payload = await readJson(response);
      setErrorKey(errorKeyFor(payload?.code, response.status));
      if (BLOCKING_CODES.has(payload?.code)) {
        setStatus("blocked");
      }
    } catch {
      setErrorKey("voting.errors.network");
    } finally {
      setSubmittingOption(null);
    }
  };

  /** Translates a known option (approve/reject/abstain); custom options are shown as typed. */
  const optionLabel = (option) => {
    const key = `voting.options.${option.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
    const translated = t(key);
    return translated === key ? option : translated;
  };

  const motion = votingContext?.motion ?? null;
  const voter = votingContext?.voter ?? null;
  const expiryDate = voter?.tokenExpiresAt
    ? new Date(voter.tokenExpiresAt).toLocaleString(language)
    : null;
  const isSubmitting = submittingOption !== null;

  return (
    <div className="container py-4 py-md-5">
      <div className="row justify-content-center">
        <div className="col-12 col-md-8 col-lg-6">
          <div className="card shadow-sm">
            <div className="card-header text-center">
              <h2 className="h5 mb-0">{t("voting.ballotTitle")}</h2>
            </div>

            <div className="card-body p-4">
              {status === "loading" && (
                <div className="text-center text-muted" role="status">
                  <span
                    className="spinner-border spinner-border-sm me-2"
                    aria-hidden="true"
                  ></span>
                  {t("voting.loading")}
                </div>
              )}

              {motion && (
                <div className="text-center mb-4">
                  {voter?.name && <p className="text-muted mb-2">{t("voting.greeting", { name: voter.name })}</p>}
                  <h1 className="h4 mb-3">{motion.title}</h1>
                  {motion.description && (
                    <p className="text-start mb-0" style={{ whiteSpace: "pre-line" }}>
                      {motion.description}
                    </p>
                  )}
                </div>
              )}

              {status === "voted" && (
                <div className="alert alert-success text-center" role="alert">
                  {t("voting.success")}
                </div>
              )}

              {errorKey && (
                <div
                  className={`alert ${status === "blocked" ? "alert-warning" : "alert-danger"} text-center`}
                  role="alert"
                >
                  {t(errorKey)}
                </div>
              )}

              {status === "loadFailed" && (
                <div className="text-center">
                  <button type="button" className="btn btn-primary" onClick={handleRetry}>
                    {t("voting.retry")}
                  </button>
                </div>
              )}

              {status === "ready" && motion && (
                <>
                  <p className="small text-muted text-center">{t("voting.chooseOption")}</p>
                  <div className="d-grid gap-3 col-12 col-sm-10 mx-auto">
                    {motion.options.map((option) => (
                      <button
                        key={option}
                        type="button"
                        className={`btn btn-lg ${buttonClassFor(option)}`}
                        onClick={() => handleVote(option)}
                        disabled={isSubmitting}
                      >
                        {submittingOption === option ? (
                          <>
                            <span
                              className="spinner-border spinner-border-sm me-2"
                              role="status"
                              aria-hidden="true"
                            ></span>
                            {t("voting.sending")}
                          </>
                        ) : (
                          optionLabel(option)
                        )}
                      </button>
                    ))}
                  </div>
                  {expiryDate && (
                    <p className="small text-muted text-center mt-3 mb-0">
                      {t("voting.validUntil", { date: expiryDate })}
                    </p>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default VotingView;