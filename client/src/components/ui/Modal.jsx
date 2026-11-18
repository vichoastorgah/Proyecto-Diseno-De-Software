import { useEffect, useId, useRef } from "react";
import { useLanguage } from "../../context/useLanguage";

/**
 * Bootstrap-styled modal controlled by React (no Bootstrap JS).
 * Closes on Escape and backdrop click, traps focus inside and restores it on close.
 */
export function Modal({ open, title, onClose, children, footer, size = "", busy = false }) {
  const { t } = useLanguage();
  const titleId = useId();
  const dialogRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const previouslyFocused = document.activeElement;
    const dialog = dialogRef.current;
    const focusables = () =>
      dialog
        ? [...dialog.querySelectorAll("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])")].filter(
            (element) => !element.disabled
          )
        : [];
    (focusables().find((element) => element.dataset.autofocus !== undefined) ?? focusables()[0])?.focus();

    const onKeyDown = (event) => {
      if (event.key === "Escape" && !busy) {
        event.stopPropagation();
        onClose();
      } else if (event.key === "Tab") {
        const items = focusables();
        if (items.length === 0) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKeyDown);
    document.body.classList.add("modal-open");
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.classList.remove("modal-open");
      previouslyFocused?.focus?.();
    };
  }, [open, onClose, busy]);

  if (!open) return null;

  return (
    <>
      <div
        className="modal d-block"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(event) => {
          if (event.target === event.currentTarget && !busy) onClose();
        }}
      >
        <div className={`modal-dialog modal-dialog-centered modal-dialog-scrollable ${size}`} ref={dialogRef}>
          <div className="modal-content">
            <div className="modal-header">
              <h2 className="modal-title h5" id={titleId}>
                {title}
              </h2>
              <button type="button" className="btn-close" aria-label={t("common.close")} onClick={onClose} disabled={busy} />
            </div>
            <div className="modal-body">{children}</div>
            {footer && <div className="modal-footer">{footer}</div>}
          </div>
        </div>
      </div>
      <div className="modal-backdrop show" />
    </>
  );
}

/** Confirmation dialog for consequential actions. */
export function ConfirmDialog({ open, title, message, confirmLabel, tone = "primary", busy, onConfirm, onCancel, children }) {
  const { t } = useLanguage();
  return (
    <Modal
      open={open}
      title={title}
      onClose={onCancel}
      busy={busy}
      footer={
        <>
          <button type="button" className="btn btn-outline-secondary" onClick={onCancel} disabled={busy}>
            {t("common.cancel")}
          </button>
          <button type="button" className={`btn btn-${tone}`} onClick={onConfirm} disabled={busy} data-autofocus>
            {busy && <span className="spinner-border spinner-border-sm me-2" aria-hidden="true" />}
            {confirmLabel}
          </button>
        </>
      }
    >
      {message && <p className="mb-0">{message}</p>}
      {children}
    </Modal>
  );
}
