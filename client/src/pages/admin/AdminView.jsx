import { useCallback } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../../context/useAuth";
import { useLanguage } from "../../context/useLanguage";
import { useResource } from "../../hooks/useResource";
import { EmptyState, ErrorNotice, LoadingState } from "../../components/ui/Feedback";
import { Badge, PageHeader, ProgressBar, Section, StatCard } from "../../components/ui/Layout";
import Icon from "../../components/ui/Icon";
import { formatDate, formatNumber, formatPercent } from "../../utils/format";

/** Admin dashboard: figures, elections and surveys, all loaded from the API. */
export default function AdminView() {
  const { request } = useAuth();
  const { t, locale } = useLanguage();

  const fetchDashboard = useCallback(
    async (signal) => {
      const [summary, elections, surveys] = await Promise.all([
        request("/api/admin/summary", { signal }),
        request("/api/admin/elections", { signal }),
        request("/api/surveys", { signal }),
      ]);
      return { summary, elections: elections.elections, surveys: surveys.surveys };
    },
    [request]
  );
  const { data, error, loading, reload } = useResource(fetchDashboard);

  const actions = (
    <>
      <Link className="btn btn-primary" to="/admin/elections/new">
        <Icon name="plus" className="me-1" />
        {t("admin.newElection")}
      </Link>
      <Link className="btn btn-outline-primary" to="/admin/surveys/new">
        <Icon name="plus" className="me-1" />
        {t("admin.newSurvey")}
      </Link>
    </>
  );

  return (
    <>
      <PageHeader title={t("admin.title")} subtitle={t("admin.subtitle")} actions={actions} />

      {loading && !data && <LoadingState />}
      <ErrorNotice error={error} onRetry={reload} />

      {data && (
        <>
          <div className="row g-3 mb-4">
            <div className="col-6 col-xl-3">
              <StatCard
                icon="ballot"
                label={t("admin.stats.elections")}
                value={formatNumber(data.summary.elections, locale)}
                hint={t("admin.stats.openElections", { count: data.summary.openElections })}
              />
            </div>
            <div className="col-6 col-xl-3">
              <StatCard
                icon="users"
                tone="info"
                label={t("admin.stats.voters")}
                value={formatNumber(data.summary.voters, locale)}
                hint={t("admin.stats.votesCast", { count: formatNumber(data.summary.votesCast, locale) })}
              />
            </div>
            <div className="col-6 col-xl-3">
              <StatCard
                icon="chart"
                tone="success"
                label={t("admin.stats.participation")}
                value={formatPercent(data.summary.participation, locale)}
                hint={t("admin.stats.participationHint")}
              />
            </div>
            <div className="col-6 col-xl-3">
              <StatCard
                icon="survey"
                tone="warning"
                label={t("admin.stats.surveys")}
                value={formatNumber(data.summary.surveys, locale)}
                hint={t("admin.stats.surveyCompletion", { value: formatPercent(data.summary.surveyCompletion, locale) })}
              />
            </div>
          </div>

          <Section
            title={t("admin.elections.title")}
            description={t("admin.elections.description")}
            bodyClassName="p-0"
            actions={
              <button type="button" className="btn btn-sm btn-outline-secondary" onClick={reload} disabled={loading}>
                <Icon name="refresh" size={16} className="me-1" />
                {t("common.refresh")}
              </button>
            }
          >
            {data.elections.length === 0 ? (
              <EmptyState
                icon="ballot"
                title={t("admin.elections.emptyTitle")}
                action={
                  <Link className="btn btn-primary btn-sm" to="/admin/elections/new">
                    {t("admin.newElection")}
                  </Link>
                }
              >
                {t("admin.elections.emptyText")}
              </EmptyState>
            ) : (
              <div className="table-responsive">
                <table className="table app-table align-middle">
                  <thead>
                    <tr>
                      <th scope="col">{t("admin.elections.name")}</th>
                      <th scope="col">{t("admin.elections.status")}</th>
                      <th scope="col" className="d-none d-md-table-cell text-end">{t("admin.elections.motions")}</th>
                      <th scope="col" style={{ minWidth: "11rem" }}>{t("admin.elections.participation")}</th>
                      <th scope="col" className="d-none d-lg-table-cell">{t("admin.elections.created")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.elections.map((election) => (
                      <tr key={election.id}>
                        <td className="text-break-all">
                          <Link className="table-link" to={`/admin/elections/${election.id}`}>
                            {election.title}
                          </Link>
                        </td>
                        <td>
                          <Badge tone={election.status === "open" ? "success" : "secondary"}>
                            {t(`admin.status.${election.status}`)}
                          </Badge>
                        </td>
                        <td className="d-none d-md-table-cell text-end">{election.stats.motionCount}</td>
                        <td>
                          <ProgressBar
                            value={election.stats.participation}
                            tone="success"
                            label={t("admin.elections.participation")}
                            showValue
                            locale={locale}
                          />
                          <div className="small text-body-secondary">
                            {t("admin.elections.votedOf", { voted: election.stats.votedCount, total: election.stats.voterCount })}
                          </div>
                        </td>
                        <td className="d-none d-lg-table-cell text-nowrap">{formatDate(election.createdAt, locale)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>

          <Section title={t("admin.surveys.title")} description={t("admin.surveys.description")} bodyClassName="p-0">
            {data.surveys.length === 0 ? (
              <EmptyState
                icon="survey"
                title={t("admin.surveys.emptyTitle")}
                action={
                  <Link className="btn btn-primary btn-sm" to="/admin/surveys/new">
                    {t("admin.newSurvey")}
                  </Link>
                }
              >
                {t("admin.surveys.emptyText")}
              </EmptyState>
            ) : (
              <div className="table-responsive">
                <table className="table app-table align-middle">
                  <thead>
                    <tr>
                      <th scope="col">{t("admin.surveys.name")}</th>
                      <th scope="col" className="d-none d-md-table-cell">{t("admin.surveys.recipient")}</th>
                      <th scope="col" style={{ minWidth: "11rem" }}>{t("admin.surveys.progress")}</th>
                      <th scope="col" className="d-none d-lg-table-cell">{t("admin.elections.created")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.surveys.map((survey) => (
                      <tr key={survey.id}>
                        <td className="text-break-all">
                          <Link className="table-link" to={`/surveys/${survey.id}`}>
                            {survey.title}
                          </Link>
                        </td>
                        <td className="d-none d-md-table-cell text-break-all">{survey.initialRecipient}</td>
                        <td>
                          <ProgressBar value={survey.progress.completionPercentage} label={t("admin.surveys.progress")} showValue locale={locale} />
                          <div className="small text-body-secondary">
                            {t("admin.surveys.answeredOf", {
                              answered: survey.progress.answeredQuestions,
                              total: survey.progress.totalQuestions,
                            })}
                          </div>
                        </td>
                        <td className="d-none d-lg-table-cell text-nowrap">{formatDate(survey.createdAt, locale)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>
        </>
      )}
    </>
  );
}
