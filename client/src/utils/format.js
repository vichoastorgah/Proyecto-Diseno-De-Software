/** Locale-aware formatting helpers (pure functions). */

export function formatDateTime(value, locale) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
}

export function formatDate(value, locale) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString(locale, { dateStyle: "medium" });
}

export function formatNumber(value, locale, maximumFractionDigits = 2) {
  return Number(value ?? 0).toLocaleString(locale, { maximumFractionDigits });
}

export function formatPercent(value, locale) {
  return `${Number(value ?? 0).toLocaleString(locale, { maximumFractionDigits: 1 })}%`;
}

export function formatBytes(bytes, locale) {
  const size = Number(bytes ?? 0);
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${formatNumber(size / 1024, locale, 1)} KB`;
  return `${formatNumber(size / (1024 * 1024), locale, 1)} MB`;
}

/** Initials for an avatar ("Ana García" -> "AG"). */
export function initials(name) {
  return String(name || "?")
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join("");
}

/** Lower-cases and trims an email for comparisons. */
export function normalizeEmail(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

const EMAIL_PATTERN = /^[^\s@,;<>"()[\]]+@[^\s@,;<>"()[\]]+\.[^\s@,;<>"()[\]]+$/;

export function isValidEmail(value) {
  return EMAIL_PATTERN.test(normalizeEmail(value));
}

/** Translates the built-in option keys (approve/reject/abstain/yes/no); custom options stay as typed. */
export function optionLabel(t, option) {
  const key = `options.${String(option).toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
  return t(key, null, option);
}

/** Translates a survey category key; unknown categories are capitalized. */
export function categoryLabel(t, category) {
  const raw = String(category || "general");
  return t(`categories.${raw.toLowerCase()}`, null, raw.charAt(0).toUpperCase() + raw.slice(1));
}
