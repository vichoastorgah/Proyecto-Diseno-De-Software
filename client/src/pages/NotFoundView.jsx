import { Link } from "react-router-dom";
import { useLanguage } from "../context/useLanguage";
import { EmptyState } from "../components/ui/Feedback";

export default function NotFoundView() {
  const { t } = useLanguage();
  return (
    <div className="card app-card">
      <h1 className="visually-hidden" tabIndex={-1}>
        {t("notFound.title")}
      </h1>
      <EmptyState
        icon="search"
        title={t("notFound.title")}
        action={
          <Link className="btn btn-primary" to="/">
            {t("notFound.home")}
          </Link>
        }
      >
        {t("notFound.text")}
      </EmptyState>
    </div>
  );
}
