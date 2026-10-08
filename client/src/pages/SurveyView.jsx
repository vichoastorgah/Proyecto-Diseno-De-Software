import { useEffect, useState } from "react";

const SURVEY_URL = "http://localhost:8000/api/survey";

// Adapt this function if the backend field names differ.
function normalizeSurvey(data) {
  const questions = Array.isArray(data)
    ? data
    : data?.questions || data?.items || [];

  const rawCompletion =
    data?.completionPercentage ??
    data?.completion_percentage ??
    data?.completion ??
    0;

  const completion = Math.max(0, Math.min(100, Number(rawCompletion) || 0));

  return { completion, questions };
}

function CompletionProgress({ percentage }) {
  const rounded = Math.round(percentage * 10) / 10;

  return (
    <div className="card shadow-sm mb-4">
      <div className="card-body">
        <h2 className="h5 card-title">Global Progress</h2>
        <div
          className="progress"
          role="progressbar"
          aria-valuenow={rounded}
          aria-valuemin="0"
          aria-valuemax="100"
          style={{ height: "1.5rem" }}
        >
          <div
            className="progress-bar progress-bar-striped bg-success"
            style={{ width: `${rounded}%` }}
          >
            {rounded}%
          </div>
        </div>
      </div>
    </div>
  );
}

function QuestionCard({ question, index }) {
  const title =
    question.text || question.question || question.title || `Question ${index + 1}`;
  const options = Array.isArray(question.options)
    ? question.options
    : Array.isArray(question.answers)
    ? question.answers
    : [];

  return (
    <div className="card h-100 shadow-sm">
      <div className="card-body">
        <h3 className="h6 card-title">
          <span className="badge bg-secondary me-2">{index + 1}</span>
          {title}
        </h3>

        {options.length > 0 && (
          <ul className="list-group list-group-flush mt-3">
            {options.map((option, optionIndex) => {
              const isObject = typeof option === "object" && option !== null;
              const label = isObject
                ? option.label || option.text || option.name || `Option ${optionIndex + 1}`
                : String(option);
              const count = isObject ? option.count ?? option.votes : undefined;

              return (
                <li
                  key={optionIndex}
                  className="list-group-item d-flex justify-content-between align-items-center px-0"
                >
                  <span>{label}</span>
                  {count !== undefined && (
                    <span className="badge bg-primary rounded-pill">{count}</span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

function QuestionGrid({ questions }) {
  if (questions.length === 0) {
    return (
      <div className="alert alert-info" role="alert">
        No questions available yet.
      </div>
    );
  }

  return (
    <div className="row g-3">
      {questions.map((question, index) => (
        <div className="col-12 col-md-6" key={question.id ?? index}>
          <QuestionCard question={question} index={index} />
        </div>
      ))}
    </div>
  );
}

export default function SurveyView() {
  const [survey, setSurvey] = useState({ completion: 0, questions: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();

    const loadSurvey = async () => {
      setLoading(true);
      setError("");

      try {
        const response = await fetch(SURVEY_URL, { signal: controller.signal });

        if (!response.ok) {
          throw new Error(`Request failed with status ${response.status}.`);
        }

        const data = await response.json();
        setSurvey(normalizeSurvey(data));
      } catch (err) {
        if (err.name !== "AbortError") {
          setError(err.message || "Could not load the survey data.");
        }
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    };

    loadSurvey();

    return () => controller.abort();
  }, []);

  if (loading) {
    return (
      <div className="d-flex justify-content-center py-5">
        <div className="spinner-border text-primary" role="status">
          <span className="visually-hidden">Loading...</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="alert alert-danger" role="alert">
        {error}
      </div>
    );
  }

  return (
    <>
      <h1 className="h4 mb-3">Survey Dashboard</h1>
      <CompletionProgress percentage={survey.completion} />
      <QuestionGrid questions={survey.questions} />
    </>
  );
}