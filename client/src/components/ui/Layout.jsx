import { Link } from "react-router-dom";
import Icon from "./Icon";

/** Page title block with optional back link, subtitle, badges and actions. */
export function PageHeader({ title, subtitle, backTo, backLabel, actions, badges }) {
  return (
    <header className="page-header mb-4">
      {backTo && (
        <Link to={backTo} className="back-link small d-inline-flex align-items-center gap-1 mb-2">
          <Icon name="arrowLeft" size={16} />
          {backLabel}
        </Link>
      )}
      <div className="d-flex flex-column flex-md-row align-items-md-end justify-content-between gap-3">
        <div className="min-w-0">
          <h1 className="page-title mb-1" tabIndex={-1}>
            {title}
          </h1>
          {badges && <div className="d-flex flex-wrap gap-2 mb-1">{badges}</div>}
          {subtitle && <p className="text-body-secondary mb-0">{subtitle}</p>}
        </div>
        {actions && <div className="page-actions d-flex flex-wrap gap-2">{actions}</div>}
      </div>
    </header>
  );
}

/** Card section with header, optional description and actions. */
export function Section({ title, description, actions, children, className = "", bodyClassName = "" }) {
  return (
    <section className={`card app-card mb-4 ${className}`}>
      {(title || actions) && (
        <div className="card-header app-card-header d-flex flex-wrap align-items-center justify-content-between gap-2">
          <div className="min-w-0">
            {title && <h2 className="h6 mb-0">{title}</h2>}
            {description && <p className="small text-body-secondary mb-0 mt-1">{description}</p>}
          </div>
          {actions && <div className="d-flex flex-wrap gap-2">{actions}</div>}
        </div>
      )}
      <div className={`card-body ${bodyClassName}`}>{children}</div>
    </section>
  );
}

/** Figure tile for dashboards. Only real values are passed in. */
export function StatCard({ icon, label, value, hint, tone = "primary" }) {
  return (
    <div className="card app-card stat-card h-100">
      <div className="card-body d-flex align-items-start gap-3">
        <div className={`stat-icon stat-icon-${tone}`}>
          <Icon name={icon} size={20} />
        </div>
        <div className="min-w-0">
          <div className="stat-label">{label}</div>
          <div className="stat-value">{value}</div>
          {hint && <div className="stat-hint">{hint}</div>}
        </div>
      </div>
    </div>
  );
}

/** Accessible progress bar. */
export function ProgressBar({ value, label, tone = "primary", height = 8, showValue = false, locale }) {
  const safe = Math.max(0, Math.min(100, Number(value) || 0));
  return (
    <div className="d-flex align-items-center gap-2">
      <div
        className="progress flex-grow-1"
        role="progressbar"
        aria-label={label}
        aria-valuenow={safe}
        aria-valuemin={0}
        aria-valuemax={100}
        style={{ height }}
      >
        <div className={`progress-bar bg-${tone}`} style={{ width: `${safe}%` }} />
      </div>
      {showValue && (
        <span className="small fw-semibold text-nowrap progress-value">
          {safe.toLocaleString(locale, { maximumFractionDigits: 1 })}%
        </span>
      )}
    </div>
  );
}

/** Small status pill. */
export function Badge({ tone = "secondary", children, icon }) {
  return (
    <span className={`badge app-badge app-badge-${tone}`}>
      {icon && <Icon name={icon} size={13} className="me-1" />}
      {children}
    </span>
  );
}
