import { useCallback, useEffect, useMemo, useState } from "react";
import en from "../locales/en.json";
import es from "../locales/es.json";
import { LanguageContext } from "./languageContext";

/**
 * Custom multi-language support (no external translation API): local JSON dictionaries,
 * dotted keys and `{placeholder}` interpolation. Spanish is the default language.
 */
const dictionaries = { en, es };
const LOCALES = { en: "en-US", es: "es-CL" };
const DEFAULT_LANGUAGE = "es";
const STORAGE_KEY = "app.language";
const PLACEHOLDER_PATTERN = /\{(\w+)\}/g;

function resolveKey(dictionary, key) {
  return key
    .split(".")
    .reduce((node, part) => (node !== null && typeof node === "object" ? node[part] : undefined), dictionary);
}

function interpolate(template, params) {
  if (!params) return template;
  return template.replace(PLACEHOLDER_PATTERN, (match, name) =>
    Object.hasOwn(params, name) && params[name] != null ? String(params[name]) : match
  );
}

function readStoredLanguage() {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored && Object.hasOwn(dictionaries, stored)) return stored;
  } catch {
    // Storage unavailable: fall through.
  }
  const browser = (navigator.language || "").slice(0, 2);
  return Object.hasOwn(dictionaries, browser) ? browser : DEFAULT_LANGUAGE;
}

export function LanguageProvider({ children }) {
  const [language, setLanguageState] = useState(readStoredLanguage);
  const dictionary = dictionaries[language];

  useEffect(() => {
    document.documentElement.lang = language;
    try {
      window.localStorage.setItem(STORAGE_KEY, language);
    } catch {
      // Private mode: the choice still applies to this tab.
    }
  }, [language]);

  const setLanguage = useCallback((next) => {
    if (Object.hasOwn(dictionaries, next)) setLanguageState(next);
  }, []);

  const toggleLanguage = useCallback(() => {
    setLanguageState((current) => (current === "es" ? "en" : "es"));
  }, []);

  /**
   * Translates a dotted key, interpolating `{placeholders}`.
   * Falls back to the other language, then to `fallback`, then to the key itself.
   */
  const t = useCallback(
    (key, params, fallback) => {
      if (typeof key !== "string") return "";
      const value =
        resolveKey(dictionary, key) ?? resolveKey(dictionaries[language === "es" ? "en" : "es"], key);
      if (typeof value === "string") return interpolate(value, params);
      return fallback !== undefined ? fallback : key;
    },
    [dictionary, language]
  );

  const value = useMemo(
    () => ({ language, locale: LOCALES[language], setLanguage, toggleLanguage, t }),
    [language, setLanguage, toggleLanguage, t]
  );

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}
