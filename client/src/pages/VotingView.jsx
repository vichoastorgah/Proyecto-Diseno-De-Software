import { useState } from "react";
import { useSearchParams } from "react-router-dom";

const API_URL = "http://localhost:8000/api/vote";
const MOTION_ID = "motion-001";
const MOTION_TITLE = "Approve the 2026 annual budget";

function VotingView() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token");

  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState(null);
  // Set to true when the token is invalid (404) or already used (403)
  const [blocked, setBlocked] = useState(!token);

  const initialError = !token ? "Invalid voting token." : null;
  const displayedError = error || initialError;

  const handleVote = async (choice) => {
    if (!token || loading) return;

    setLoading(true);
    setError(null);

    try {
      const response = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, motionId: MOTION_ID, choice }),
      });

      if (response.status === 200) {
        setSuccess(true);
      } else if (response.status === 403) {
        setError("Voter has already cast a vote.");
        setBlocked(true);
      } else if (response.status === 404) {
        setError("Invalid voting token.");
        setBlocked(true);
      } else {
        setError("Unexpected error. Please try again.");
      }
    } catch (err) {
      setError("Unable to reach the server. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const showButtons = !success && !blocked;

  return (
    <div className="container py-4 py-md-5">
      <div className="row justify-content-center">
        <div className="col-12 col-md-8 col-lg-6">
          <div className="card shadow-sm">
            <div className="card-header text-center">
              <h2 className="h5 mb-0">Official Ballot</h2>
            </div>

            <div className="card-body p-4 text-center">
              <h1 className="h4 mb-4">{MOTION_TITLE}</h1>

              {success && (
                <div className="alert alert-success" role="alert">
                  Vote successfully registered.
                </div>
              )}

              {displayedError && (
                <div className="alert alert-danger" role="alert">
                  {displayedError}
                </div>
              )}

              {showButtons && (
                <div className="d-grid gap-3 d-sm-flex justify-content-sm-center">
                  <button
                    type="button"
                    className="btn btn-success btn-lg flex-sm-fill"
                    onClick={() => handleVote("approve")}
                    disabled={loading}
                  >
                    {loading ? (
                      <>
                        <span
                          className="spinner-border spinner-border-sm me-2"
                          role="status"
                          aria-hidden="true"
                        ></span>
                        Sending...
                      </>
                    ) : (
                      "Approve"
                    )}
                  </button>

                  <button
                    type="button"
                    className="btn btn-danger btn-lg flex-sm-fill"
                    onClick={() => handleVote("reject")}
                    disabled={loading}
                  >
                    {loading ? (
                      <>
                        <span
                          className="spinner-border spinner-border-sm me-2"
                          role="status"
                          aria-hidden="true"
                        ></span>
                        Sending...
                      </>
                    ) : (
                      "Reject"
                    )}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default VotingView;