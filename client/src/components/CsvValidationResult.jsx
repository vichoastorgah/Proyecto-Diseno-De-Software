import { useLanguage } from "../context/useLanguage";
import { errorDetails } from "../utils/errors";
import { formatNumber } from "../utils/format";
import { ErrorNotice, LoadingState, Notice } from "./ui/Feedback";

/**
 * Shows the server-side check of a voters CSV: summary + first rows, or the
 * translated list of problems (row and field) so the file can be fixed before sending.
 *
 * @param {{ check: { status: "idle"|"checking"|"valid"|"invalid", result: object|null, error: unknown } }} props
 */
export default function CsvValidationResult({ check }) {
  const { t, locale } = useLanguage();

  if (check.status === "idle") return null;
  if (check.status === "checking") return <LoadingState compact label={t("csv.checking")} />;
  if (check.error) return <ErrorNotice error={check.error} />;

  const { result } = check;
  if (result.errors.length > 0) {
    return (
      <Notice
        variant="danger"
        title={t("csv.invalidTitle", { count: result.errors.length })}
        details={errorDetails(t, { details: result.errors })}
      >
        {t("csv.invalidText")}
      </Notice>
    );
  }

  return (
    <>
      <Notice variant="success" title={t("csv.validTitle", { count: result.validRecords })}>
        {t("csv.validText", { weight: formatNumber(result.totalWeight, locale) })}
      </Notice>
      <div className="table-responsive border rounded">
        <table className="table app-table table-sm mb-0">
          <caption className="px-3 small">{t("csv.previewCaption", { shown: result.preview.length, total: result.validRecords })}</caption>
          <thead>
            <tr>
              <th scope="col">{t("csv.columns.name")}</th>
              <th scope="col">{t("csv.columns.email")}</th>
              <th scope="col" className="d-none d-sm-table-cell">{t("csv.columns.gender")}</th>
              <th scope="col" className="text-end">{t("csv.columns.weight")}</th>
            </tr>
          </thead>
          <tbody>
            {result.preview.map((row) => (
              <tr key={row.email}>
                <td className="text-break-all">{row.name}</td>
                <td className="text-break-all">{row.email}</td>
                <td className="d-none d-sm-table-cell">{t(`gender.${row.gender}`)}</td>
                <td className="text-end">{formatNumber(row.weight, locale)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
