import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import en from "../locales/en.json";
import es from "../locales/es.json";

const dictionaries = { en, es };
const DEFAULT_LANGUAGE = "en";
const STORAGE_KEY = "app.language";

/** Matches `{name}`-style placeholders inside translation strings. */
const PLACEHOLDER_PATTERN = /\{(\w+)\}/g;

export const LanguageContext = createContext(null);

/**
 * Walks a dotted key (e.g. "voting.errors.expired") through a dictionary.
 *
 * @param {object} dictionary - Translation tree.
 * @param {string} key - Dotted path.
 * @returns {unknown} The value found, or undefined.
 */
function resolveKey(dictionary, key) {
  return key
    .split(".")
    .reduce(
      (node, part) =>
        node !== null && typeof node === "object" ? node[part] : undefined,
      dictionary
    );
}

/**
 * Replaces `{placeholders}` with values from `params`.
 * Unknown placeholders are left untouched so missing data is visible.
 *
 * @param {string} template - Translation string, e.g. "Hello, {name}."
 * @param {Record<string, unknown>} [params] - Values keyed by placeholder name.
 * @returns {string} The interpolated string.
 */
function interpolate(template, params) {
  if (!params) {
    return template;
  }
  return template.replace(PLACEHOLDER_PATTERN, (match, name) =>
    Object.hasOwn(params, name) && params[name] != null ? String(params[name]) : match
  );
}

/** Reads the persisted language, falling back to the default when unavailable. */
function readStoredLanguage() {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored !== null && Object.hasOwn(dictionaries, stored) ? stored : DEFAULT_LANGUAGE;
  } catch {
    return DEFAULT_LANGUAGE;
  }
}

export function LanguageProvider({ children }) {
  const [language, setLanguageState] = useState(readStoredLanguage);

  const dictionary = useMemo(() => dictionaries[language], [language]);

  useEffect(() => {
    document.documentElement.lang = language;
    try {
      window.localStorage.setItem(STORAGE_KEY, language);
    } catch {
      // Storage can be unavailable (private mode); the language still works for this session.
    }
  }, [language]);

  const setLanguage = useCallback((next) => {
    if (Object.hasOwn(dictionaries, next)) {
      setLanguageState(next);
    }
  }, []);

  /**
   * Translates a dotted key and interpolates `{placeholders}`.
   * Falls back to English, then to the key itself, when a translation is missing.
   *
   * @param {string} key - Dotted translation key.
   * @param {Record<string, unknown>} [params] - Placeholder values, e.g. { count: 3 }.
   * @returns {string}
   */
  const t = useCallback(
    (key, params) => {
      if (typeof key !== "string") {
        return "";
      }
      const value = resolveKey(dictionary, key) ?? resolveKey(dictionaries[DEFAULT_LANGUAGE], key);
      return typeof value === "string" ? interpolate(value, params) : key;
    },
    [dictionary]
  );

  const toggleLanguage = useCallback(() => {
    setLanguageState((current) => (current === "en" ? "es" : "en"));
  }, []);

  const contextValue = useMemo(
    () => ({ language, setLanguage, t, toggleLanguage }),
    [language, setLanguage, t, toggleLanguage]
  );

  return (
    <LanguageContext.Provider value={contextValue}>
      {children}
    </LanguageContext.Provider>
  );
}

/**
 * Hook to access translations and language controls.
 *
 * @throws {Error} If used outside of a LanguageProvider.
 */
export function useLanguage() {
  const context = useContext(LanguageContext);
  if (!context) {
    throw new Error("useLanguage must be used within a LanguageProvider");
  }
  return context;
}