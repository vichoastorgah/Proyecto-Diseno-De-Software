import { createContext, useCallback, useEffect, useMemo, useState } from "react";
import en from "../locales/en.json";
import es from "../locales/es.json";

// Local dictionaries only (no external translation APIs)
const dictionaries = { en, es };
const DEFAULT_LANGUAGE = "en";

export const LanguageContext = createContext({
  language: DEFAULT_LANGUAGE,
  t: (key) => key,
  toggleLanguage: () => {},
});

export function LanguageProvider({ children }) {
  const [language, setLanguage] = useState(DEFAULT_LANGUAGE);

  // Select the dictionary matching the current language
  const dictionary = useMemo(
    () => dictionaries[language] || dictionaries[DEFAULT_LANGUAGE],
    [language]
  );

  // Keep the <html lang> attribute in sync for accessibility
  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  // Resolve a (possibly nested) key such as "voting.errors.invalidToken".
  // Optional params replace {placeholder} tokens, e.g. t("key", { count: 3 }).
  const t = useCallback(
    (key, params) => {
      if (typeof key !== "string") return "";

      const value = key
        .split(".")
        .reduce(
          (node, part) =>
            node !== null && typeof node === "object" ? node[part] : undefined,
          dictionary
        );

      // Fallback to the key itself when the translation is missing
      if (typeof value !== "string") return key;

      if (!params || typeof params !== "object") return value;

      return value.replace(/\{(\w+)\}/g, (match, name) =>
        Object.prototype.hasOwnProperty.call(params, name)
          ? String(params[name])
          : match
      );
    },
    [dictionary]
  );

  const toggleLanguage = useCallback(() => {
    setLanguage((current) => (current === "en" ? "es" : "en"));
  }, []);

  const contextValue = useMemo(
    () => ({ language, t, toggleLanguage }),
    [language, t, toggleLanguage]
  );

  return (
    <LanguageContext.Provider value={contextValue}>
      {children}
    </LanguageContext.Provider>
  );
}