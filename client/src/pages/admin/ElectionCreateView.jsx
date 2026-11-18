import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { saveBlob } from "../../api/client";
import { useAuth } from "../../context/useAuth";
import { useLanguage } from "../../context/useLanguage";
import { ErrorNotice, Notice } from "../../components/ui/Feedback";
import { PageHeader, Section } from "../../components/ui/Layout";
import CsvValidationResult from "../../components/CsvValidationResult";
import Icon from "../../components/ui/Icon";
import { formatBytes, optionLabel } from "../../utils/format";

const MAX_MOTIONS = 20;
const MAX_OPTIONS = 10;
const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const ALLOWED_EXTENSIONS = [".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".odt", ".ods", ".odp", ".txt", ".csv", ".rtf", ".png", ".jpg", ".jpeg", ".webp"];
const PRESETS = [
  { key: "approveReject", options: ["approve", "reject", "abstain"] },
  { key: "yesNo", options: ["yes", "no"] },
];
const SAMPLE_CSV =
  "email,name,birthdate,gender,weight\n" +
  "ana.garcia@example.com,Ana García,1990-04-12,female,1\n" +
  "bruno.diaz@example.com,Bruno Díaz,1985-11-03,male,2\n" +
  "carla.rojas@example.com,Carla Rojas,2000-01-15,other,1.5\n";

let motionKey = 0;
const newMotion = () => ({ key: ++motionKey, title: "", description: "", options: [...PRESETS[0].options], draft: "" });

function MotionEditor({ motion, index, canRemove, onChange, onRemove, showErrors }) {
  const { t } = useLanguage();
  const titleId = `motion-title-${motion.key}`;
  const optionId = `motion-option-${motion.key}`;
  const titleInvalid = showErrors && motion.title.trim() === "";
  const optionsInvalid = showErrors && motion.options.length < 2;

  const addOption = () => {
    const value = motion.draft.trim();
    if (!value || motion.options.length >= MAX_OPTIONS) return;
    if (motion.options.some((option) => option.toLowerCase() === value.toLowerCase())) {
      onChange({ draft: "" });
      return;
    }
    onChange({ options: [...motion.options, value.slice(0, 60)], draft: "" });
  };

  return (
    <div className="motion-editor mb-3">
      <div className="d-flex align-items-center justify-content-between gap-2 mb-3">
        <div className="d-flex align-items-center gap-2">
          <span className="motion-number">{index + 1}</span>
          <h3 className="h6 mb-0">{t("electionForm.motion", { index: index + 1 })}</h3>
        </div>
        {canRemove && (
          <button type="button" className="btn btn-sm btn-outline-danger" onClick={onRemove}>
            <Icon name="trash" size={16} className="me-1" />
            {t("common.remove")}
          </button>
        )}
      </div>

      <div className="mb-3">
        <label className="form-label" htmlFor={titleId}>
          {t("electionForm.motionTitle")} <span className="text-danger">*</span>
        </label>
        <input
          id={titleId}
          className={`form-control ${titleInvalid ? "is-invalid" : ""}`}
          value={motion.title}
          maxLength={200}
          placeholder={t("electionForm.motionTitlePlaceholder")}
          onChange={(event) => onChange({ title: event.target.value })}
        />
        <div className="invalid-feedback">{t("electionForm.errors.motionTitle")}</div>
      </div>

      <div className="mb-3">
        <label className="form-label" htmlFor={`motion-description-${motion.key}`}>
          {t("electionForm.motionDescription")}
        </label>
        <textarea
          id={`motion-description-${motion.key}`}
          className="form-control"
          rows={2}
          maxLength={5000}
          value={motion.description}
          onChange={(event) => onChange({ description: event.target.value })}
        />
      </div>

      <div>
        <div className="d-flex flex-wrap align-items-center justify-content-between gap-2 mb-2">
          <label className="form-label mb-0" htmlFor={optionId}>
            {t("electionForm.options")} <span className="text-danger">*</span>
          </label>
          <div className="d-flex flex-wrap gap-1">
            {PRESETS.map((preset) => (
              <button
                key={preset.key}
                type="button"
                className="btn btn-sm btn-outline-secondary"
                onClick={() => onChange({ options: [...preset.options] })}
              >
                {t(`electionForm.presets.${preset.key}`)}
              </button>
            ))}
          </div>
        </div>
        <div className="d-flex flex-wrap gap-2 mb-2" aria-live="polite">
          {motion.options.map((option) => (
            <span key={option} className="option-chip">
              <span>{optionLabel(t, option)}</span>
              <button
                type="button"
                aria-label={t("electionForm.removeOption", { option: optionLabel(t, option) })}
                onClick={() => onChange({ options: motion.options.filter((item) => item !== option) })}
              >
                <Icon name="x" size={14} />
              </button>
            </span>
          ))}
        </div>
        <div className="input-group">
          <input
            id={optionId}
            className={`form-control ${optionsInvalid ? "is-invalid" : ""}`}
            value={motion.draft}
            maxLength={60}
            placeholder={t("electionForm.optionPlaceholder")}
            onChange={(event) => onChange({ draft: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                addOption();
              }
            }}
            disabled={motion.options.length >= MAX_OPTIONS}
          />
          <button type="button" className="btn btn-outline-primary" onClick={addOption} disabled={!motion.draft.trim()}>
            <Icon name="plus" size={16} className="me-1" />
            {t("common.add")}
          </button>
          <div className="invalid-feedback">{t("electionForm.errors.options")}</div>
        </div>
        <div className="form-text">{t("electionForm.optionsHelp", { max: MAX_OPTIONS })}</div>
      </div>
    </div>
  );
}

export default function ElectionCreateView() {
  const { request } = useAuth();
  const { t, language, locale } = useLanguage();
  const navigate = useNavigate();

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [motions, setMotions] = useState(() => [newMotion()]);
  const [csvFile, setCsvFile] = useState(null);
  const [csvCheck, setCsvCheck] = useState({ status: "idle", result: null, error: null });
  const [attachments, setAttachments] = useState([]);
  const [attachmentProblem, setAttachmentProblem] = useState("");
  const [emailLanguage, setEmailLanguage] = useState(language);
  const [showErrors, setShowErrors] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(null);
  // Idempotency key: a retried submission (e.g. after a timeout) never creates a second vote.
  const [requestId] = useState(() => crypto.randomUUID());
  // Only the latest CSV check may update the screen (a slow answer for a previous file is ignored).
  const csvCheckSeq = useRef(0);

  const updateMotion = (key, patch) =>
    setMotions((current) => current.map((motion) => (motion.key === key ? { ...motion, ...patch } : motion)));

  const validateCsv = async (file) => {
    const sequence = ++csvCheckSeq.current;
    setCsvFile(file);
    if (!file) {
      setCsvCheck({ status: "idle", result: null, error: null });
      return;
    }
    setCsvCheck({ status: "checking", result: null, error: null });
    const form = new FormData();
    form.set("votersCsv", file);
    try {
      const result = await request("/api/admin/csv/validate", { method: "POST", form });
      if (sequence !== csvCheckSeq.current) return;
      setCsvCheck({ status: result.errors.length === 0 ? "valid" : "invalid", result, error: null });
    } catch (error) {
      if (sequence !== csvCheckSeq.current) return;
      setCsvCheck({ status: "invalid", result: null, error });
    }
  };

  const addAttachments = (fileList) => {
    setAttachmentProblem("");
    const next = [...attachments];
    for (const file of fileList) {
      const extension = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
      if (!ALLOWED_EXTENSIONS.includes(extension)) {
        setAttachmentProblem(t("electionForm.errors.attachmentType", { name: file.name }));
        continue;
      }
      if (next.length >= MAX_ATTACHMENTS) {
        setAttachmentProblem(t("electionForm.errors.attachmentCount", { max: MAX_ATTACHMENTS }));
        break;
      }
      if (!next.some((item) => item.name === file.name && item.size === file.size)) next.push(file);
    }
    if (next.reduce((sum, file) => sum + file.size, 0) > MAX_ATTACHMENT_BYTES) {
      setAttachmentProblem(t("electionForm.errors.attachmentSize"));
      return;
    }
    setAttachments(next);
  };

  const formProblems = () => {
    const problems = [];
    if (title.trim() === "") problems.push(t("electionForm.errors.title"));
    motions.forEach((motion, index) => {
      if (motion.title.trim() === "") problems.push(t("electionForm.errors.motionTitleAt", { index: index + 1 }));
      if (motion.options.length < 2) problems.push(t("electionForm.errors.optionsAt", { index: index + 1 }));
    });
    if (!csvFile) problems.push(t("electionForm.errors.csv"));
    else if (csvCheck.status === "invalid") problems.push(t("electionForm.errors.csvInvalid"));
    return problems;
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setShowErrors(true);
    setSubmitError(null);
    if (formProblems().length > 0 || csvCheck.status === "checking") return;

    const form = new FormData();
    form.set("title", title.trim());
    form.set("description", description.trim());
    form.set(
      "motions",
      JSON.stringify(motions.map((motion) => ({ title: motion.title.trim(), description: motion.description.trim(), options: motion.options })))
    );
    form.set("votersCsv", csvFile);
    for (const file of attachments) form.append("attachments", file);
    form.set("lang", emailLanguage);
    form.set("requestId", requestId);

    setSubmitting(true);
    try {
      const result = await request("/api/admin/elections", { method: "POST", form });
      navigate(`/admin/elections/${result.electionId}`, { state: { created: result } });
    } catch (error) {
      setSubmitError(error);
      setSubmitting(false);
    }
  };

  const problems = showErrors ? formProblems() : [];
  const totalAttachmentBytes = attachments.reduce((sum, file) => sum + file.size, 0);

  return (
    <form onSubmit={handleSubmit} noValidate>
      <PageHeader
        title={t("electionForm.title")}
        subtitle={t("electionForm.subtitle")}
        backTo="/admin"
        backLabel={t("admin.title")}
      />

      <fieldset disabled={submitting} className="border-0 p-0 m-0 min-w-0">
        <Section title={t("electionForm.generalTitle")}>
          <div className="mb-3">
            <label className="form-label" htmlFor="election-title">
              {t("electionForm.electionTitle")} <span className="text-danger">*</span>
            </label>
            <input
              id="election-title"
              className={`form-control ${showErrors && !title.trim() ? "is-invalid" : ""}`}
              value={title}
              maxLength={200}
              placeholder={t("electionForm.electionTitlePlaceholder")}
              onChange={(event) => setTitle(event.target.value)}
            />
            <div className="invalid-feedback">{t("electionForm.errors.title")}</div>
          </div>
          <div>
            <label className="form-label" htmlFor="election-description">
              {t("electionForm.electionDescription")}
            </label>
            <textarea
              id="election-description"
              className="form-control"
              rows={3}
              maxLength={5000}
              value={description}
              placeholder={t("electionForm.electionDescriptionPlaceholder")}
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>
        </Section>

        <Section
          title={t("electionForm.motionsTitle")}
          description={t("electionForm.motionsDescription")}
          actions={<span className="small text-body-secondary">{t("electionForm.motionCount", { count: motions.length, max: MAX_MOTIONS })}</span>}
        >
          {motions.map((motion, index) => (
            <MotionEditor
              key={motion.key}
              motion={motion}
              index={index}
              canRemove={motions.length > 1}
              showErrors={showErrors}
              onChange={(patch) => updateMotion(motion.key, patch)}
              onRemove={() => setMotions((current) => current.filter((item) => item.key !== motion.key))}
            />
          ))}
          <button
            type="button"
            className="btn btn-outline-primary"
            onClick={() => setMotions((current) => [...current, newMotion()])}
            disabled={motions.length >= MAX_MOTIONS}
          >
            <Icon name="plus" className="me-1" />
            {t("electionForm.addMotion")}
          </button>
        </Section>

        <Section
          title={t("electionForm.votersTitle")}
          description={t("electionForm.votersDescription")}
          actions={
            <button
              type="button"
              className="btn btn-sm btn-outline-secondary"
              onClick={() => saveBlob(new Blob([SAMPLE_CSV], { type: "text/csv;charset=utf-8" }), "voters-template.csv")}
            >
              <Icon name="download" size={16} className="me-1" />
              {t("electionForm.downloadTemplate")}
            </button>
          }
        >
          <div className="drop-zone mb-3">
            <label className="form-label" htmlFor="voters-csv">
              {t("electionForm.csvLabel")} <span className="text-danger">*</span>
            </label>
            <input
              id="voters-csv"
              type="file"
              accept=".csv,text/csv"
              className={`form-control ${showErrors && (!csvFile || csvCheck.status === "invalid") ? "is-invalid" : ""}`}
              onChange={(event) => validateCsv(event.target.files?.[0] ?? null)}
            />
            <div className="form-text">{t("electionForm.csvHelp")}</div>
          </div>
          <CsvValidationResult check={csvCheck} />
        </Section>

        <Section title={t("electionForm.attachmentsTitle")} description={t("electionForm.attachmentsDescription")}>
          <div className="drop-zone mb-3">
            <label className="form-label" htmlFor="attachments">
              {t("electionForm.attachmentsLabel")}
            </label>
            <input
              id="attachments"
              type="file"
              multiple
              accept={ALLOWED_EXTENSIONS.join(",")}
              className="form-control"
              onChange={(event) => {
                addAttachments([...(event.target.files ?? [])]);
                event.target.value = "";
              }}
            />
            <div className="form-text">{t("electionForm.attachmentsHelp", { max: MAX_ATTACHMENTS })}</div>
          </div>
          {attachmentProblem && <Notice variant="warning">{attachmentProblem}</Notice>}
          {attachments.length > 0 && (
            <ul className="list-group mb-0">
              {attachments.map((file) => (
                <li key={`${file.name}-${file.size}`} className="list-group-item d-flex align-items-center gap-2">
                  <Icon name="file" className="text-body-secondary" />
                  <span className="flex-grow-1 text-break-all">{file.name}</span>
                  <span className="small text-body-secondary text-nowrap">{formatBytes(file.size, locale)}</span>
                  <button
                    type="button"
                    className="btn btn-sm btn-link text-danger"
                    aria-label={t("electionForm.removeAttachment", { name: file.name })}
                    onClick={() => setAttachments((current) => current.filter((item) => item !== file))}
                  >
                    <Icon name="trash" size={16} />
                  </button>
                </li>
              ))}
              <li className="list-group-item small text-body-secondary">
                {t("electionForm.attachmentsTotal", { size: formatBytes(totalAttachmentBytes, locale) })}
              </li>
            </ul>
          )}
        </Section>

        <Section title={t("electionForm.sendTitle")}>
          <div className="row g-3 align-items-end">
            <div className="col-12 col-md-6">
              <label className="form-label" htmlFor="email-language">
                {t("electionForm.emailLanguage")}
              </label>
              <select id="email-language" className="form-select" value={emailLanguage} onChange={(event) => setEmailLanguage(event.target.value)}>
                <option value="es">{t("languages.es")}</option>
                <option value="en">{t("languages.en")}</option>
              </select>
            </div>
            <div className="col-12 col-md-6">
              <p className="small text-body-secondary mb-0">{t("electionForm.sendHelp")}</p>
            </div>
          </div>
        </Section>

        {problems.length > 0 && (
          <Notice variant="danger" title={t("electionForm.errors.summary")} details={problems} />
        )}
        <ErrorNotice error={submitError} onDismiss={() => setSubmitError(null)} />

        <div className="d-flex flex-column flex-sm-row justify-content-end gap-2">
          <button type="button" className="btn btn-outline-secondary" onClick={() => navigate("/admin")}>
            {t("common.cancel")}
          </button>
          <button type="submit" className="btn btn-primary" disabled={submitting || csvCheck.status === "checking"}>
            {submitting ? (
              <span className="spinner-border spinner-border-sm me-2" aria-hidden="true" />
            ) : (
              <Icon name="send" className="me-2" />
            )}
            {submitting ? t("electionForm.submitting") : t("electionForm.submit")}
          </button>
        </div>
      </fieldset>
    </form>
  );
}
