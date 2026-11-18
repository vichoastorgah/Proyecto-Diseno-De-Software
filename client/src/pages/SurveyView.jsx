import { useCallback, useMemo, useState } from "react";
import { useLocation, useParams } from "react-router-dom";
import { useAuth } from "../context/useAuth";
import { useLanguage } from "../context/useLanguage";
import { useResource } from "../hooks/useResource";
import { EmptyState, ErrorNotice, LoadingState, Notice } from "../components/ui/Feedback";
import { Badge, PageHeader, ProgressBar, Section } from "../components/ui/Layout";
import { Modal } from "../components/ui/Modal";
import DemoIdentityBar from "../components/DemoIdentityBar";
import Icon from "../components/ui/Icon";
import { categoryLabel, formatDateTime, isValidEmail, normalizeEmail } from "../utils/format";

const KNOWN_EMAILS_ID = "survey-known-emails";
const FILTERS = ["all", "mine", "pending", "answered"];
const ROLE_TONES = { admin: "dark", recipient: "primary", participant: "secondary" };

function collectKnownEmails(survey) {
  const emails = new Set([survey.initialRecipient]);
  for (const question of survey.questions) {
    emails.add(question.currentOwner);
    emails.add(question.originalAssignee);
    for (const entry of question.delegationHistory) {
      emails.add(entry.from);
      emails.add(entry.to);
    }
  }
  emails.delete(survey.viewerEmail);
  return [...emails].filter(Boolean).sort();
}

/** Modal used for every delegation (one question, a selection or a whole category). */
function DelegateModal({ target, survey, onClose, onDelegated }) {
  const { request } = useAuth();
  const { t, language } = useLanguage();
  const [email, setEmail] = useState("");
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  if (!target) return null;
  const invalid = !isValidEmail(email);
  const self = normalizeEmail(email) === survey.viewerEmail;

  const submit = async (event) => {
    event?.preventDefault();
    setTouched(true);
    if (invalid || self) return;
    setSaving(true);
    setError(null);
    try {
      const body = { newOwnerEmail: email.trim(), lang: language, ...(target.category ? { category: target.category } : { questionIds: target.questionIds }) };
      const result = await request(`/api/surveys/${survey.id}/delegate`, { method: "POST", json: body, withActAs: true });
      onDelegated(result, email.trim());
    } catch (caught) {
      setError(caught);
      setSaving(false);
    }
  };

  const description = target.category
    ? t("survey.delegate.categoryText", { category: categoryLabel(t, target.category), count: target.count })
    : t("survey.delegate.questionsText", { count: target.questionIds.length });

  return (
    <Modal
      open
      title={t("survey.delegate.title")}
      onClose={onClose}
      busy={saving}
      footer={
        <>
          <button type="button" className="btn btn-outline-secondary" onClick={onClose} disabled={saving}>
            {t("common.cancel")}
          </button>
          <button type="button" className="btn btn-primary" onClick={submit} disabled={saving}>
            {saving && <span className="spinner-border spinner-border-sm me-2" aria-hidden="true" />}
            {t("survey.delegate.submit")}
          </button>
        </>
      }
    >
      <form onSubmit={submit} noValidate>
        <p>{description}</p>
        <Notice variant="info">{t("survey.delegate.rule")}</Notice>
        <label className="form-label" htmlFor="delegate-email">{t("survey.delegate.email")}</label>
        <input
          id="delegate-email"
          type="email"
          data-autofocus
          autoComplete="off"
          list={KNOWN_EMAILS_ID}
          className={`form-control ${touched && (invalid || self) ? "is-invalid" : ""}`}
          value={email}
          placeholder={t("placeholders.colleagueEmail")}
          onChange={(event) => setEmail(event.target.value)}
        />
        <div className="invalid-feedback">{self ? t("survey.delegate.notSelf") : t("survey.delegate.invalidEmail")}</div>
        <ErrorNotice error={error} className="mt-3 mb-0" />
      </form>
    </Modal>
  );
}

function QuestionCard({ question, viewerEmail, selected, onToggleSelect, onDelegate, onAnswered, surveyId, disabled }) {
  const { request } = useAuth();
  const { t, locale } = useLanguage();
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const isMine = question.currentOwner === viewerEmail;
  const answered = question.status === "answered";
  const canAct = isMine && !answered;
  const delegated = question.delegationHistory.length > 0;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const result = await request(`/api/surveys/${surveyId}/questions/${question.id}/answer`, {
        method: "POST",
        json: { answer: draft },
        withActAs: true,
      });
      setDraft("");
      onAnswered(result.survey);
    } catch (caught) {
      setError(caught);
    } finally {
      setSaving(false);
    }
  };

  return (
    <article className={`question-card ${isMine && !answered ? "is-mine" : ""} ${answered ? "is-answered" : ""}`}>
      <div className="d-flex gap-2">
        {canAct && (
          <input
            type="checkbox"
            className="form-check-input mt-1 flex-shrink-0"
            checked={selected}
            onChange={() => onToggleSelect(question.id)}
            aria-label={t("survey.question.select", { code: question.code })}
            disabled={disabled}
          />
        )}
        <div className="min-w-0 flex-grow-1">
          <div className="d-flex flex-wrap align-items-center gap-2 mb-1">
            <span className="question-code">{question.code}</span>
            <Badge tone={answered ? "success" : "warning"} icon={answered ? "check" : "clock"}>
              {answered ? t("survey.question.answered") : t("survey.question.pending")}
            </Badge>
            {delegated && <Badge tone="secondary" icon="forward">{t("survey.question.delegated")}</Badge>}
          </div>
          <h3 className="h6 mb-2 text-break-all">{question.text}</h3>
          <div className="small mb-2 text-break-all">
            <span className="text-body-secondary">{t("survey.question.owner")}: </span>
            <span className="fw-semibold">{isMine ? t("survey.question.you", { email: question.currentOwner }) : question.currentOwner}</span>
          </div>

          {answered && (
            <div className="mb-2">
              <div className="answer-box small">{question.answer}</div>
              <div className="small text-body-secondary mt-1">
                {t("survey.question.answeredBy", { email: question.answeredBy ?? question.currentOwner, date: formatDateTime(question.answeredAt, locale) })}
              </div>
            </div>
          )}

          {canAct && (
            <div className="mb-2">
              <label className="form-label small mb-1" htmlFor={`answer-${question.id}`}>{t("survey.question.answerLabel")}</label>
              <textarea
                id={`answer-${question.id}`}
                className="form-control"
                rows={3}
                maxLength={5000}
                value={draft}
                placeholder={t("survey.question.answerPlaceholder")}
                onChange={(event) => setDraft(event.target.value)}
                disabled={saving || disabled}
              />
              <div className="d-flex flex-wrap gap-2 mt-2">
                <button type="button" className="btn btn-sm btn-primary" onClick={save} disabled={saving || disabled || !draft.trim()}>
                  {saving ? <span className="spinner-border spinner-border-sm me-1" aria-hidden="true" /> : <Icon name="check" size={16} className="me-1" />}
                  {t("survey.question.save")}
                </button>
                <button type="button" className="btn btn-sm btn-outline-primary" onClick={() => onDelegate([question.id])} disabled={saving || disabled}>
                  <Icon name="forward" size={16} className="me-1" />
                  {t("survey.question.delegate")}
                </button>
              </div>
              <ErrorNotice error={error} className="mt-2 mb-0" onDismiss={() => setError(null)} />
            </div>
          )}

          {!canAct && !answered && (
            <p className="small text-body-secondary mb-2">{t("survey.question.onlyOwner", { email: question.currentOwner })}</p>
          )}

          {delegated && (
            <details className="small">
              <summary className="text-body-secondary">{t("survey.question.history", { count: question.delegationHistory.length })}</summary>
              <ul className="timeline mt-2">
                <li>{t("survey.question.assignedTo", { email: question.originalAssignee })}</li>
                {question.delegationHistory.map((entry, index) => (
                  <li key={`${entry.delegatedAt}-${index}`} className="text-break-all">
                    {t("survey.question.historyEntry", { from: entry.from, to: entry.to, date: formatDateTime(entry.delegatedAt, locale) })}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      </div>
    </article>
  );
}

export default function SurveyView() {
  const { surveyId } = useParams();
  const { request } = useAuth();
  const { t, locale } = useLanguage();
  const location = useLocation();

  const fetchSurvey = useCallback(
    (signal) => request(`/api/surveys/${surveyId}`, { signal, withActAs: true }),
    [request, surveyId]
  );
  const { data: survey, error, loading, reload, setData } = useResource(fetchSurvey);

  const [filter, setFilter] = useState("all");
  const [selection, setSelection] = useState(() => new Set());
  const [delegateTarget, setDelegateTarget] = useState(null);
  const [notice, setNotice] = useState(() => (location.state?.created ? { variant: "success", key: "survey.created" } : null));

  const viewerEmail = survey?.viewerEmail ?? "";
  const fullView = survey?.viewerRole === "admin" || survey?.viewerRole === "recipient";

  const visible = useMemo(() => {
    if (!survey) return [];
    return survey.questions.filter((question) => {
      if (filter === "mine") return question.currentOwner === viewerEmail;
      if (filter === "pending") return question.status === "pending";
      if (filter === "answered") return question.status === "answered";
      return true;
    });
  }, [survey, filter, viewerEmail]);

  const groups = useMemo(() => {
    const map = new Map();
    for (const question of visible) {
      if (!map.has(question.category)) map.set(question.category, []);
      map.get(question.category).push(question);
    }
    return [...map.entries()];
  }, [visible]);

  const myPending = survey ? survey.questions.filter((q) => q.currentOwner === viewerEmail && q.status === "pending") : [];
  const knownEmails = useMemo(() => (survey ? collectKnownEmails(survey) : []), [survey]);
  const selectedIds = [...selection].filter((id) => myPending.some((question) => question.id === id));

  const applySurvey = (next) => {
    setData(next);
    setSelection(new Set());
  };

  const toggleSelect = (id) =>
    setSelection((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (loading && !survey) return <LoadingState />;
  if (error && !survey) {
    return (
      <>
        <PageHeader title={t("survey.title")} backTo="/surveys" backLabel={t("surveys.title")} />
        <DemoIdentityBar />
        <ErrorNotice error={error} onRetry={reload} />
      </>
    );
  }

  const progress = survey.progress;

  return (
    <>
      <datalist id={KNOWN_EMAILS_ID}>
        {knownEmails.map((email) => (
          <option key={email} value={email} />
        ))}
      </datalist>

      <PageHeader
        title={survey.title}
        backTo="/surveys"
        backLabel={t("surveys.title")}
        badges={
          <>
            <Badge tone={ROLE_TONES[survey.viewerRole]}>{t(`roles.${survey.viewerRole}`)}</Badge>
            <Badge tone="secondary" icon="user">{t("survey.recipient", { email: survey.initialRecipient })}</Badge>
          </>
        }
        actions={
          <button type="button" className="btn btn-outline-secondary" onClick={reload} disabled={loading}>
            <Icon name="refresh" className="me-1" />
            {t("common.refresh")}
          </button>
        }
      />
      <DemoIdentityBar />

      {notice && (
        <Notice variant={notice.variant} onDismiss={() => setNotice(null)}>
          {t(notice.key, notice.params)}
        </Notice>
      )}
      <ErrorNotice error={error} onRetry={reload} />

      <div className="row g-4">
        <div className="col-12 col-xl-4 order-xl-2">
          <Section title={t("survey.progress.title")} description={t("survey.progress.consolidated")}>
            <div className="d-flex align-items-baseline justify-content-between mb-1">
              <span className="stat-value">{progress.completionPercentage.toLocaleString(locale, { maximumFractionDigits: 1 })}%</span>
              <span className="small text-body-secondary">
                {t("admin.surveys.answeredOf", { answered: progress.answeredQuestions, total: progress.totalQuestions })}
              </span>
            </div>
            <ProgressBar value={progress.completionPercentage} tone="success" label={t("survey.progress.title")} height={10} />

            {/* The server only sends the breakdown to the recipient and admins. */}
            {Object.keys(progress.byCategory).length > 0 && (
              <>
                <h3 className="h6 mt-4 mb-2">{t("survey.progress.byCategory")}</h3>
                <div className="d-grid gap-2">
                  {Object.entries(progress.byCategory).map(([category, item]) => (
                    <div key={category}>
                      <div className="d-flex justify-content-between small">
                        <span>{categoryLabel(t, category)}</span>
                        <span className="text-body-secondary">{item.answered}/{item.total}</span>
                      </div>
                      <ProgressBar value={item.percentage} label={categoryLabel(t, category)} height={6} />
                    </div>
                  ))}
                </div>
              </>
            )}

            {fullView && Object.keys(progress.pendingByOwner).length > 0 && (
              <>
                <h3 className="h6 mt-4 mb-2">{t("survey.progress.pendingByOwner")}</h3>
                <ul className="list-unstyled small mb-0 d-grid gap-1">
                  {Object.entries(progress.pendingByOwner).map(([email, count]) => (
                    <li key={email} className="d-flex justify-content-between gap-2">
                      <span className="text-break-all">{email === viewerEmail ? t("survey.question.you", { email }) : email}</span>
                      <span className="fw-semibold">{count}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </Section>
        </div>

        <div className="col-12 col-xl-8 order-xl-1">
          {survey.hiddenQuestionCount > 0 && (
            <Notice variant="info">{t("survey.restrictedView", { count: survey.hiddenQuestionCount })}</Notice>
          )}
          {myPending.length > 0 && (
            <Notice variant="warning">{t("survey.myPending", { count: myPending.length })}</Notice>
          )}

          <div className="btn-group flex-wrap mb-3" role="group" aria-label={t("survey.filters.label")}>
            {FILTERS.map((key) => (
              <button
                key={key}
                type="button"
                className={`btn btn-sm ${filter === key ? "btn-primary" : "btn-outline-primary"}`}
                aria-pressed={filter === key}
                onClick={() => setFilter(key)}
              >
                {t(`survey.filters.${key}`)}
              </button>
            ))}
          </div>

          {groups.length === 0 && (
            <div className="card app-card">
              <EmptyState icon="list" title={t("survey.noQuestions")} />
            </div>
          )}

          {groups.map(([category, questions]) => {
            const ownedPending = survey.questions.filter(
              (question) => question.category === category && question.status === "pending" && question.currentOwner === viewerEmail
            );
            const stats = progress.byCategory[category];
            return (
              <Section
                key={category}
                title={categoryLabel(t, category)}
                description={stats ? t("survey.categoryProgress", { answered: stats.answered, total: stats.total }) : undefined}
                actions={
                  ownedPending.length > 0 && (
                    <button
                      type="button"
                      className="btn btn-sm btn-outline-primary"
                      onClick={() => setDelegateTarget({ category, count: ownedPending.length })}
                    >
                      <Icon name="forward" size={16} className="me-1" />
                      {t("survey.delegateCategory", { count: ownedPending.length })}
                    </button>
                  )
                }
              >
                <div className="d-grid gap-3">
                  {questions.map((question) => (
                    <QuestionCard
                      key={question.id}
                      question={question}
                      viewerEmail={viewerEmail}
                      surveyId={survey.id}
                      selected={selection.has(question.id)}
                      onToggleSelect={toggleSelect}
                      onDelegate={(questionIds) => setDelegateTarget({ questionIds })}
                      onAnswered={(next) => {
                        applySurvey(next);
                        setNotice({ variant: "success", key: "survey.answerSaved" });
                      }}
                      disabled={Boolean(delegateTarget)}
                    />
                  ))}
                </div>
              </Section>
            );
          })}
        </div>
      </div>

      {selectedIds.length > 0 && (
        <div className="card app-card sticky-toolbar">
          <div className="card-body d-flex flex-column flex-sm-row align-items-sm-center gap-2">
            <span className="flex-grow-1 fw-semibold" aria-live="polite">{t("survey.selected", { count: selectedIds.length })}</span>
            <button type="button" className="btn btn-outline-secondary btn-sm" onClick={() => setSelection(new Set())}>
              {t("survey.clearSelection")}
            </button>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setDelegateTarget({ questionIds: selectedIds })}>
              <Icon name="forward" size={16} className="me-1" />
              {t("survey.delegateSelected")}
            </button>
          </div>
        </div>
      )}

      <DelegateModal
        key={delegateTarget ? JSON.stringify(delegateTarget) : "closed"}
        target={delegateTarget}
        survey={survey}
        onClose={() => setDelegateTarget(null)}
        onDelegated={(result, email) => {
          applySurvey(result.survey);
          setDelegateTarget(null);
          setNotice({ variant: "success", key: "survey.delegated", params: { count: result.transferredQuestionIds.length, email } });
        }}
      />
    </>
  );
}
