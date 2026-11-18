# Project progress — Electronic Voting & Survey System (TICS316, topic 6)

Working log so any session can resume without repeating the analysis.
Branch: `feature/professional-upgrade` (tracks `origin/feature/professional-upgrade`). `main` is never modified here.

## Status (2026-11-18)

| | |
|---|---|
| **Last completed** | Frontend redesign verified in a browser (3 widths) + documentation update |
| **In progress** | Defense guide (Spanish), deployment preparation |
| **Next** | Deployment (needs the owner's accounts and a hosting decision), real Google sign-in check by the owner |
| **Blocked / needs the owner** | Hosting choice and accounts; Git history decision (personal data in old commits) |

## Commits on this branch

| Commit | Content | Pushed |
|---|---|---|
| `aa9436a` | (made by the owner) first version of the new server modules | yes |
| `c515f9f` | chore(security): untrack personal data, gitignore, env templates, fictitious samples | yes |
| `790f266` | feat(server): SQLite persistence, multi-motion elections, role-based access | yes |
| `2f2fd44` | test(server): 35 integration tests | yes |
| `cc63351` | docs: PROJECT_PROGRESS.md | yes |
| `a74a78e` | refactor(client): API client, contexts, shared UI. **Note:** this commit alone does not build (it already removed the old contexts still imported by the old views); fixed by the next commit | yes |
| `e5ba01d` | feat(client): redesign of every view, complete i18n | yes |
| `a0a7e19` | fix(email): double period after Spanish times | yes |

Before every commit the staged diff is scanned (scratchpad script) for `.env` files, databases, legacy data files,
non-example email addresses, 64-hex values (tokens), RUT-like values and secret assignments. Findings so far were
false positives (a `deno.lock` integrity hash, the test-only session secret) or fixed (placeholder emails now use the
reserved `example.com` domain).

---

## Rubric matrix (Rubrica_Proyecto_Semestral.pdf, 100 pts)

| Criterion | Max | Evidence in the project | Current state | To reach the maximum |
|---|---:|---|---|---|
| **Continuity** (≥1 commit per week, Oct 5 →) | 20 | Git history: weeks 1–7 all have commits (week 1: 5, week 2: 1, week 3: 1, week 4: 2, week 5: 1, week 6: 2, week 7: 8+) | On track | Keep ≥1 meaningful commit every week until the end of the semester |
| **Incremental documentation** (README updated with each weekly commit) | 15 | README added in week 6; rewritten in week 7 with features, changelog, instructions, status | Partial for weeks 1–5 (cannot be changed) | Update README "What changed in this iteration" + status **every week** |
| **Progressive functional advance** | 20 | History shows engine → views → i18n → SSO → attachments → SQLite/multi-motion → redesign | Good | Keep functional increments visible per week |
| **Commit quality and traceability** | 10 | Conventional messages (`feat:`, `fix:`, `test:`, `docs:`, `refactor:`, `chore:`) with bodies explaining why | Good (early commits less descriptive) | Keep one concern per commit |
| **Development management and validation** | 5 | 35 backend tests, ESLint, i18n check, build, browser checks, bugs found and fixed in this log | Good | Keep tests green; record fixes here |
| **Functional compliance** (demonstrated, not static) | 12 | See requirements matrix below; every flow works end to end | Done locally | Demonstrate live (demo script in README) |
| **Online deployment and integration** | 4 | Not deployed yet | **Missing** | Frontend on Vercel + API/DB on a host with persistence + env vars (needs owner's accounts) |
| **UI/UX good practices** (Material principles) | 3 | Consistent tokens, hierarchy, spacing, components, loading/empty/error states, confirmations, feedback | Done | — |
| **Responsive** | 2 | Verified at 390, 820, 1440 px: no horizontal overflow; navbar collapses; tables scroll; cards stack | Done | — |
| **i18n** | 3 | `t('key')` everywhere, `es.json`/`en.json` 406 keys each, `npm run check:i18n`, switch in navbar, emails ES/EN | Done | Demonstrate the switch |
| **Understanding and edge cases** (individual) | 3 | `docs/GUIA_DEFENSA.md` (in progress), server README "Rules worth knowing" | In progress | Study the guide |
| **Individual technical questions** | 3 | Architecture/decisions documented in README, server README and this file | In progress | Study the guide |

Priority from the rubric: (1) keep weekly commits + README updates (35 pts at stake), (2) deployment (4 pts),
(3) defense preparation (6 pts), (4) keep quality checks green.

---

## Requirements traceability (PDF, project 6)

| # | Requirement | Implementation | Status | Verification |
|---|---|---|---|---|
| 1.1 | Create votes (multiple) | `electionService.createElection`, `POST /api/admin/elections`, `ElectionCreateView`, dashboard list, detail, close/reopen | Done | `elections.test.ts`; browser |
| 1.2 | Bulk CSV: email, name, birthdate, gender, weight | `csvService.parseVotersCsv` (per row/field errors, duplicates, `,`/`;`, Spanish headers, day-first dates) + live validation endpoint and UI | Done | `csv.test.ts`, `elections.test.ts`; browser |
| 1.3 | Personalized email (name + gender) | `emailService.renderInvitation` (Sr./Sra., Mr./Ms., neutral; ES/EN) | Done (SMTP or console) | `elections.test.ts`; console output checked |
| 1.4 | Attachments by email | `attachmentService` (allow-list, content check, ≤5 files/10 MB), sent with each invitation, downloadable on the ballot | Done | `elections.test.ts`, `voting.test.ts` |
| 2.1 | Unique link, vote once on one or several motions | One token per voter per election, ballot with every motion, atomic | Done | `voting.test.ts`; browser (desktop + mobile) |
| 2.2 | Cannot vote again | Guarded UPDATE in the transaction + UI blocked state | Done | 10 concurrent requests → 1 accepted |
| 2.3 | Weighted results per motion | Weight from CSV, anonymous ballots, per-motion integrity check | Done | `voting.test.ts`; browser (82.6 % / 17.4 % example) |
| 3.1 | Automatic categorization | Keyword classifier EN/ES | Done | `surveys.test.ts`; live preview in UI |
| 3.2 | Single initial recipient; delegate one/several questions or categories | `delegateQuestions` (ids or category, all-or-nothing), selection toolbar and category button in UI | Done | `surveys.test.ts`; browser |
| 3.3 | Recipient sees consolidated progress | Recipient/admin full view, progress by category and by owner | Done | `surveys.test.ts`; browser |
| 3.4 | One responsible per question; delegating transfers it | `current_owner` single column + guarded UPDATE + history | Done | `surveys.test.ts` |
| G1 | Responsive | Bootstrap 5 + `styles/app.css` | Done | Headless Chrome 390/820/1440 |
| G2 | SSO | Google ID token verified server-side; roles | Done | `auth.test.ts` (fake Google verifier); real account: **owner must check** |
| G3 | Custom multi-language | Dictionaries + `t()`, no external API | Done | `check:i18n`; browser switch ES→EN |
| G4 | Code in English, good practices | All code/comments in English; lint clean | Done | `deno task lint`, `npm run lint` |
| G5 | GitHub weekly commits | See rubric matrix | On track | `git log` |
| G6 | AI usage and third-party code cited | README "Use of AI tools and third-party code" | Done | README |

---

## Technical decisions

1. **SQLite through `node:sqlite`** (built into Deno 2): transactions, foreign keys and constraints with no new
   dependency. Synchronous driver → transaction bodies are synchronous, so requests cannot interleave inside them.
   *Deployment impact:* needs a host with a persistent disk (or a migration to a hosted database such as Supabase/Postgres).
2. **Legacy import, read-only.** First start imports the JSON files in one transaction and never modifies them
   (verified with SHA-256 before/after). Real local data: 2 elections, 6 voters, 1 survey, 4 questions, no warnings.
3. **Tokens stored as SHA-256 hashes**; imported tokens are hashed so links already sent keep working. No token was invalidated.
4. **Secret ballot:** `ballots` has no voter reference, random ids, no timestamps. Former totals are `legacy` rows.
5. **Roles:** admins from `ADMIN_*` (fallback `ALLOWED_*`, so the current `.env` keeps working); survey participants
   can sign in but only see their surveys.
6. **Demo impersonation** requires a signed-in admin (before: anyone without a session could act as anybody).
7. **API changes:** the public `GET /api/survey` (exposed emails and answers) was removed; former admin/vote endpoints
   are still accepted.
8. **Frontend data loading** (`useResource`): state is only set from promise callbacks and `loading` is derived, which
   satisfies the React 19 `set-state-in-effect` rule.
9. **Placeholders and samples** use the reserved `example.com` domain.

---

## Tests and checks

| Check | Result |
|---|---|
| `deno task check` | pass |
| `deno task lint` | pass (28 files) |
| `deno task test` | **35 passed, 0 failed** |
| `npm run lint` (client) | **0 problems** (initially 5 errors, 2 warnings) |
| `npm run check:i18n` | pass: 406 keys per language, 323 literal usages |
| `npm run build` | pass |
| Real server start on a temporary DB with the real legacy data | pass: health 200, admin w/o session 401, old public survey 404, JSON unchanged |
| Headless Chrome, 26 screenshots at 390/820/1440 px (isolated demo DB, fictitious data) | pass: no horizontal overflow, no console errors (only the expected 404 of the invalid-link case) |
| Browser flows | ballot end to end on desktop and mobile (vote, review, cast, "already voted"), invalid link, ES→EN switch, guards (no session → /login, participant → no access) |
| Google sign-in with a real account | cannot be automated here — **owner to verify** |
| Real SMTP delivery | not configured — console simulation verified |

### Problems found and fixed during verification

- Sticky ballot toolbar could hide the option being focused/scrolled to → `scroll-padding-bottom`, compact single-row toolbar on phones.
- Double period after Spanish times ("p. m..") on the ballot and in emails → reworded with a colon.
- Mobile: stat labels split mid-word and table titles broken letter by letter → stacked stat cards on phones, `overflow-wrap: break-word`, minimum width of the first table column.
- React 19 hooks lint rule (`set-state-in-effect`) → `useResource` rewritten.

---

## Security notes and pending risks

- **Git history:** personal data (4 real email addresses, a RUT in a file name, 6 voting tokens) remains in earlier
  commits of the public repository. Untracking does not remove it. Options (owner's decision): make the repository
  private, or rewrite history (`git filter-repo` + force push; changes every hash). Nothing has been done to the history.
- **3 voting tokens** published in the history are still valid in the local data. The owner decided to keep them.
- Rate limiting is in-memory (single process).

## Pending tasks

- [ ] `docs/GUIA_DEFENSA.md` (Spanish): flows, edge cases, architecture questions.
- [ ] Deployment: choose hosting (see options in README/Deployment) and configure env vars — needs the owner.
- [ ] Owner: sign in with a real Google account; optionally configure SMTP for real emails.
- [ ] Owner: decide about the Git history containing personal data.
- [ ] Weekly: commit + README "What changed" section.
