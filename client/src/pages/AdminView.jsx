import { useContext, useState } from "react";
import { LanguageContext } from "../context/LanguageContext";

const UPLOAD_URL = "http://localhost:8000/api/admin/voters/upload";

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

function StatusAlert({ status }) {
  const { t } = useContext(LanguageContext);

  // Messages from the client are stored as translation keys; messages
  // coming straight from the server are displayed as received.
  const text = status.messageKey
    ? t(status.messageKey, status.params)
    : status.message;

  if (status.type === "success") {
    return (
      <div className="alert alert-success mt-3" role="alert">
        {text}
      </div>
    );
  }
  if (status.type === "error") {
    return (
      <div className="alert alert-danger mt-3" role="alert">
        {text}
      </div>
    );
  }
  return null;
}

function UploadForm({ onSubmit, onFileChange, loading, fileName }) {
  const { t } = useContext(LanguageContext);

  return (
    <form onSubmit={onSubmit}>
      <div className="mb-3">
        <label htmlFor="csvFile" className="form-label">
          {t("admin.csvLabel")}
        </label>
        <input
          id="csvFile"
          type="file"
          accept=".csv,text/csv"
          className="form-control"
          onChange={onFileChange}
          disabled={loading}
        />
        {fileName && (
          <div className="form-text">{t("admin.selected", { fileName })}</div>
        )}
      </div>

      <button
        type="submit"
        className="btn btn-primary w-100 w-sm-auto"
        disabled={loading || !fileName}
      >
        {loading ? (
          <>
            <span
              className="spinner-border spinner-border-sm me-2"
              role="status"
              aria-hidden="true"
            ></span>
            {t("admin.uploading")}
          </>
        ) : (
          t("admin.upload")
        )}
      </button>
    </form>
  );
}

const IDLE_STATUS = { type: "idle", message: "", messageKey: null, params: null };

export default function AdminView() {
  const { t } = useContext(LanguageContext);

  const [file, setFile] = useState(null);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState(IDLE_STATUS);

  const handleFileChange = (event) => {
    const selected = event.target.files[0] || null;
    setFile(selected);
    setStatus(IDLE_STATUS);
  };

  const handleSubmit = async (event) => {
    event.preventDefault();

    if (!file) {
      setStatus({
        type: "error",
        message: "",
        messageKey: "admin.errors.noFile",
        params: null,
      });
      return;
    }

    if (!file.name.toLowerCase().endsWith(".csv")) {
      setStatus({
        type: "error",
        message: "",
        messageKey: "admin.errors.invalidExtension",
        params: null,
      });
      return;
    }

    setLoading(true);
    setStatus(IDLE_STATUS);

    try {
      const csvText = await file.text();

      const response = await fetch(UPLOAD_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: csvText,
      });

      let payload = null;
      const contentType = response.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        payload = await response.json();
      } else {
        payload = await response.text();
      }

      if (!response.ok) {
        const detail =
          (payload && (payload.error || payload.message)) ||
          (typeof payload === "string" && payload) ||
          "";

        if (detail) {
          throw new Error(detail);
        }
        throw createTranslatableError("errors.requestFailed", {
          status: response.status,
        });
      }

      const serverMessage =
        (payload && typeof payload === "object" && payload.message) ||
        (typeof payload === "string" && payload) ||
        "";

      setStatus({
        type: "success",
        message: serverMessage,
        messageKey: serverMessage ? null : "admin.success",
        params: null,
      });
    } catch (error) {
      if (error.translationKey) {
        setStatus({
          type: "error",
          message: "",
          messageKey: error.translationKey,
          params: error.translationParams || null,
        });
      } else if (error.message) {
        setStatus({
          type: "error",
          message: error.message,
          messageKey: null,
          params: null,
        });
      } else {
        setStatus({
          type: "error",
          message: "",
          messageKey: "admin.errors.unexpected",
          params: null,
        });
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="row justify-content-center">
      <div className="col-12 col-md-8 col-lg-6">
        <div className="card shadow-sm">
          <div className="card-body">
            <h1 className="h4 card-title mb-3">{t("admin.title")}</h1>
            <p className="text-muted">{t("admin.description")}</p>

            <UploadForm
              onSubmit={handleSubmit}
              onFileChange={handleFileChange}
              loading={loading}
              fileName={file ? file.name : ""}
            />

            <StatusAlert status={status} />
          </div>
        </div>
      </div>
    </div>
  );
}