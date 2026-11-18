# Client (React 19 + Vite 8 + Bootstrap 5)

```bash
cp .env.example .env     # VITE_API_BASE_URL, VITE_GOOGLE_CLIENT_ID
npm install
npm run dev              # http://localhost:5173
npm run lint             # ESLint
npm run check:i18n       # dictionaries consistency
npm run build            # production build in dist/
```

## Routes

| Route | Access | View |
|-------|--------|------|
| `/login` | public | Google sign-in |
| `/vote?token=…` | public (link token) | Ballot with every motion of the vote |
| `/surveys`, `/surveys/:id` | signed in | Surveys assigned/delegated to the user; answer, delegate, progress |
| `/admin` | admin | Dashboard (figures, votes, surveys) |
| `/admin/elections/new`, `/admin/elections/:id` | admin | Create a vote; results, voters and actions |
| `/admin/surveys/new` | admin | Create a survey with categorization preview |

## Structure

- `api/client.js` — `apiRequest()` and `ApiError` (`status`, `code`, `details`).
- `context/` — `AuthProvider` (session in sessionStorage, re-validated with `/api/auth/me`, ends on 401/expiry) and
  `LanguageProvider` (`t(key, params, fallback)`), each with its own context module and hook.
- `hooks/useResource.js` — abortable data loading with derived `loading` state.
- `components/ui/` — shared building blocks (notices, page header, sections, stat cards, progress, badges, modal, icons).
- `utils/errors.js` — server error codes and CSV row details → translated text.

## Internationalization

All UI text lives in `src/locales/es.json` and `src/locales/en.json` (same keys, checked by `npm run check:i18n`).
Components call `t("section.key", { placeholder })`; the language is stored in `localStorage` and also sets
`<html lang>`.
