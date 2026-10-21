import { useCallback, useContext, useEffect, useMemo, useState } from "react";
import { LanguageContext } from "../context/LanguageContext";

const API_BASE = "http://localhost:8000";
const SURVEY_URL = `${API_BASE}/api/survey`;
const ANSWER_URL = `${API_BASE}/api/survey/answer`;
const DELEGATE_URL = `${API_BASE}/api/survey/delegate`;
const KNOWN_EMAILS_LIST_ID = "survey-known-emails";
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------- Helpers ----------

function normalizeEmail(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function isValidEmail(value) {
  return EMAIL_PATTERN.test(normalizeEmail(value));
}

function formatCategory(category) {
  const text = String(category || "uncategorized");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Returns the translated category title when the dictionary has one,
 * otherwise falls back to the capitalized raw category name.
 */
function translateCategory(category, t) {
  const normalized = String(category || "uncategorized").toLowerCase();
  const key = `survey.categories.${normalized}`;
  const translated = t(key);
  return translated === key ? formatCategory(category) : translated;
}

function formatDate(isoString, locale) {
  if (!isoString) return "";
  const date = new Date(isoString);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString(locale);
}

/**
 * Builds an Error that carries a translation key so the message can be
 * rendered in the active language at display time.
 */
function createTranslatableError(key, params) {
  const error = new Error(key);
  error.translationKey = key;
  error.translationParams = params;
  return error;
}

/**
 * Converts any thrown value into a message descriptor:
 * `{ key, params }` for client messages or `{ message }` for server text.
 */
function describeError(err, fallbackKey) {
  if (err && err.translationKey) {
    return { key: err.translationKey, params: err.translationParams || null, message: "" };
  }
  if (err && err.message) {
    return { key: null, params: null, message: err.message };
  }
  return { key: fallbackKey, params: null, message: "" };
}

/** Renders a message descriptor in the active language. */
function renderMessage(t, descriptor) {
  if (!descriptor) return "";
  return descriptor.key ? t(descriptor.key, descriptor.params) : descriptor.message;
}

/** Derives global progress from the question list so the bar can never drift from the data. */
function computeProgress(questions) {
  const total = questions.length;
  const answered = questions.filter((q) => q.status === "answered").length;
  const percentage = total === 0 ? 0 : Math.round((answered / total) * 1000) / 10;
  return { total, answered, pending: total - answered, percentage };
}

/** Groups questions by category, preserving the order in which categories first appear. */
function groupByCategory(questions) {
  const groups = new Map();
  for (const question of questions) {
    const key = String(question.category || "uncategorized").toLowerCase();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(question);
  }
  return Array.from(groups, ([category, items]) => ({ category, items }));
}

/** Collects every email that appears in the survey, for the suggestion lists. */
function collectKnownEmails(survey) {
  const emails = new Set();
  if (survey.initialRecipient) emails.add(normalizeEmail(survey.initialRecipient));
  for (const question of survey.questions) {
    if (question.originalAssignee) emails.add(normalizeEmail(question.originalAssignee));
    if (question.currentOwner) emails.add(normalizeEmail(question.currentOwner));
    for (const entry of question.delegationHistory || []) {
      if (entry.from) emails.add(normalizeEmail(entry.from));
      if (entry.to) emails.add(normalizeEmail(entry.to));
    }
  }
  emails.delete("");
  return Array.from(emails).sort();
}

function isDelegated(question) {
  return (
    (question.delegationHistory || []).length > 0 ||
    normalizeEmail(question.currentOwner) !== normalizeEmail(question.originalAssignee)
  );
}

async function postJson(url, payload) {
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    throw createTranslatableError("errors.network");
  }

  let data = null;
  try {
    data = await response.json();
  } catch {
    // Non-JSON body: fall through to the generic message below.
  }

  if (!response.ok) {
    if (data?.error) {
      throw new Error(data.error);
    }
    throw createTranslatableError("errors.requestFailed", { status: response.status });
  }
  return data;
}

// ---------- Presentational components ----------

function ActiveUserBar({ value, onChange, onRefresh, refreshing }) {
  const { t } = useContext(LanguageContext);
  const invalid = value.trim() !== "" && !isValidEmail(value);

  return (
    <div className="card shadow-sm mb-3 sticky-top" style={{ zIndex: 1020 }}>
      <div className="card-body py-2">
        <div className="row g-2 align-items-end">
          <div className="col-12 col-md">
            <label htmlFor="active-user-email" className="form-label small mb-1">
              {t("survey.activeUser.label")}
            </label>
            <input
              id="active-user-email"
              type="email"
              className={`form-control ${invalid ? "is-invalid" : ""}`}
              list={KNOWN_EMAILS_LIST_ID}
              value={value}
              onChange={(event) => onChange(event.target.value)}
              placeholder={t("survey.activeUser.placeholder")}
              autoComplete="off"
            />
            <div className="invalid-feedback">{t("survey.activeUser.invalid")}</div>
          </div>
          <div className="col-12 col-md-auto">
            <button
              type="button"
              className="btn btn-outline-secondary w-100"
              onClick={onRefresh}
              disabled={refreshing}
            >
              {refreshing ? t("survey.activeUser.refreshing") : t("survey.activeUser.refresh")}
            </button>
          </div>
        </div>
        <div className="form-text mt-1">{t("survey.activeUser.demoNote")}</div>
      </div>
    </div>
  );
}

function GlobalProgress({ progress }) {
  const { t } = useContext(LanguageContext);

  return (
    <div className="card shadow-sm mb-4">
      <div className="card-body">
        <div className="d-flex justify-content-between align-items-baseline mb-2">
          <h2 className="h5 card-title mb-0">{t("survey.progress.title")}</h2>
          <span className="fw-semibold">{progress.percentage}%</span>
        </div>
        <div
          className="progress"
          role="progressbar"
          aria-label={t("survey.progress.ariaLabel")}
          aria-valuenow={progress.percentage}
          aria-valuemin="0"
          aria-valuemax="100"
          style={{ height: "1.5rem" }}
        >
          <div
            className="progress-bar progress-bar-striped bg-success"
            style={{ width: `${progress.percentage}%`, transition: "width 0.4s ease" }}
          />
        </div>
        <p className="text-body-secondary small mb-0 mt-2">
          {t("survey.progress.summary", {
            answered: progress.answered,
            total: progress.total,
            pending: progress.pending,
          })}
        </p>
      </div>
    </div>
  );
}

function QuestionCard({ question, activeEmail, busy, onAnswer, onDelegate }) {
  const { t, language } = useContext(LanguageContext);
  const [answerDraft, setAnswerDraft] = useState("");
  const [delegateTo, setDelegateTo] = useState("");

  const isAnswered = question.status === "answered";
  const isOwner = normalizeEmail(activeEmail) === normalizeEmail(question.currentOwner);
  const canAct = isOwner && !isAnswered;
  const delegated = isDelegated(question);

  const answerValue = isAnswered ? question.answer || "" : answerDraft;
  const canSubmitAnswer = canAct && !busy && answerDraft.trim() !== "";
  const canSubmitDelegation = canAct && !busy && isValidEmail(delegateTo);

  let permissionNote = "";
  if (isAnswered) {
    permissionNote = question.answeredAt
      ? t("survey.question.lockedWithDate", {
          owner: question.currentOwner,
          date: formatDate(question.answeredAt, language),
        })
      : t("survey.question.locked", { owner: question.currentOwner });
  } else if (!isOwner) {
    permissionNote = t("survey.question.onlyOwner", { owner: question.currentOwner });
  }

  const handleAnswer = async () => {
    const saved = await onAnswer(question.id, answerDraft);
    if (saved) setAnswerDraft("");
  };

  const handleDelegate = async () => {
    const transferred = await onDelegate({ questionId: question.id }, delegateTo);
    if (transferred) setDelegateTo("");
  };

  return (
    <div className={`card h-100 shadow-sm ${isOwner && !isAnswered ? "border-primary" : ""}`}>
      <div className="card-body d-flex flex-column">
        <h3 className="h6 card-title">{question.text}</h3>

        <div className="d-flex flex-wrap gap-1 mb-2">
          <span
            className={`badge ${isOwner ? "bg-primary" : "bg-secondary"} text-break text-wrap`}
            title={t("survey.question.ownerTitle")}
          >
            {t("survey.question.owner", { owner: question.currentOwner })}
          </span>
          {delegated && (
            <span className="badge bg-warning text-dark">{t("survey.question.delegated")}</span>
          )}
          <span className={`badge ${isAnswered ? "bg-success" : "bg-light text-dark border"}`}>
            {isAnswered ? t("survey.question.answered") : t("survey.question.pending")}
          </span>
        </div>

        {delegated && (
          <p className="text-body-secondary small mb-2">
            {t("survey.question.originallyAssigned", { assignee: question.originalAssignee })}
          </p>
        )}

        <div className="mb-3">
          <label htmlFor={`answer-${question.id}`} className="form-label small mb-1">
            {t("survey.question.answerLabel")}
          </label>
          <textarea
            id={`answer-${question.id}`}
            className="form-control"
            rows={2}
            value={answerValue}
            onChange={(event) => setAnswerDraft(event.target.value)}
            disabled={!canAct || busy}
            placeholder={canAct ? t("survey.question.answerPlaceholder") : ""}
            maxLength={5000}
          />
          <button
            type="button"
            className="btn btn-primary btn-sm mt-2 w-100"
            onClick={handleAnswer}
            disabled={!canSubmitAnswer}
          >
            {t("survey.question.saveAnswer")}
          </button>
        </div>

        <div className="mt-auto">
          <label htmlFor={`delegate-${question.id}`} className="form-label small mb-1">
            {t("survey.question.delegateLabel")}
          </label>
          <div className="input-group input-group-sm">
            <input
              id={`delegate-${question.id}`}
              type="email"
              className="form-control"
              list={KNOWN_EMAILS_LIST_ID}
              value={delegateTo}
              onChange={(event) => setDelegateTo(event.target.value)}
              disabled={!canAct || busy}
              placeholder={t("survey.question.delegatePlaceholder")}
              autoComplete="off"
            />
            <button
              type="button"
              className="btn btn-outline-primary"
              onClick={handleDelegate}
              disabled={!canSubmitDelegation}
            >
              {t("survey.question.delegate")}
            </button>
          </div>

          {permissionNote && (
            <div className="alert alert-secondary py-1 px-2 small mt-3 mb-0" role="note">
              {permissionNote}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function CategoryDelegation({ category, items, activeEmail, busy, onDelegate }) {
  const { t } = useContext(LanguageContext);
  const [delegateTo, setDelegateTo] = useState("");

  const pendingItems = items.filter((q) => q.status === "pending");
  const ownedPending = pendingItems.filter(
    (q) => normalizeEmail(q.currentOwner) === normalizeEmail(activeEmail),
  );
  const canDelegate = ownedPending.length > 0;
  const canSubmit = canDelegate && !busy && isValidEmail(delegateTo);
  const inputId = `delegate-category-${category}`;

  let note = "";
  if (pendingItems.length === 0) {
    note = t("survey.category.allAnswered");
  } else if (!canDelegate) {
    const owners = Array.from(new Set(pendingItems.map((q) => q.currentOwner))).join(", ");
    note = t("survey.category.notOwner", { owners });
  }

  const handleDelegate = async () => {
    const transferred = await onDelegate({ category }, delegateTo);
    if (transferred) setDelegateTo("");
  };

  return (
    <div className="bg-body-tertiary rounded p-3 mb-3">
      <label htmlFor={inputId} className="form-label fw-semibold small mb-1">
        {t("survey.category.delegateLabel")}
      </label>
      <div className="input-group">
        <input
          id={inputId}
          type="email"
          className="form-control"
          list={KNOWN_EMAILS_LIST_ID}
          value={delegateTo}
          onChange={(event) => setDelegateTo(event.target.value)}
          disabled={!canDelegate || busy}
          placeholder={t("survey.category.delegatePlaceholder")}
          autoComplete="off"
        />
        <button
          type="button"
          className="btn btn-outline-primary"
          onClick={handleDelegate}
          disabled={!canSubmit}
        >
          {canDelegate
            ? t("survey.category.delegateCount", { count: ownedPending.length })
            : t("survey.category.delegateCategory")}
        </button>
      </div>
      <div className="form-text">{t("survey.category.delegateHelp")}</div>
      {note && (
        <div className="alert alert-secondary py-1 px-2 small mt-2 mb-0" role="note">
          {note}
        </div>
      )}
    </div>
  );
}

function CategorySection({ category, items, isOpen, onToggle, activeEmail, busy, onAnswer, onDelegate }) {
  const { t } = useContext(LanguageContext);
  const progress = computeProgress(items);
  const panelId = `category-panel-${category}`;
  const categoryLabel = translateCategory(category, t);

  return (
    <div className="accordion-item">
      <h2 className="accordion-header">
        <button
          type="button"
          className={`accordion-button ${isOpen ? "" : "collapsed"}`}
          onClick={onToggle}
          aria-expanded={isOpen}
          aria-controls={panelId}
        >
          <div className="w-100 pe-3">
            <div className="d-flex flex-wrap justify-content-between align-items-center gap-1">
              <span className="fw-semibold">{categoryLabel}</span>
              <span className="badge bg-success">
                {t("survey.category.answeredBadge", {
                  answered: progress.answered,
                  total: progress.total,
                })}
              </span>
            </div>
            <div
              className="progress mt-2"
              role="progressbar"
              aria-label={t("survey.category.completionLabel", { category: categoryLabel })}
              aria-valuenow={progress.percentage}
              aria-valuemin="0"
              aria-valuemax="100"
              style={{ height: "0.4rem" }}
            >
              <div
                className="progress-bar bg-success"
                style={{ width: `${progress.percentage}%`, transition: "width 0.4s ease" }}
              />
            </div>
          </div>
        </button>
      </h2>

      <div id={panelId} className={`accordion-collapse collapse ${isOpen ? "show" : ""}`}>
        <div className="accordion-body">
          <CategoryDelegation
            category={category}
            items={items}
            activeEmail={activeEmail}
            busy={busy}
            onDelegate={onDelegate}
          />

          <div className="row g-3">
            {items.map((question) => (
              <div className="col-12 col-lg-6" key={question.id}>
                <QuestionCard
                  question={question}
                  activeEmail={activeEmail}
                  busy={busy}
                  onAnswer={onAnswer}
                  onDelegate={onDelegate}
                />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------- Page ----------

export default function SurveyView() {
  const { t } = useContext(LanguageContext);

  const [survey, setSurvey] = useState(null);
  const [activeEmail, setActiveEmail] = useState("");
  const [openCategories, setOpenCategories] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  // Message descriptors ({ key, params, message }) so text re-renders on language change.
  const [error, setError] = useState(null);
  const [feedback, setFeedback] = useState(null);

  /** Replaces local state with the server's survey document. */
  const applySurvey = useCallback((data) => {
    const normalized = {
      ...data,
      questions: Array.isArray(data?.questions) ? data.questions : [],
    };
    setSurvey(normalized);
    setActiveEmail((previous) => previous || normalized.initialRecipient || "");
    setOpenCategories(
      (previous) =>
        previous ||
        new Set(
          normalized.questions.map((q) => String(q.category || "uncategorized").toLowerCase()),
        ),
    );
  }, []);

  const fetchSurvey = useCallback(async (signal) => {
    const response = await fetch(SURVEY_URL, { signal });
    if (!response.ok) {
      throw createTranslatableError("errors.requestFailed", { status: response.status });
    }
    return response.json();
  }, []);

  useEffect(() => {
    const controller = new AbortController();

    const loadSurvey = async () => {
      setLoading(true);
      setError(null);
      try {
        applySurvey(await fetchSurvey(controller.signal));
      } catch (err) {
        if (err.name !== "AbortError") {
          setError(describeError(err, "survey.errors.loadFailed"));
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };

    loadSurvey();
    return () => controller.abort();
  }, [applySurvey, fetchSurvey]);

  // Auto-dismiss feedback messages.
  useEffect(() => {
    if (!feedback) return undefined;
    const timer = setTimeout(() => setFeedback(null), 6000);
    return () => clearTimeout(timer);
  }, [feedback]);

  const refreshSurvey = useCallback(async () => {
    setRefreshing(true);
    try {
      applySurvey(await fetchSurvey());
    } catch (err) {
      setFeedback({ type: "danger", ...describeError(err, "survey.errors.refreshFailed") });
    } finally {
      setRefreshing(false);
    }
  }, [applySurvey, fetchSurvey]);

  /** Runs a mutation, applies the returned survey and reports the result. */
  const runMutation = useCallback(
    async (url, payload) => {
      setBusy(true);
      setFeedback(null);
      try {
        const data = await postJson(url, payload);
        applySurvey(data.survey);
        setFeedback(
          data.message
            ? { type: "success", key: null, params: null, message: data.message }
            : { type: "success", key: "survey.saved", params: null, message: "" },
        );
        return true;
      } catch (err) {
        setFeedback({ type: "danger", ...describeError(err, "survey.errors.refreshFailed") });
        // Re-sync silently: another user may have changed ownership in the meantime.
        try {
          applySurvey(await fetchSurvey());
        } catch {
          // Keep the current state if the re-sync also fails.
        }
        return false;
      } finally {
        setBusy(false);
      }
    },
    [applySurvey, fetchSurvey],
  );

  const handleAnswer = useCallback(
    (questionId, answerText) =>
      runMutation(ANSWER_URL, { questionId, userEmail: activeEmail.trim(), answerText }),
    [runMutation, activeEmail],
  );

  /** `target` is either `{ questionId }` or `{ category }`. */
  const handleDelegate = useCallback(
    (target, newOwnerEmail) =>
      runMutation(DELEGATE_URL, {
        ...target,
        currentOwnerEmail: activeEmail.trim(),
        newOwnerEmail: newOwnerEmail.trim(),
      }),
    [runMutation, activeEmail],
  );

  const toggleCategory = (category) => {
    setOpenCategories((previous) => {
      const next = new Set(previous);
      if (next.has(category)) next.delete(category);
      else next.add(category);
      return next;
    });
  };

  const questions = survey?.questions ?? [];
  const progress = useMemo(() => computeProgress(questions), [questions]);
  const groups = useMemo(() => groupByCategory(questions), [questions]);
  const knownEmails = useMemo(() => (survey ? collectKnownEmails(survey) : []), [survey]);

  if (loading) {
    return (
      <div className="d-flex justify-content-center py-5">
        <div className="spinner-border text-primary" role="status">
          <span className="visually-hidden">{t("survey.loading")}</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="alert alert-danger" role="alert">
        {renderMessage(t, error)}
      </div>
    );
  }

  return (
    <>
      <datalist id={KNOWN_EMAILS_LIST_ID}>
        {knownEmails.map((email) => (
          <option key={email} value={email} />
        ))}
      </datalist>

      <h1 className="h4 mb-3">{survey?.title || t("survey.dashboardTitle")}</h1>

      <ActiveUserBar
        value={activeEmail}
        onChange={setActiveEmail}
        onRefresh={refreshSurvey}
        refreshing={refreshing}
      />

      <GlobalProgress progress={progress} />

      {groups.length === 0 ? (
        <div className="alert alert-info" role="alert">
          {t("survey.noQuestions")}
        </div>
      ) : (
        <div className="accordion mb-5">
          {groups.map(({ category, items }) => (
            <CategorySection
              key={category}
              category={category}
              items={items}
              isOpen={openCategories?.has(category) ?? true}
              onToggle={() => toggleCategory(category)}
              activeEmail={activeEmail}
              busy={busy}
              onAnswer={handleAnswer}
              onDelegate={handleDelegate}
            />
          ))}
        </div>
      )}

      {feedback && (
        <div
          className={`alert alert-${feedback.type} alert-dismissible shadow position-fixed bottom-0 start-0 end-0 m-3`}
          style={{ zIndex: 1080 }}
          role={feedback.type === "danger" ? "alert" : "status"}
        >
          {renderMessage(t, feedback)}
          <button
            type="button"
            className="btn-close"
            aria-label={t("survey.dismissMessage")}
            onClick={() => setFeedback(null)}
          />
        </div>
      )}
    </>
  );
}