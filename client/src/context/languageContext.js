import { createContext } from "react";

/**
 * Translation context: `{ language, setLanguage, toggleLanguage, t, locale }`.
 * Kept in its own module so component files only export components (fast refresh).
 */
export const LanguageContext = createContext(null);
