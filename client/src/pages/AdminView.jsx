import { useState } from "react";

const UPLOAD_URL = "http://localhost:8000/api/admin/voters/upload";

function StatusAlert({ status }) {
  if (status.type === "success") {
    return (
      <div className="alert alert-success mt-3" role="alert">
        {status.message}
      </div>
    );
  }
  if (status.type === "error") {
    return (
      <div className="alert alert-danger mt-3" role="alert">
        {status.message}
      </div>
    );
  }
  return null;
}

function UploadForm({ onSubmit, onFileChange, loading, fileName }) {
  return (
    <form onSubmit={onSubmit}>
      <div className="mb-3">
        <label htmlFor="csvFile" className="form-label">
          Voters CSV file
        </label>
        <input
          id="csvFile"
          type="file"
          accept=".csv,text/csv"
          className="form-control"
          onChange={onFileChange}
          disabled={loading}
        />
        {fileName && <div className="form-text">Selected: {fileName}</div>}
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
            Uploading...
          </>
        ) : (
          "Upload CSV"
        )}
      </button>
    </form>
  );
}

export default function AdminView() {
  const [file, setFile] = useState(null);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState({ type: "idle", message: "" });

  const handleFileChange = (event) => {
    const selected = event.target.files[0] || null;
    setFile(selected);
    setStatus({ type: "idle", message: "" });
  };

  const handleSubmit = async (event) => {
    event.preventDefault();

    if (!file) {
      setStatus({ type: "error", message: "Please select a CSV file first." });
      return;
    }

    if (!file.name.toLowerCase().endsWith(".csv")) {
      setStatus({ type: "error", message: "Only .csv files are allowed." });
      return;
    }

    setLoading(true);
    setStatus({ type: "idle", message: "" });

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
          `Request failed with status ${response.status}.`;
        throw new Error(detail);
      }

      const successMessage =
        (payload && typeof payload === "object" && payload.message) ||
        (typeof payload === "string" && payload) ||
        "Voters uploaded successfully.";

      setStatus({ type: "success", message: successMessage });
    } catch (error) {
      setStatus({
        type: "error",
        message: error.message || "An unexpected error occurred.",
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="row justify-content-center">
      <div className="col-12 col-md-8 col-lg-6">
        <div className="card shadow-sm">
          <div className="card-body">
            <h1 className="h4 card-title mb-3">Admin Portal</h1>
            <p className="text-muted">
              Upload a CSV file to register the list of voters.
            </p>

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