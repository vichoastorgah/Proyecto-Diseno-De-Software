import { useState } from "react";
import { useAuth } from "../context/useAuth";
import { useLanguage } from "../context/useLanguage";
import { isValidEmail } from "../utils/format";
import Icon from "./ui/Icon";

/**
 * Demo mode only (server flag ALLOW_DEMO_SURVEY_IDENTITY + admin session): lets the presenter
 * act as another person to show delegation with a single Google account. The server ignores
 * the impersonation header for anyone else.
 */
export default function DemoIdentityBar() {
  const { demoSurveyIdentity, actAs, setActAs, user } = useAuth();
  const { t } = useLanguage();
  const [draft, setDraft] = useState(actAs);

  if (!demoSurveyIdentity) return null;
  const invalid = draft.trim() !== "" && !isValidEmail(draft);

  return (
    <div className="alert alert-warning notice mb-4" role="region" aria-label={t("demo.title")}>
      <div className="d-flex gap-2 mb-2">
        <Icon name="user" className="mt-1" />
        <div>
          <div className="fw-semibold">{t("demo.title")}</div>
          <div className="small">
            {actAs ? t("demo.actingAs", { email: actAs }) : t("demo.actingAsSelf", { email: user?.email ?? "" })}
          </div>
        </div>
      </div>
      <form
        className="row g-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (!invalid) setActAs(draft);
        }}
      >
        <div className="col-12 col-md">
          <label className="visually-hidden" htmlFor="demo-act-as">{t("demo.label")}</label>
          <input
            id="demo-act-as"
            type="email"
            className={`form-control form-control-sm ${invalid ? "is-invalid" : ""}`}
            placeholder={t("demo.placeholder")}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
        </div>
        <div className="col-6 col-md-auto">
          <button type="submit" className="btn btn-sm btn-dark w-100" disabled={invalid || !draft.trim()}>
            {t("demo.apply")}
          </button>
        </div>
        <div className="col-6 col-md-auto">
          <button
            type="button"
            className="btn btn-sm btn-outline-dark w-100"
            disabled={!actAs}
            onClick={() => {
              setDraft("");
              setActAs("");
            }}
          >
            {t("demo.reset")}
          </button>
        </div>
      </form>
    </div>
  );
}
