/**
 * Turns API errors into translated, human-readable text.
 * Server messages are English fallbacks only: the stable `code` drives the translation.
 */

/** Main message of an error. */
export function errorMessage(t, error, fallbackKey = "errors.unexpected") {
  if (!error) return "";
  const code = error.code;
  if (code) {
    const translated = t(`errors.codes.${code}`, null, null);
    if (translated) return translated;
  }
  if (error.status === 403) return t("errors.codes.FORBIDDEN");
  if (error.status === 404) return t("errors.codes.NOT_FOUND");
  if (error.status >= 500) return t("errors.codes.INTERNAL_ERROR");
  return error.message || t(fallbackKey);
}

/** Context prefix for a detail (CSV row, motion number, question number). */
function detailPrefix(t, detail) {
  if (typeof detail.row !== "number") return "";
  if (detail.code.startsWith("CSV_")) return t("errors.prefix.row", { row: detail.row });
  if (detail.code.startsWith("MOTION_")) return t("errors.prefix.motion", { row: detail.row });
  if (detail.code.startsWith("QUESTION_")) return t("errors.prefix.question", { row: detail.row });
  return "";
}

/** Translated lines for the structured `details` of an error. */
export function errorDetails(t, error) {
  if (!Array.isArray(error?.details)) return [];
  return error.details.map((detail) => {
    const params = { row: detail.row, field: detail.field, value: detail.value, message: detail.message };
    const text = t(`errors.details.${detail.code}`, params, detail.message || detail.code);
    return `${detailPrefix(t, detail)}${text}`;
  });
}
