import { useContext, useState } from "react";
import { AuthContext } from "../context/AuthContext";
import { LanguageContext } from "../context/LanguageContext";

const DISPATCH_URL = "http://localhost:8000/api/admin/dispatch";

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10 MB (mirrors the server limit)
const MAX_CSV_BYTES = 1_000_000; // 1 MB (mirrors the server limit)
const MAX_TITLE_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 5000;

const IDLE_STATUS = {
  type: "idle",
  message: "",
  messageKey: null,
  params: null,
  details: [],
};

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
 * Renders the Bootstrap alert for the current submission status.
 * Client-side messages are stored as translation keys; messages coming
 * straight from the server are displayed as received.
 */
function StatusAlert({ status }) {
  const { t } = useContext(LanguageContext);

  if (status.type !== "success" && status.type !== "error") {
    return null;
  }

  const text = status.messageKey
    ? t(status.messageKey, status.params)
    : status.message;
  const alertClass = status.type === "success" ? "alert-success" : "alert-danger";

  return (
    <div className={`alert ${alertClass} mt-3 mb-0`} role="alert">
      <div>{text}</div>
      {status.details && status.details.length > 0 && (
        <ul className="mb-0 mt-2 small ps-3">
          {status.details.map((detail, index) => (
            <li key={`${index}-${detail}`}>{detail}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Validates the form values on the client before any network request.
 *
 * @returns {{ key: string, params: object | null } | null} The first error found, or null.
 */
function validateForm({ title, description, attachment, csvFile }) {
  if (title.trim() === "") {
    return { key: "admin.errors.noTitle", params: null };
  }
  if (description.trim() === "") {
    return { key: "admin.errors.noDescription", params: null };
  }
  if (!attachment) {
    return { key: "admin.errors.noAttachment", params: null };
  }
  if (attachment.size > MAX_ATTACHMENT_BYTES) {
    return {
      key: "admin.errors.attachmentTooLarge",
      params: { maxMb: MAX_ATTACHMENT_BYTES / (1024 * 1024) },
    };
  }
  if (!csvFile) {
    return { key: "admin.errors.noCsv", params: null };
  }
  if (!csvFile.name.toLowerCase().endsWith(".csv")) {
    return { key: "admin.errors.invalidExtension", params: null };
  }
  if (csvFile.size > MAX_CSV_BYTES) {
    return { key: "admin.errors.csvTooLarge", params: { maxMb: 1 } };
  }
  return null;
}

/**
 * Reads the error payload of a failed response into a status-friendly shape.
 */
async function readErrorPayload(response) {
  const contentType = response.headers.get("content-type") || "";
  let payload = null;

  try {
    payload = contentType.includes("application/json")
      ? await response.json()
      : await response.text();
  } catch {
    payload = null;
  }

  const message =
    (payload && typeof payload === "object" && (payload.error || payload.message)) ||
    (typeof payload === "string" && payload) ||
    "";
  const details =
    payload && typeof payload === "object" && Array.isArray(payload.details)
      ? payload.details.map(String)
      : [];

  return { message, details };
}

function DispatchForm({
  formKey,
  loading,
  title,
  description,
  attachmentName,
  csvName,
  onTitleChange,
  onDescriptionChange,
  onAttachmentChange,
  onCsvChange,
  onSubmit,
}) {
  const { t } = useContext(LanguageContext);

  return (
    <form onSubmit={onSubmit} noValidate>
      <fieldset disabled={loading} className="border-0 p-0 m-0">
        <div className="mb-3">
          <label htmlFor="motionTitle" className="form-label">
            {t("admin.motionTitleLabel")}
          </label>
          <input
            id="motionTitle"
            type="text"
            className="form-control"
            placeholder={t("admin.motionTitlePlaceholder")}
            value={title}
            maxLength={MAX_TITLE_LENGTH}
            onChange={onTitleChange}
            required
          />
        </div>

        <div className="mb-3">
          <label htmlFor="motionDescription" className="form-label">
            {t("admin.motionDescriptionLabel")}
          </label>
          <textarea
            id="motionDescription"
            className="form-control"
            rows={4}
            placeholder={t("admin.motionDescriptionPlaceholder")}
            value={description}
            maxLength={MAX_DESCRIPTION_LENGTH}
            onChange={onDescriptionChange}
            required
          />
        </div>

        <div className="mb-3">
          <label htmlFor="motionAttachment" className="form-label">
            {t("admin.attachmentLabel")}
          </label>
          <input
            key={`attachment-${formKey}`}
            id="motionAttachment"
            type="file"
            className="form-control"
            onChange={onAttachmentChange}
            required
          />
          <div className="form-text">{t("admin.attachmentHelp")}</div>
          {attachmentName && (
            <div className="form-text">
              {t("admin.selected", { fileName: attachmentName })}
            </div>
          )}
        </div>

        <div className="mb-4">
          <label htmlFor="votersCsv" className="form-label">
            {t("admin.csvLabel")}
          </label>
          <input
            key={`csv-${formKey}`}
            id="votersCsv"
            type="file"
            accept=".csv,text/csv"
            className="form-control"
            onChange={onCsvChange}
            required
          />
          <div className="form-text">{t("admin.csvHelp")}</div>
          {csvName && (
            <div className="form-text">
              {t("admin.selected", { fileName: csvName })}
            </div>
          )}
        </div>

        <button type="submit" className="btn btn-primary w-100" disabled={loading}>
          {loading ? (
            <>
              <span
                className="spinner-border spinner-border-sm me-2"
                role="status"
                aria-hidden="true"
              ></span>
              {t("admin.dispatching")}
            </>
          ) : (
            t("admin.dispatch")
          )}
        </button>
      </fieldset>
    </form>
  );
}

export default function AdminView() {
  const { t } = useContext(LanguageContext);
  // Google SSO session: `authHeaders()` returns the Bearer token the backend requires.
  const { user, authHeaders } = useContext(AuthContext);

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [attachment, setAttachment] = useState(null);
  const [csvFile, setCsvFile] = useState(null);
  const [formKey, setFormKey] = useState(0); // Bumped to reset the uncontrolled file inputs.
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState(IDLE_STATUS);

  const clearStatus = () => setStatus(IDLE_STATUS);

  const handleTitleChange = (event) => {
    setTitle(event.target.value);
    clearStatus();
  };

  const handleDescriptionChange = (event) => {
    setDescription(event.target.value);
    clearStatus();
  };

  const handleAttachmentChange = (event) => {
    setAttachment(event.target.files[0] || null);
    clearStatus();
  };

  const handleCsvChange = (event) => {
    setCsvFile(event.target.files[0] || null);
    clearStatus();
  };

  const resetForm = () => {
    setTitle("");
    setDescription("");
    setAttachment(null);
    setCsvFile(null);
    setFormKey((previous) => previous + 1);
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (loading) return;

    const validationError = validateForm({ title, description, attachment, csvFile });
    if (validationError) {
      setStatus({
        type: "error",
        message: "",
        messageKey: validationError.key,
        params: validationError.params,
        details: [],
      });
      return;
    }

    setLoading(true);
    setStatus(IDLE_STATUS);

    try {
      const formData = new FormData();
      formData.append("title", title.trim());
      formData.append("description", description.trim());
      formData.append("attachment", attachment);
      formData.append("votersCsv", csvFile);

      // Do not set Content-Type manually: the browser adds the multipart boundary.
      let response;
      try {
        response = await fetch(DISPATCH_URL, {
          method: "POST",
          headers: authHeaders(),
          body: formData,
        });
      } catch {
        throw createTranslatableError("errors.network");
      }

      if (!response.ok) {
        const { message, details } = await readErrorPayload(response);
        if (message) {
          const serverError = new Error(message);
          serverError.details = details;
          throw serverError;
        }
        throw createTranslatableError("errors.requestFailed", {
          status: response.status,
        });
      }

      let imported = 0;
      try {
        const payload = await response.json();
        imported = Number(payload && payload.imported) || 0;
      } catch {
        imported = 0;
      }

      setStatus({
        type: "success",
        message: "",
        messageKey: "admin.success",
        params: { count: imported },
        details: [],
      });
      resetForm();
    } catch (error) {
      if (error.translationKey) {
        setStatus({
          type: "error",
          message: "",
          messageKey: error.translationKey,
          params: error.translationParams || null,
          details: [],
        });
      } else if (error.message) {
        setStatus({
          type: "error",
          message: error.message,
          messageKey: null,
          params: null,
          details: error.details || [],
        });
      } else {
        setStatus({
          type: "error",
          message: "",
          messageKey: "admin.errors.unexpected",
          params: null,
          details: [],
        });
      }
    } finally {
      setLoading(false);
    }
  };

  // Client-side guard: the protected route normally prevents this state.
  if (!user) {
    return null;
  }

  return (
    <div className="row justify-content-center">
      <div className="col-12 col-md-10 col-lg-7">
        <div className="card shadow-sm">
          <div className="card-body p-3 p-md-4">
            <h1 className="h4 card-title mb-2">{t("admin.title")}</h1>
            <p className="text-muted mb-4">{t("admin.description")}</p>

            <DispatchForm
              formKey={formKey}
              loading={loading}
              title={title}
              description={description}
              attachmentName={attachment ? attachment.name : ""}
              csvName={csvFile ? csvFile.name : ""}
              onTitleChange={handleTitleChange}
              onDescriptionChange={handleDescriptionChange}
              onAttachmentChange={handleAttachmentChange}
              onCsvChange={handleCsvChange}
              onSubmit={handleSubmit}
            />

            <StatusAlert status={status} />
          </div>
        </div>
      </div>
    </div>
  );
}