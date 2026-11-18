import { useContext } from "react";
import { LanguageContext } from "./languageContext";

/**
 * Access to translations and language controls.
 * @throws {Error} When used outside of a LanguageProvider.
 */
export function useLanguage() {
  const context = useContext(LanguageContext);
  if (!context) throw new Error("useLanguage must be used within a LanguageProvider");
  return context;
}
