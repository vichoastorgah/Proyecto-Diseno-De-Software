import { useLanguage } from "../../context/useLanguage";
import { errorDetails, errorMessage } from "../../utils/errors";
import Icon from "./Icon";

/** Centered spinner with an accessible label. */
export function LoadingState({ label, compact = false }) {
  const { t } = useLanguage();
  return (
    <div className={`d-flex align-items-center justify-content-center gap-2 text-body-secondary ${compact ? "py-3" : "py-5"}`} role="status">
      <span className="spinner-border spinner-border-sm" aria-hidden="true" />
      <span>{label ?? t("common.loading")}</span>
    </div>
  );
}

/** Friendly empty state with an optional call to action. */
export function EmptyState({ icon = "info", title, children, action }) {
  return (
    <div className="empty-state text-center">
      <div className="empty-state-icon mx-auto mb-3">
        <Icon name={icon} size={26} />
      </div>
      <h2 className="h6 mb-1">{title}</h2>
      {children && <p className="text-body-secondary small mb-3">{children}</p>}
      {action}
    </div>
  );
}

const VARIANT_ICONS = { success: "check", danger: "alert", warning: "alert", info: "info" };

/** Bootstrap alert with icon, optional title, details list and dismiss button. */
export function Notice({ variant = "info", title, children, details = [], onDismiss, className = "" }) {
  return (
    <div
      className={`alert alert-${variant} notice d-flex gap-2 ${className}`}
      role={variant === "danger" || variant === "warning" ? "alert" : "status"}
    >
      <Icon name={VARIANT_ICONS[variant] ?? "info"} className="flex-shrink-0 mt-1" />
      <div className="flex-grow-1 min-w-0">
        {title && <div className="fw-semibold">{title}</div>}
        {children && <div>{children}</div>}
        {details.length > 0 && (
          <ul className="notice-details small mb-0 mt-2 ps-3">
            {details.map((detail, index) => (
              <li key={`${index}-${detail}`}>{detail}</li>
            ))}
          </ul>
        )}
      </div>
      {onDismiss && <CloseButton onClick={onDismiss} />}
    </div>
  );
}

function CloseButton({ onClick }) {
  const { t } = useLanguage();
  return <button type="button" className="btn-close flex-shrink-0" aria-label={t("common.close")} onClick={onClick} />;
}

/** Translated alert for an API error (message + structured details). */
export function ErrorNotice({ error, onRetry, onDismiss, className = "" }) {
  const { t } = useLanguage();
  if (!error) return null;
  return (
    <Notice variant="danger" details={errorDetails(t, error)} onDismiss={onDismiss} className={className}>
      {errorMessage(t, error)}
      {onRetry && (
        <div className="mt-2">
          <button type="button" className="btn btn-sm btn-outline-danger" onClick={onRetry}>
            <Icon name="refresh" size={16} className="me-1" />
            {t("common.retry")}
          </button>
        </div>
      )}
    </Notice>
  );
}
