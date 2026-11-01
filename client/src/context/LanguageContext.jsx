import { createContext, useCallback, useEffect, useMemo, useState, useContext } from "react";
import en from "../locales/en.json";
import es from "../locales/es.json";

const dictionaries = { en, es };
const DEFAULT_LANGUAGE = "en";

export const LanguageContext = createContext(null);

export function LanguageProvider({ children }) {
  const [language, setLanguage] = useState(DEFAULT_LANGUAGE);

  const dictionary = useMemo(
    () => dictionaries[language] || dictionaries[DEFAULT_LANGUAGE],
    [language]
  );

  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  const t = useCallback(
    (key) => {
      if (typeof key !== "string") return "";

      const value = key
        .split(".")
        .reduce(
          (node, part) =>
            node !== null && typeof node === "object" ? node[part] : undefined,
          dictionary
        );

      return typeof value === "string" ? value : key;
    },
    [dictionary]
  );

  const toggleLanguage = useCallback(() => {
    setLanguage((current) => (current === "en" ? "es" : "en"));
  }, []);

  const contextValue = useMemo(
    () => ({ language, setLanguage, t, toggleLanguage }),
    [language, t, toggleLanguage]
  );

  return (
    <LanguageContext.Provider value={contextValue}>
      {children}
    </LanguageContext.Provider>
  );
}

// El nuevo Custom Hook que Claude estaba buscando
export function useLanguage() {
  const context = useContext(LanguageContext);
  if (!context) {
    throw new Error("useLanguage must be used within a LanguageProvider");
  }
  return context;
}