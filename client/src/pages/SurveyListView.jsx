import { useCallback } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../context/useAuth";
import { useLanguage } from "../context/useLanguage";
import { useResource } from "../hooks/useResource";
import { EmptyState, ErrorNotice, LoadingState } from "../components/ui/Feedback";
import { Badge, PageHeader, ProgressBar } from "../components/ui/Layout";
import DemoIdentityBar from "../components/DemoIdentityBar";
import Icon from "../components/ui/Icon";
import { formatDate } from "../utils/format";

const ROLE_TONES = { admin: "dark", recipient: "primary", participant: "secondary" };

/** Surveys addressed to (or delegated to) the signed-in person. */
export default function SurveyListView() {
  const { request, isAdmin } = useAuth();
  const { t, locale } = useLanguage();

  const fetchSurveys = useCallback(
    // `request` changes with the demo identity, so the list reloads when it changes.
    (signal) => request("/api/surveys", { signal, withActAs: true }).then((body) => body.surveys),
    [request]
  );
  const { data: surveys, error, loading, reload } = useResource(fetchSurveys);

  return (
    <>
      <PageHeader
        title={t("surveys.title")}
        subtitle={t("surveys.subtitle")}
        actions={
          isAdmin && (
            <Link className="btn btn-primary" to="/admin/surveys/new">
              <Icon name="plus" className="me-1" />
              {t("admin.newSurvey")}
            </Link>
          )
        }
      />
      <DemoIdentityBar />

      {loading && !surveys && <LoadingState />}
      <ErrorNotice error={error} onRetry={reload} />

      {surveys && surveys.length === 0 && (
        <div className="card app-card">
          <EmptyState icon="survey" title={t("surveys.emptyTitle")}>
            {t("surveys.emptyText")}
          </EmptyState>
        </div>
      )}

      {surveys && surveys.length > 0 && (
        <div className="row g-3">
          {surveys.map((survey) => (
            <div key={survey.id} className="col-12 col-md-6 col-xl-4">
              <article className="card app-card h-100">
                <div className="card-body d-flex flex-column">
                  <div className="d-flex flex-wrap gap-2 mb-2">
                    <Badge tone={ROLE_TONES[survey.viewerRole]}>{t(`roles.${survey.viewerRole}`)}</Badge>
                    {survey.myPendingQuestions > 0 && (
                      <Badge tone="warning" icon="clock">
                        {t("surveys.myPending", { count: survey.myPendingQuestions })}
                      </Badge>
                    )}
                  </div>
                  <h2 className="h5 text-break-all">{survey.title}</h2>
                  <p className="small text-body-secondary mb-3">
                    {t("surveys.recipientOn", { email: survey.initialRecipient, date: formatDate(survey.createdAt, locale) })}
                  </p>
                  <div className="mt-auto">
                    <ProgressBar value={survey.progress.completionPercentage} label={t("surveys.progress")} showValue locale={locale} />
                    <div className="small text-body-secondary mb-3">
                      {t("admin.surveys.answeredOf", { answered: survey.progress.answeredQuestions, total: survey.progress.totalQuestions })}
                    </div>
                    <Link className="btn btn-outline-primary w-100" to={`/surveys/${survey.id}`}>
                      {t("surveys.open")}
                      <Icon name="arrowRight" size={16} className="ms-1" />
                    </Link>
                  </div>
                </div>
              </article>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
