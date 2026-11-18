import { useCallback, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { saveBlob } from "../../api/client";
import { useAuth } from "../../context/useAuth";
import { useLanguage } from "../../context/useLanguage";
import { useResource } from "../../hooks/useResource";
import { EmptyState, ErrorNotice, LoadingState, Notice } from "../../components/ui/Feedback";
import { Badge, PageHeader, Section, StatCard } from "../../components/ui/Layout";
import { ConfirmDialog, Modal } from "../../components/ui/Modal";
import CsvValidationResult from "../../components/CsvValidationResult";
import Icon from "../../components/ui/Icon";
import { formatBytes, formatDateTime, formatNumber, formatPercent, optionLabel } from "../../utils/format";

const PAGE_SIZE = 20;

/** Feedback after creating an election or adding voters. */
function DeliveryNotice({ result, kind, onDismiss }) {
  const { t } = useLanguage();
  if (!result) return null;
  const simulated = result.deliveryMode === "simulated";
  return (
    <Notice
      variant={result.emailsFailed?.length ? "warning" : "success"}
      title={t(`electionDetail.notice.${kind}`, { count: result.imported, email: result.email })}
      details={result.emailsFailed?.length ? [t("electionDetail.failedRecipients", { list: result.emailsFailed.join(", ") })] : []}
      onDismiss={onDismiss}
    >
      {t(simulated ? "electionDetail.emailsSimulated" : "electionDetail.emailsSent", { count: result.emailsSent })}
    </Notice>
  );
}

function MotionResults({ motion }) {
  const { t, locale } = useLanguage();
  const leadingWeight = Math.max(0, ...motion.options.map((option) => option.weight));
  return (
    <div className="card app-card h-100">
      <div className="card-body">
        <div className="d-flex align-items-start gap-2 mb-3">
          <span className="motion-number">{motion.position}</span>
          <div className="min-w-0 flex-grow-1">
            <h3 className="h6 mb-1 text-break-all">{motion.title}</h3>
            {motion.description && <p className="small text-body-secondary mb-0" style={{ whiteSpace: "pre-line" }}>{motion.description}</p>}
          </div>
        </div>

        {motion.options.map((option) => {
          const leading = leadingWeight > 0 && option.weight === leadingWeight;
          return (
            <div key={option.id} className={`result-row ${leading ? "leading" : ""}`}>
              <div className="d-flex justify-content-between gap-2 small mb-1">
                <span className="fw-semibold text-break-all">
                  {optionLabel(t, option.label)}
                  {leading && <span className="visually-hidden"> ({t("electionDetail.leading")})</span>}
                </span>
                <span className="text-nowrap text-body-secondary">
                  {formatPercent(option.percentage, locale)} · {t("electionDetail.weight", { value: formatNumber(option.weight, locale) })}
                </span>
              </div>
              <div className="result-bar" aria-hidden="true">
                <span style={{ width: `${option.percentage}%` }} />
              </div>
              <div className="small text-body-secondary mt-1">{t("electionDetail.ballots", { count: option.votes })}</div>
            </div>
          );
        })}

        <div className="d-flex flex-wrap gap-2 mt-3 pt-3 border-top">
          <Badge tone="secondary">{t("electionDetail.totalWeight", { value: formatNumber(motion.totalWeight, locale) })}</Badge>
          {motion.integrity.ok ? (
            <Badge tone="success" icon="shield">{t("electionDetail.integrityOk")}</Badge>
          ) : (
            <Badge tone="danger" icon="alert">
              {t("electionDetail.integrityError", {
                expected: formatNumber(motion.integrity.expectedWeight, locale),
                recorded: formatNumber(motion.integrity.recordedWeight, locale),
              })}
            </Badge>
          )}
          {motion.includesLegacyTally && <Badge tone="warning">{t("electionDetail.legacyTally")}</Badge>}
        </div>
      </div>
    </div>
  );
}

function voterStatus(voter, t) {
  if (voter.hasVoted) return <Badge tone="success" icon="check">{t("electionDetail.voters.voted")}</Badge>;
  if (voter.isExpired) return <Badge tone="danger" icon="clock">{t("electionDetail.voters.expired")}</Badge>;
  return <Badge tone="warning">{t("electionDetail.voters.pending")}</Badge>;
}

function VotersSection({ electionId, open, refreshKey, onResent }) {
  const { request } = useAuth();
  const { t, language, locale } = useLanguage();
  const [query, setQuery] = useState({ search: "", status: "all", page: 1 });
  const [searchDraft, setSearchDraft] = useState("");
  const [resendTarget, setResendTarget] = useState(null);
  const [resending, setResending] = useState(false);
  const [actionError, setActionError] = useState(null);

  const fetchVoters = useCallback(
    (signal) => {
      const params = new URLSearchParams({ search: query.search, status: query.status, page: String(query.page), pageSize: String(PAGE_SIZE) });
      return request(`/api/admin/elections/${electionId}/voters?${params}&r=${refreshKey}`, { signal });
    },
    [request, electionId, query, refreshKey]
  );
  const { data, error, loading, reload } = useResource(fetchVoters);
  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  const resend = async () => {
    setResending(true);
    setActionError(null);
    try {
      const result = await request(`/api/admin/elections/${electionId}/voters/${resendTarget.id}/resend?lang=${language}`, { method: "POST" });
      onResent({ ...result, imported: 1, email: resendTarget.email });
      setResendTarget(null);
      reload();
    } catch (caught) {
      setActionError(caught);
      setResendTarget(null);
    } finally {
      setResending(false);
    }
  };

  return (
    <Section title={t("electionDetail.voters.title")} description={t("electionDetail.voters.description")} bodyClassName="p-0">
      <div className="p-3 border-bottom">
        <form
          className="row g-2 align-items-end"
          role="search"
          onSubmit={(event) => {
            event.preventDefault();
            setQuery((current) => ({ ...current, search: searchDraft.trim(), page: 1 }));
          }}
        >
          <div className="col-12 col-md-6">
            <label className="form-label small mb-1" htmlFor="voter-search">{t("electionDetail.voters.search")}</label>
            <div className="input-group">
              <input
                id="voter-search"
                type="search"
                className="form-control"
                value={searchDraft}
                placeholder={t("electionDetail.voters.searchPlaceholder")}
                onChange={(event) => setSearchDraft(event.target.value)}
              />
              <button type="submit" className="btn btn-outline-secondary" aria-label={t("electionDetail.voters.search")}>
                <Icon name="search" size={16} />
              </button>
            </div>
          </div>
          <div className="col-12 col-md-3">
            <label className="form-label small mb-1" htmlFor="voter-status">{t("electionDetail.voters.filter")}</label>
            <select
              id="voter-status"
              className="form-select"
              value={query.status}
              onChange={(event) => setQuery((current) => ({ ...current, status: event.target.value, page: 1 }))}
            >
              <option value="all">{t("electionDetail.voters.all")}</option>
              <option value="voted">{t("electionDetail.voters.voted")}</option>
              <option value="pending">{t("electionDetail.voters.notVoted")}</option>
            </select>
          </div>
          <div className="col-12 col-md-3 small text-body-secondary text-md-end" aria-live="polite">
            {data && t("electionDetail.voters.count", { count: data.total })}
          </div>
        </form>
      </div>

      <div className="px-3 pt-3">
        <ErrorNotice error={error || actionError} onRetry={error ? reload : undefined} onDismiss={actionError ? () => setActionError(null) : undefined} />
      </div>
      {loading && !data && <LoadingState compact />}
      {data && data.items.length === 0 && <EmptyState icon="users" title={t("electionDetail.voters.empty")} />}
      {data && data.items.length > 0 && (
        <div className="table-responsive">
          <table className="table app-table align-middle">
            <thead>
              <tr>
                <th scope="col">{t("electionDetail.voters.name")}</th>
                <th scope="col" className="d-none d-md-table-cell text-end">{t("electionDetail.voters.weight")}</th>
                <th scope="col">{t("electionDetail.voters.status")}</th>
                <th scope="col" className="d-none d-lg-table-cell">{t("electionDetail.voters.invitation")}</th>
                <th scope="col" className="text-end"><span className="visually-hidden">{t("common.actions")}</span></th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((voter) => (
                <tr key={voter.id}>
                  <td className="text-break-all">
                    <div className="fw-semibold">{voter.name}</div>
                    <div className="small text-body-secondary">{voter.email}</div>
                    <div className="small text-body-secondary d-md-none">{t("electionDetail.voters.weightShort", { value: formatNumber(voter.weight, locale) })}</div>
                  </td>
                  <td className="d-none d-md-table-cell text-end">{formatNumber(voter.weight, locale)}</td>
                  <td>
                    {voterStatus(voter, t)}
                    {voter.votedAt && <div className="small text-body-secondary mt-1">{formatDateTime(voter.votedAt, locale)}</div>}
                  </td>
                  <td className="d-none d-lg-table-cell small">{t(`electionDetail.invitation.${voter.invitationStatus}`)}</td>
                  <td className="text-end">
                    {!voter.hasVoted && open && (
                      <button type="button" className="btn btn-sm btn-outline-primary text-nowrap" onClick={() => setResendTarget(voter)}>
                        <Icon name="mail" size={16} className="me-1" />
                        <span className="d-none d-sm-inline">{t("electionDetail.voters.resend")}</span>
                        <span className="visually-hidden d-sm-none">{t("electionDetail.voters.resend")}</span>
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data && totalPages > 1 && (
        <nav className="d-flex justify-content-between align-items-center p-3 border-top" aria-label={t("common.pagination")}>
          <button
            type="button"
            className="btn btn-sm btn-outline-secondary"
            disabled={query.page <= 1 || loading}
            onClick={() => setQuery((current) => ({ ...current, page: current.page - 1 }))}
          >
            <Icon name="arrowLeft" size={16} className="me-1" />
            {t("common.previous")}
          </button>
          <span className="small text-body-secondary">{t("common.pageOf", { page: query.page, total: totalPages })}</span>
          <button
            type="button"
            className="btn btn-sm btn-outline-secondary"
            disabled={query.page >= totalPages || loading}
            onClick={() => setQuery((current) => ({ ...current, page: current.page + 1 }))}
          >
            {t("common.next")}
            <Icon name="arrowRight" size={16} className="ms-1" />
          </button>
        </nav>
      )}

      <ConfirmDialog
        open={Boolean(resendTarget)}
        title={t("electionDetail.voters.resendTitle")}
        message={resendTarget ? t("electionDetail.voters.resendText", { name: resendTarget.name, email: resendTarget.email }) : ""}
        confirmLabel={t("electionDetail.voters.resend")}
        busy={resending}
        onCancel={() => setResendTarget(null)}
        onConfirm={resend}
      />
    </Section>
  );
}

function AddVotersModal({ open, electionId, onClose, onAdded }) {
  const { request } = useAuth();
  const { t, language } = useLanguage();
  const [file, setFile] = useState(null);
  const [check, setCheck] = useState({ status: "idle", result: null, error: null });
  const [emailLanguage, setEmailLanguage] = useState(language);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const close = () => {
    setFile(null);
    setCheck({ status: "idle", result: null, error: null });
    setError(null);
    onClose();
  };

  const onFile = async (selected) => {
    setFile(selected);
    setError(null);
    if (!selected) return setCheck({ status: "idle", result: null, error: null });
    setCheck({ status: "checking", result: null, error: null });
    const form = new FormData();
    form.set("votersCsv", selected);
    try {
      const result = await request("/api/admin/csv/validate", { method: "POST", form });
      setCheck({ status: result.errors.length ? "invalid" : "valid", result, error: null });
    } catch (caught) {
      setCheck({ status: "invalid", result: null, error: caught });
    }
  };

  const submit = async () => {
    setSaving(true);
    setError(null);
    const form = new FormData();
    form.set("votersCsv", file);
    form.set("lang", emailLanguage);
    try {
      const result = await request(`/api/admin/elections/${electionId}/voters`, { method: "POST", form });
      onAdded(result);
      close();
    } catch (caught) {
      setError(caught);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      title={t("electionDetail.addVoters")}
      onClose={close}
      busy={saving}
      size="modal-lg"
      footer={
        <>
          <button type="button" className="btn btn-outline-secondary" onClick={close} disabled={saving}>
            {t("common.cancel")}
          </button>
          <button type="button" className="btn btn-primary" onClick={submit} disabled={saving || check.status !== "valid"}>
            {saving && <span className="spinner-border spinner-border-sm me-2" aria-hidden="true" />}
            {t("electionDetail.addVotersSubmit")}
          </button>
        </>
      }
    >
      <p className="text-body-secondary">{t("electionDetail.addVotersHelp")}</p>
      <div className="mb-3">
        <label className="form-label" htmlFor="add-voters-csv">{t("electionForm.csvLabel")}</label>
        <input id="add-voters-csv" type="file" accept=".csv,text/csv" className="form-control" onChange={(event) => onFile(event.target.files?.[0] ?? null)} />
      </div>
      <div className="mb-3">
        <label className="form-label" htmlFor="add-voters-language">{t("electionForm.emailLanguage")}</label>
        <select id="add-voters-language" className="form-select" value={emailLanguage} onChange={(event) => setEmailLanguage(event.target.value)}>
          <option value="es">{t("languages.es")}</option>
          <option value="en">{t("languages.en")}</option>
        </select>
      </div>
      <CsvValidationResult check={check} />
      <ErrorNotice error={error} className="mt-3" />
    </Modal>
  );
}

export default function ElectionDetailView() {
  const { electionId } = useParams();
  const { request } = useAuth();
  const { t, locale } = useLanguage();
  const location = useLocation();
  const navigate = useNavigate();

  const [notice, setNotice] = useState(() => (location.state?.created ? { kind: "created", result: location.state.created } : null));
  const [confirmStatus, setConfirmStatus] = useState(false);
  const [statusBusy, setStatusBusy] = useState(false);
  const [actionError, setActionError] = useState(null);
  const [addOpen, setAddOpen] = useState(false);
  const [votersKey, setVotersKey] = useState(0);

  const fetchElection = useCallback((signal) => request(`/api/admin/elections/${electionId}`, { signal }), [request, electionId]);
  const { data: election, error, loading, reload } = useResource(fetchElection);

  const toggleStatus = async () => {
    setStatusBusy(true);
    setActionError(null);
    try {
      await request(`/api/admin/elections/${electionId}/status`, {
        method: "POST",
        json: { status: election.status === "open" ? "closed" : "open" },
      });
      setConfirmStatus(false);
      await reload();
    } catch (caught) {
      setActionError(caught);
      setConfirmStatus(false);
    } finally {
      setStatusBusy(false);
    }
  };

  const download = async (attachment) => {
    setActionError(null);
    try {
      const { blob, fileName } = await request(`/api/admin/elections/${electionId}/attachments/${attachment.id}`, { responseType: "blob" });
      saveBlob(blob, fileName || attachment.name);
    } catch (caught) {
      setActionError(caught);
    }
  };

  // Drop the creation notice from history so a refresh does not show it again.
  const dismissNotice = () => {
    setNotice(null);
    if (location.state?.created) navigate(location.pathname, { replace: true, state: null });
  };

  if (loading && !election) return <LoadingState />;
  if (error && !election) {
    return (
      <>
        <PageHeader title={t("electionDetail.title")} backTo="/admin" backLabel={t("admin.title")} />
        <ErrorNotice error={error} onRetry={reload} />
      </>
    );
  }

  const isOpen = election.status === "open";
  const stats = election.stats;
  const invitations = election.invitations;

  return (
    <>
      <PageHeader
        title={election.title}
        backTo="/admin"
        backLabel={t("admin.title")}
        badges={
          <>
            <Badge tone={isOpen ? "success" : "secondary"} icon={isOpen ? "ballot" : "lock"}>
              {t(`admin.status.${election.status}`)}
            </Badge>
            <Badge tone="secondary" icon="clock">{t("electionDetail.createdAt", { date: formatDateTime(election.createdAt, locale) })}</Badge>
          </>
        }
        actions={
          <>
            <button type="button" className="btn btn-outline-secondary" onClick={() => { reload(); setVotersKey((key) => key + 1); }} disabled={loading}>
              <Icon name="refresh" className="me-1" />
              {t("common.refresh")}
            </button>
            {isOpen && (
              <button type="button" className="btn btn-outline-primary" onClick={() => setAddOpen(true)}>
                <Icon name="users" className="me-1" />
                {t("electionDetail.addVoters")}
              </button>
            )}
            <button type="button" className={`btn ${isOpen ? "btn-outline-danger" : "btn-primary"}`} onClick={() => setConfirmStatus(true)}>
              <Icon name={isOpen ? "lock" : "ballot"} className="me-1" />
              {isOpen ? t("electionDetail.close") : t("electionDetail.reopen")}
            </button>
          </>
        }
      />

      {notice && <DeliveryNotice result={notice.result} kind={notice.kind} onDismiss={dismissNotice} />}
      <ErrorNotice error={actionError} onDismiss={() => setActionError(null)} />

      <div className="row g-3 mb-4">
        <div className="col-6 col-lg-3">
          <StatCard icon="users" label={t("electionDetail.stats.voters")} value={formatNumber(stats.voterCount, locale)} hint={t("electionDetail.stats.pending", { count: stats.pendingCount })} />
        </div>
        <div className="col-6 col-lg-3">
          <StatCard icon="check" tone="success" label={t("electionDetail.stats.voted")} value={formatNumber(stats.votedCount, locale)} />
        </div>
        <div className="col-6 col-lg-3">
          <StatCard icon="chart" tone="info" label={t("electionDetail.stats.participation")} value={formatPercent(stats.participation, locale)} />
        </div>
        <div className="col-6 col-lg-3">
          <StatCard
            icon="chart"
            tone="warning"
            label={t("electionDetail.stats.weighted")}
            value={formatPercent(stats.weightedParticipation, locale)}
            hint={t("electionDetail.stats.weightOf", { voted: formatNumber(stats.votedWeight, locale), total: formatNumber(stats.totalWeight, locale) })}
          />
        </div>
      </div>

      <div className="row g-4">
        <div className="col-12 col-xl-8">
          <Section title={t("electionDetail.results")} description={t("electionDetail.resultsDescription")}>
            <div className="row g-3">
              {election.motions.map((motion) => (
                <div key={motion.id} className={election.motions.length > 1 ? "col-12 col-lg-6" : "col-12"}>
                  <MotionResults motion={motion} />
                </div>
              ))}
            </div>
          </Section>
        </div>
        <div className="col-12 col-xl-4">
          <Section title={t("electionDetail.summary")}>
            {election.description ? (
              <p style={{ whiteSpace: "pre-line" }}>{election.description}</p>
            ) : (
              <p className="text-body-secondary">{t("electionDetail.noDescription")}</p>
            )}
            <h3 className="h6 mt-3">{t("electionDetail.invitationsTitle")}</h3>
            <ul className="list-unstyled small mb-0 d-grid gap-1">
              {Object.entries(invitations)
                .filter(([, count]) => count > 0)
                .map(([status, count]) => (
                  <li key={status} className="d-flex justify-content-between">
                    <span>{t(`electionDetail.invitation.${status}`)}</span>
                    <span className="fw-semibold">{count}</span>
                  </li>
                ))}
            </ul>
            <h3 className="h6 mt-4">{t("electionDetail.attachments")}</h3>
            {election.attachments.length === 0 ? (
              <p className="small text-body-secondary mb-0">{t("electionDetail.noAttachments")}</p>
            ) : (
              <ul className="list-unstyled mb-0 d-grid gap-2">
                {election.attachments.map((attachment) => (
                  <li key={attachment.id}>
                    <button type="button" className="btn btn-link p-0 text-start d-inline-flex gap-2 text-break-all" onClick={() => download(attachment)}>
                      <Icon name="download" size={16} className="mt-1" />
                      <span>
                        {attachment.name} <span className="text-body-secondary small">({formatBytes(attachment.size, locale)})</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>
      </div>

      <VotersSection
        electionId={electionId}
        open={isOpen}
        refreshKey={votersKey}
        onResent={(result) => setNotice({ kind: "resent", result: { ...result, imported: 1 } })}
      />

      <AddVotersModal
        open={addOpen}
        electionId={electionId}
        onClose={() => setAddOpen(false)}
        onAdded={(result) => {
          setNotice({ kind: "added", result });
          setVotersKey((key) => key + 1);
          reload();
        }}
      />

      <ConfirmDialog
        open={confirmStatus}
        title={isOpen ? t("electionDetail.closeTitle") : t("electionDetail.reopenTitle")}
        message={isOpen ? t("electionDetail.closeText") : t("electionDetail.reopenText")}
        confirmLabel={isOpen ? t("electionDetail.close") : t("electionDetail.reopen")}
        tone={isOpen ? "danger" : "primary"}
        busy={statusBusy}
        onCancel={() => setConfirmStatus(false)}
        onConfirm={toggleStatus}
      />
    </>
  );
}
