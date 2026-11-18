import { useCallback, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { ApiError, apiRequest, apiUrl } from "../api/client";
import { useLanguage } from "../context/useLanguage";
import { useResource } from "../hooks/useResource";
import { ErrorNotice, LoadingState, Notice } from "../components/ui/Feedback";
import { ConfirmDialog } from "../components/ui/Modal";
import { ProgressBar } from "../components/ui/Layout";
import Icon from "../components/ui/Icon";
import { formatBytes, formatDateTime, optionLabel } from "../utils/format";

/** Reasons that make the ballot unusable, mapped to their explanation. */
const BLOCKED_REASONS = {
  INVALID_TOKEN: { icon: "alert", title: "voting.blocked.invalidTitle", text: "voting.blocked.invalidText" },
  ALREADY_VOTED: { icon: "check", title: "voting.blocked.votedTitle", text: "voting.blocked.votedText" },
  TOKEN_EXPIRED: { icon: "clock", title: "voting.blocked.expiredTitle", text: "voting.blocked.expiredText" },
  ELECTION_CLOSED: { icon: "lock", title: "voting.blocked.closedTitle", text: "voting.blocked.closedText" },
};

function BlockedState({ reason }) {
  const { t } = useLanguage();
  const info = BLOCKED_REASONS[reason] ?? BLOCKED_REASONS.INVALID_TOKEN;
  return (
    <div className="text-center py-4">
      <div className="empty-state-icon mx-auto mb-3">
        <Icon name={info.icon} size={26} />
      </div>
      <h2 className="h5">{t(info.title)}</h2>
      <p className="text-body-secondary mb-0 mx-auto" style={{ maxWidth: "32rem" }}>
        {t(info.text)}
      </p>
    </div>
  );
}

function MotionCard({ motion, index, total, selected, onSelect, disabled }) {
  const { t } = useLanguage();
  const groupName = `motion-${motion.id}`;
  return (
    <fieldset className="card app-card mb-3" disabled={disabled}>
      <div className="card-body">
        <legend className="d-flex align-items-start gap-2 mb-2 fs-6 float-none w-auto">
          <span className="motion-number">{index + 1}</span>
          <span className="min-w-0">
            <span className="d-block small text-body-secondary">{t("voting.motionOf", { index: index + 1, total })}</span>
            <span className="d-block fw-semibold fs-5 text-break-all">{motion.title}</span>
          </span>
        </legend>
        {motion.description && (
          <p className="text-body-secondary mb-3" style={{ whiteSpace: "pre-line" }}>
            {motion.description}
          </p>
        )}
        <div className="d-grid gap-2" role="radiogroup" aria-label={motion.title}>
          {motion.options.map((option) => {
            const isSelected = selected === option;
            return (
              <label key={option} className={`ballot-option ${isSelected ? "selected" : ""}`}>
                <input
                  type="radio"
                  className="form-check-input"
                  name={groupName}
                  value={option}
                  checked={isSelected}
                  onChange={() => onSelect(motion.id, option)}
                />
                <span className="fw-medium text-break-all">{optionLabel(t, option)}</span>
                {isSelected && <Icon name="check" className="ms-auto text-primary" />}
              </label>
            );
          })}
        </div>
      </div>
    </fieldset>
  );
}

export default function VotingView() {
  const { t, locale } = useLanguage();
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token") ?? "";

  const fetchBallot = useCallback(
    (signal) => {
      if (!token) return Promise.reject(new ApiError(404, "INVALID_TOKEN", ""));
      return apiRequest(`/api/vote/context?token=${encodeURIComponent(token)}`, { signal });
    },
    [token]
  );
  const { data: ballot, error: loadError, loading, reload } = useResource(fetchBallot);

  const [choices, setChoices] = useState({});
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(null);
  const [blockedAfterSubmit, setBlockedAfterSubmit] = useState(null);
  const [done, setDone] = useState(false);

  const motions = useMemo(() => ballot?.motions ?? [], [ballot]);
  const answered = motions.filter((motion) => choices[motion.id] !== undefined).length;
  const complete = motions.length > 0 && answered === motions.length;

  const blockedReason = useMemo(() => {
    if (blockedAfterSubmit) return blockedAfterSubmit;
    if (loadError instanceof ApiError && (loadError.status === 404 || loadError.status === 400)) return "INVALID_TOKEN";
    if (!ballot) return null;
    if (ballot.voter.hasVoted) return "ALREADY_VOTED";
    if (ballot.voter.isExpired) return "TOKEN_EXPIRED";
    if (ballot.election.status !== "open") return "ELECTION_CLOSED";
    return null;
  }, [ballot, loadError, blockedAfterSubmit]);

  const selectOption = (motionId, option) => {
    setSubmitError(null);
    setChoices((current) => ({ ...current, [motionId]: option }));
  };

  const submit = async () => {
    setSubmitting(true);
    setSubmitError(null);
    try {
      await apiRequest("/api/vote", { method: "POST", json: { token, choices } });
      setDone(true);
      setConfirming(false);
    } catch (error) {
      setConfirming(false);
      if (error instanceof ApiError && BLOCKED_REASONS[error.code]) setBlockedAfterSubmit(error.code);
      else setSubmitError(error);
    } finally {
      setSubmitting(false);
    }
  };

  const title = ballot?.election.title ?? t("voting.title");

  return (
    <div className="row justify-content-center">
      <div className="col-12 col-lg-9 col-xl-8">
        <header className="mb-4">
          <div className="d-flex align-items-center gap-2 text-body-secondary small mb-2">
            <Icon name="lock" size={16} />
            {t("voting.secureBallot")}
          </div>
          <h1 className="page-title" tabIndex={-1}>
            {title}
          </h1>
          {ballot?.voter.name && !done && !blockedReason && (
            <p className="text-body-secondary mb-0">{t("voting.greeting", { name: ballot.voter.name })}</p>
          )}
        </header>

        {loading && !ballot && <LoadingState label={t("voting.loading")} />}

        {!loading && loadError && !blockedReason && (
          <ErrorNotice error={loadError} onRetry={reload} />
        )}

        {blockedReason && !done && (
          <div className="card app-card">
            <div className="card-body">
              <BlockedState reason={blockedReason} />
            </div>
          </div>
        )}

        {done && (
          <div className="card app-card">
            <div className="card-body text-center py-5">
              <div className="empty-state-icon mx-auto mb-3" style={{ background: "var(--app-success-soft)", color: "#15803d" }}>
                <Icon name="check" size={28} />
              </div>
              <h2 className="h4">{t("voting.successTitle")}</h2>
              <p className="text-body-secondary mb-0">{t("voting.successText", { count: motions.length })}</p>
            </div>
          </div>
        )}

        {ballot && !blockedReason && !done && (
          <>
            {ballot.election.description && (
              <div className="card app-card mb-3">
                <div className="card-body">
                  <p className="mb-0" style={{ whiteSpace: "pre-line" }}>
                    {ballot.election.description}
                  </p>
                </div>
              </div>
            )}

            {ballot.attachments.length > 0 && (
              <div className="card app-card mb-3">
                <div className="card-body">
                  <h2 className="h6 mb-2">{t("voting.documents")}</h2>
                  <ul className="list-unstyled mb-0 d-grid gap-2">
                    {ballot.attachments.map((file) => (
                      <li key={file.id}>
                        <a
                          className="d-inline-flex align-items-center gap-2 text-break-all"
                          href={apiUrl(`/api/vote/attachments/${file.id}?token=${encodeURIComponent(token)}`)}
                          rel="noopener noreferrer"
                        >
                          <Icon name="download" size={16} />
                          {file.name}
                          <span className="text-body-secondary small">({formatBytes(file.size, locale)})</span>
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            )}

            <Notice variant="info">{t("voting.instructions", { count: motions.length })}</Notice>

            {motions.map((motion, index) => (
              <MotionCard
                key={motion.id}
                motion={motion}
                index={index}
                total={motions.length}
                selected={choices[motion.id]}
                onSelect={selectOption}
                disabled={submitting}
              />
            ))}

            <ErrorNotice error={submitError} onDismiss={() => setSubmitError(null)} />

            <div className="card app-card sticky-toolbar">
              {/* Single compact row on every width so the bar never hides much of the ballot. */}
              <div className="card-body d-flex align-items-center gap-3 py-2 py-sm-3">
                <div className="flex-grow-1 min-w-0">
                  <div className="small text-body-secondary mb-1 text-truncate" aria-live="polite">
                    {t("voting.progress", { answered, total: motions.length })}
                  </div>
                  <ProgressBar value={motions.length ? (answered / motions.length) * 100 : 0} label={t("voting.progressLabel")} />
                </div>
                <button
                  type="button"
                  className="btn btn-primary btn-lg-sm text-nowrap flex-shrink-0"
                  disabled={!complete || submitting}
                  onClick={() => setConfirming(true)}
                >
                  {t("voting.review")}
                  <Icon name="arrowRight" className="ms-2" />
                </button>
              </div>
            </div>

            {ballot.voter.tokenExpiresAt && (
              <p className="small text-body-secondary text-center mt-3 mb-0">
                {t("voting.validUntil", { date: formatDateTime(ballot.voter.tokenExpiresAt, locale) })}
              </p>
            )}

            <ConfirmDialog
              open={confirming}
              title={t("voting.confirmTitle")}
              confirmLabel={t("voting.confirm")}
              busy={submitting}
              onCancel={() => setConfirming(false)}
              onConfirm={submit}
            >
              <p>{t("voting.confirmText")}</p>
              <ol className="mb-0 ps-3">
                {motions.map((motion) => (
                  <li key={motion.id} className="mb-2">
                    <div className="small text-body-secondary text-break-all">{motion.title}</div>
                    <div className="fw-semibold">{optionLabel(t, choices[motion.id])}</div>
                  </li>
                ))}
              </ol>
            </ConfirmDialog>
          </>
        )}
      </div>
    </div>
  );
}
