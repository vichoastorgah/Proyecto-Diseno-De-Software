# Project progress — Electronic Voting & Survey System (TICS316, topic 6)

Working log so any session can resume without repeating the analysis.
Branch: `feature/professional-upgrade` (tracks `origin/feature/professional-upgrade`). `main` is never modified.

## Status

| | |
|---|---|
| **Last completed** | Backend rewrite (SQLite, multi-motion elections, roles) + 35 backend tests, pushed |
| **In progress** | Frontend redesign (API client, shared UI, admin portal, ballot, surveys) |
| **Next** | Frontend verification (lint, build, browser checks at 3 widths), docs update |

## Commits on this branch

| Commit | Content | Pushed |
|---|---|---|
| `aa9436a` | (made by the owner) first version of the new server modules | yes |
| `c515f9f` | chore(security): untrack personal data, gitignore, env templates, fictitious samples | yes |
| `790f266` | feat(server): SQLite persistence, multi-motion elections, role-based access | yes |
| `2f2fd44` | test(server): 35 integration tests | yes |

Before every commit the staged diff is scanned for `.env` files, databases, legacy data files,
non-example email addresses, 64-hex values (tokens), RUT-like values and secret assignments.
Findings so far were false positives (a `deno.lock` integrity hash, the test-only session secret).

## Requirements traceability (PDF, project 6)

| # | Requirement | Implementation | Status | Tests |
|---|---|---|---|---|
| 1.1 | Create and manage multiple votes | `electionService.ts`, `adminRoutes.ts` (list, detail, close/reopen) | Backend done, UI pending | `elections.test.ts` |
| 1.2 | Bulk CSV: email, name, birthdate, gender, weight | `csvService.ts` (validation per row/field, duplicates, `;`/`,`, Spanish headers) + `POST /api/admin/csv/validate` preview | Backend done, UI pending | `csv.test.ts`, `elections.test.ts` |
| 1.3 | Personalized email (name + gender) | `emailService.ts` `renderInvitation` (Mr./Ms., Sr./Sra., neutral; EN/ES) | Done (SMTP or console simulation) | `elections.test.ts` |
| 1.4 | Attachments by email | `attachmentService.ts` (allow-list, content check, up to 5 files/10 MB) | Done | `elections.test.ts` |
| 2.1 | Unique link to vote once on one or several motions | Election → N motions, 1 token per voter, atomic ballot | Backend done, UI pending | `voting.test.ts` |
| 2.2 | Cannot vote again | `UPDATE voters SET has_voted=1 WHERE ... AND has_voted=0` inside a transaction | Done | `voting.test.ts` (10 concurrent requests) |
| 2.3 | Weighted results per motion | Weight from CSV, anonymous ballots, integrity check | Done | `voting.test.ts` |
| 3.1 | Automatic categorization | Keyword classifier EN/ES (finance, operations, environment, marketing, hr, legal, it, general) | Done | `surveys.test.ts` |
| 3.2 | Single initial recipient, delegation of questions/categories | `delegateQuestions` (ids or category, all-or-nothing) | Backend done, UI pending | `surveys.test.ts` |
| 3.3 | Recipient sees consolidated progress | `getSurveyForViewer` (recipient/admin full view, `pendingByOwner`) | Backend done, UI pending | `surveys.test.ts` |
| 3.4 | One responsible per question; delegating transfers it | `current_owner` single column + guarded UPDATE + audit trail | Done | `surveys.test.ts` |
| G1 | Responsive | Bootstrap 5 | Pending redesign | browser checks pending |
| G2 | SSO login | Google ID token verified server-side, roles admin/participant | Done (backend) | `auth.test.ts` |
| G3 | Custom multi-language (no external API) | `LanguageContext` + `en.json`/`es.json`; emails EN/ES | Existing, to extend | pending |
| G4 | Code in English, good practices | All new code in English; `deno lint` clean | In progress | — |

## Technical decisions

1. **SQLite through `node:sqlite`** (built into Deno 2): transactions, foreign keys and constraints with
   no new dependency. PostgreSQL would need a server, which does not fit a single-machine demo.
2. **Legacy import, read-only.** On first start the former JSON files are imported in one transaction
   (`server/db/legacyImport.ts`) and never modified (verified with SHA-256 before/after).
   Real local data imported: 2 elections, 6 voters, 1 survey, 4 questions, no integrity warnings.
3. **Tokens are stored as SHA-256 hashes.** Imported tokens are hashed, so links already sent keep working.
   No token was invalidated.
4. **Secret ballot:** `ballots` has no voter reference, random ids, no timestamps.
   Former JSON files only kept totals: they are imported as `legacy` tally rows.
5. **Roles:** admins come from `ADMIN_EMAILS`/`ADMIN_EMAIL_DOMAINS` (fallback: the `ALLOWED_*` lists, so the
   current `.env` keeps working). Survey participants can sign in but only see their surveys.
6. **Demo impersonation** (`ALLOW_DEMO_SURVEY_IDENTITY=true`) now requires a signed-in admin
   (before: anyone without a session could act as anybody).
7. **API changes:** the public `GET /api/survey` (exposed emails and answers) and the old survey
   endpoints were replaced by `/api/surveys/...` (authenticated). `/api/admin/dispatch`,
   `/api/admin/voters/upload` and the old vote body `{token, motionId, choice}` are still accepted.

## Tests

| Check | Result |
|---|---|
| `deno task check` | pass |
| `deno task lint` | pass (28 files) |
| `deno task test` | **35 passed, 0 failed** |
| Real start on a temporary DB with the real legacy data | pass: health 200, admin without session 401, old public survey 404, JSON files unchanged |
| ESLint client (initial: 5 errors, 2 warnings) | pending (frontend phase) |
| `npm run build` | pending |
| Browser checks (desktop/tablet/mobile) | pending |
| Google sign-in with a real account | cannot be automated here (needs the owner's Google account) |

## Security notes and pending risks

- **Git history:** personal data (4 real email addresses, a RUT in a file name, 6 voting tokens) remains in
  earlier commits of the public repository. Untracking does not remove it. Options (need the owner's decision):
  make the repository private, or rewrite history (`git filter-repo` + force push; changes every hash).
  Nothing has been done to the history.
- **3 voting tokens** published in the history are still valid in the local data. The owner decided to keep them.
- Rate limiting is in-memory (single process), enough for this deployment.

## Pending tasks

- [ ] Frontend: API client, shared UI components, redesign of every view, multi-motion ballot,
      admin portal (dashboard, elections, voters, results), surveys (list, detail, delegation), i18n.
- [ ] Fix the 5 ESLint errors / 2 warnings.
- [ ] Browser verification at desktop, tablet and mobile widths.
- [ ] Update `README.md`, `server/README.md`, `client/README.md`.
