import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../context/useAuth";
import { useLanguage } from "../../context/useLanguage";
import { ErrorNotice, LoadingState, Notice } from "../../components/ui/Feedback";
import { Badge, PageHeader, Section } from "../../components/ui/Layout";
import Icon from "../../components/ui/Icon";
import { categoryLabel, isValidEmail } from "../../utils/format";

const MAX_QUESTIONS = 200;

/** One question per non-empty line. */
function splitQuestions(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

export default function SurveyCreateView() {
  const { request } = useAuth();
  const { t, language } = useLanguage();
  const navigate = useNavigate();

  const [title, setTitle] = useState("");
  const [recipient, setRecipient] = useState("");
  const [questionsText, setQuestionsText] = useState("");
  const [emailLanguage, setEmailLanguage] = useState(language);
  const [preview, setPreview] = useState({ loading: false, items: [], error: null });
  const [showErrors, setShowErrors] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(null);

  const questions = useMemo(() => splitQuestions(questionsText), [questionsText]);
  const questionsKey = questions.join("\n");

  // Live preview of the automatic categorization (debounced, computed by the server).
  useEffect(() => {
    if (questions.length === 0 || questions.length > MAX_QUESTIONS) return undefined;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setPreview((current) => ({ ...current, loading: true, error: null }));
      try {
        const result = await request("/api/surveys/categorize", { method: "POST", json: { questions }, signal: controller.signal });
        setPreview({ loading: false, items: result.questions, error: null });
      } catch (error) {
        if (error?.name !== "AbortError") setPreview({ loading: false, items: [], error });
      }
    }, 500);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
    // `questionsKey` captures the content of `questions`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [questionsKey, request]);

  const grouped = useMemo(() => {
    const groups = new Map();
    const current = new Set(questions);
    for (const item of preview.items) {
      if (!current.has(item.text)) continue;
      if (!groups.has(item.category)) groups.set(item.category, []);
      groups.get(item.category).push(item.text);
    }
    return [...groups.entries()];
  }, [preview.items, questions]);

  const problems = [];
  if (showErrors) {
    if (!title.trim()) problems.push(t("surveyForm.errors.title"));
    if (!isValidEmail(recipient)) problems.push(t("surveyForm.errors.recipient"));
    if (questions.length === 0) problems.push(t("surveyForm.errors.questions"));
    if (questions.length > MAX_QUESTIONS) problems.push(t("surveyForm.errors.tooMany", { max: MAX_QUESTIONS }));
    if (questions.some((question) => question.length > 1000)) problems.push(t("surveyForm.errors.tooLong"));
  }

  const handleSubmit = async (event) => {
    event.preventDefault();
    setShowErrors(true);
    setSubmitError(null);
    const invalid =
      !title.trim() || !isValidEmail(recipient) || questions.length === 0 || questions.length > MAX_QUESTIONS ||
      questions.some((question) => question.length > 1000);
    if (invalid) return;
    setSubmitting(true);
    try {
      const result = await request("/api/surveys", {
        method: "POST",
        json: { title: title.trim(), initialRecipient: recipient.trim(), questions, lang: emailLanguage },
      });
      navigate(`/surveys/${result.survey.id}`, { state: { created: true, notified: result.notified } });
    } catch (error) {
      setSubmitError(error);
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} noValidate>
      <PageHeader title={t("surveyForm.title")} subtitle={t("surveyForm.subtitle")} backTo="/admin" backLabel={t("admin.title")} />
      <fieldset disabled={submitting} className="border-0 p-0 m-0 min-w-0">
        <div className="row g-4">
          <div className="col-12 col-lg-7">
            <Section title={t("surveyForm.generalTitle")}>
              <div className="mb-3">
                <label className="form-label" htmlFor="survey-title">
                  {t("surveyForm.surveyTitle")} <span className="text-danger">*</span>
                </label>
                <input
                  id="survey-title"
                  className={`form-control ${showErrors && !title.trim() ? "is-invalid" : ""}`}
                  value={title}
                  maxLength={200}
                  placeholder={t("surveyForm.surveyTitlePlaceholder")}
                  onChange={(event) => setTitle(event.target.value)}
                />
                <div className="invalid-feedback">{t("surveyForm.errors.title")}</div>
              </div>
              <div className="mb-3">
                <label className="form-label" htmlFor="survey-recipient">
                  {t("surveyForm.recipient")} <span className="text-danger">*</span>
                </label>
                <input
                  id="survey-recipient"
                  type="email"
                  autoComplete="off"
                  className={`form-control ${showErrors && !isValidEmail(recipient) ? "is-invalid" : ""}`}
                  value={recipient}
                  placeholder={t("placeholders.email")}
                  onChange={(event) => setRecipient(event.target.value)}
                />
                <div className="form-text">{t("surveyForm.recipientHelp")}</div>
                <div className="invalid-feedback">{t("surveyForm.errors.recipient")}</div>
              </div>
              <div className="mb-3">
                <label className="form-label" htmlFor="survey-questions">
                  {t("surveyForm.questions")} <span className="text-danger">*</span>
                </label>
                <textarea
                  id="survey-questions"
                  className={`form-control ${showErrors && questions.length === 0 ? "is-invalid" : ""}`}
                  rows={10}
                  value={questionsText}
                  placeholder={t("surveyForm.questionsPlaceholder")}
                  onChange={(event) => setQuestionsText(event.target.value)}
                />
                <div className="form-text">{t("surveyForm.questionsHelp", { count: questions.length, max: MAX_QUESTIONS })}</div>
              </div>
              <div>
                <label className="form-label" htmlFor="survey-language">{t("electionForm.emailLanguage")}</label>
                <select id="survey-language" className="form-select" value={emailLanguage} onChange={(event) => setEmailLanguage(event.target.value)}>
                  <option value="es">{t("languages.es")}</option>
                  <option value="en">{t("languages.en")}</option>
                </select>
              </div>
            </Section>
          </div>

          <div className="col-12 col-lg-5">
            <Section title={t("surveyForm.previewTitle")} description={t("surveyForm.previewDescription")}>
              {questions.length === 0 && <p className="text-body-secondary small mb-0">{t("surveyForm.previewEmpty")}</p>}
              {preview.loading && <LoadingState compact label={t("surveyForm.categorizing")} />}
              <ErrorNotice error={preview.error} />
              {questions.length > 0 &&
                grouped.map(([category, items]) => (
                  <div key={category} className="mb-3">
                    <div className="d-flex align-items-center justify-content-between mb-1">
                      <Badge tone="primary">{categoryLabel(t, category)}</Badge>
                      <span className="small text-body-secondary">{t("surveyForm.questionCount", { count: items.length })}</span>
                    </div>
                    <ul className="small mb-0 ps-3">
                      {items.map((text, index) => (
                        <li key={`${index}-${text}`} className="text-break-all">{text}</li>
                      ))}
                    </ul>
                  </div>
                ))}
            </Section>
          </div>
        </div>

        {problems.length > 0 && <Notice variant="danger" title={t("electionForm.errors.summary")} details={problems} />}
        <ErrorNotice error={submitError} onDismiss={() => setSubmitError(null)} />

        <div className="d-flex flex-column flex-sm-row justify-content-end gap-2">
          <button type="button" className="btn btn-outline-secondary" onClick={() => navigate("/admin")}>
            {t("common.cancel")}
          </button>
          <button type="submit" className="btn btn-primary">
            {submitting ? <span className="spinner-border spinner-border-sm me-2" aria-hidden="true" /> : <Icon name="send" className="me-2" />}
            {t("surveyForm.submit")}
          </button>
        </div>
      </fieldset>
    </form>
  );
}
