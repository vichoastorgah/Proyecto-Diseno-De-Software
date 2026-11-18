# Project progress — Electronic Voting & Survey System (TICS316, topic 6)

Working log so any session can resume without repeating the analysis.
Branch: `feature/professional-upgrade` (tracks `origin/feature/professional-upgrade`). `main` is never modified here.

## Status (2026-11-18)

| | |
|---|---|
| **Last completed** | PostgreSQL/Supabase-ready persistence + fixes from an independent code review, verified (41 tests, driver smoke test, browser) |
| **In progress** | Documentation of the deployment (`docs/DESPLIEGUE.md`) |
| **Next** | Owner merged into `main` and created Supabase; next: Render (API container) and Vercel, then production checks |
| **Blocked / needs the owner** | Hosting accounts and secrets; real Google sign-in check; Git history decision |

## Commits on this branch (all pushed)

| Commit | Content |
|---|---|
| `aa9436a` | (made by the owner) first version of the new server modules |
| `c515f9f` | chore(security): untrack personal data, gitignore, env templates, fictitious samples |
| `790f266` | feat(server): SQLite persistence, multi-motion elections, role-based access |
| `2f2fd44` | test(server): 35 integration tests |
| `cc63351` | docs: PROJECT_PROGRESS.md |
| `a74a78e` | refactor(client): API client, contexts, shared UI. **Note:** this commit alone does not build (it already removed the old contexts still imported by the old views); fixed by the next commit |
| `e5ba01d` | feat(client): redesign of every view, complete i18n |
| `a0a7e19` | fix(email): double period after Spanish times |
| `bdb6433` | docs: READMEs, rubric matrix, verification results |
| `44014b8` | docs: Spanish defense guide, Vercel SPA rewrite |
| `43fd71d` | feat(server): PostgreSQL (Supabase-ready) persistence + review hardening, 41 tests |
| `c39926b` | fix(client): secret-ballot results view and review fixes |

Before every commit the staged diff is scanned (scratchpad script) for `.env` files, databases, legacy data files,
non-example email addresses, 64-hex values (tokens), RUT-like values and secret assignments. Findings were false
positives (a `deno.lock` integrity hash, the test-only session secret) or fixed (placeholder emails now use the
reserved `example.com` domain).

---

## Rubric matrix (Rubrica_Proyecto_Semestral.pdf, 100 pts)

| Criterion | Max | Evidence in the project | Current state | To reach the maximum |
|---|---:|---|---|---|
| **Continuity** (≥1 commit per week, Oct 5 →) | 20 | Weeks 1–7 all have commits (week 7: 12+) | On track | Keep ≥1 meaningful commit every week |
| **Incremental documentation** (README per weekly commit) | 15 | README since week 6; updated in week 7 with features, changelog, instructions, status | Partial for weeks 1–5 (cannot be changed) | Update README "What changed" + status **every week** |
| **Progressive functional advance** | 20 | engine → views → i18n → SSO → attachments → DB/multi-motion → redesign → PostgreSQL | Good | Keep visible increments |
| **Commit quality and traceability** | 10 | Conventional messages with bodies (why + verification) | Good (early commits less descriptive) | One concern per commit |
| **Development management and validation** | 5 | 41 tests, ESLint, i18n check, build, browser checks, independent review with fixes and regression tests | Good | Keep tests green |
| **Functional compliance** | 12 | Requirements matrix below; every flow works end to end locally | Done locally | Demonstrate live (README demo script) |
| **Online deployment and integration** | 4 | Code ready for Vercel + Render (Docker, tested locally) + Supabase; guide `docs/DESPLIEGUE.md` | **Not published** | Owner creates accounts, sets env vars, follows the guide |
| **UI/UX good practices** | 3 | Tokens, hierarchy, spacing, components, loading/empty/error states, confirmations, feedback | Done | — |
| **Responsive** | 2 | Verified 390/820/1440 px, no horizontal overflow | Done | — |
| **i18n** | 3 | `t('key')`, `es.json`/`en.json` 411 keys each, `npm run check:i18n`, navbar switch, ES/EN emails | Done | Demonstrate the switch |
| **Understanding and edge cases** (individual) | 3 | `docs/GUIA_DEFENSA.md` (flows, 25+ edge cases) | Material ready | Owner studies it |
| **Individual technical questions** | 3 | Guide + READMEs (architecture, decisions) | Material ready | Owner studies it |

---

## Requirements traceability (PDF, project 6)

| # | Requirement | Implementation | Status | Verification |
|---|---|---|---|---|
| 1.1 | Create and manage multiple votes | `electionService`, admin dashboard, detail, close/reopen | Done | `elections.test.ts`; browser |
| 1.2 | Bulk CSV (email, name, birthdate, gender, weight) | `csvService` + live validation endpoint and UI | Done | `csv.test.ts`, `elections.test.ts`; browser |
| 1.3 | Personalized email (name + gender) | `renderInvitation` (Sr./Sra., Mr./Ms., neutral; ES/EN) | Done (SMTP or console) | tests; console output |
| 1.4 | Attachments by email | `attachmentService` + `fileStore` (local / Supabase Storage); attached from memory | Done | tests; driver smoke test |
| 2.1 | Unique link, vote once on one or several motions | Token per voter per election, atomic ballot | Done | `voting.test.ts`; browser desktop + mobile |
| 2.2 | Cannot vote again | `FOR UPDATE` + guarded UPDATE + UI blocked state | Done | 10 concurrent requests → 1 accepted (PGlite) |
| 2.3 | Weighted results per motion | Weight from CSV, anonymous ballots, integrity check, shown once closed | Done | `voting.test.ts`; browser |
| 3.1 | Automatic categorization | Keyword classifier EN/ES + live preview | Done | `surveys.test.ts` |
| 3.2 | Single recipient; delegate one/several questions or categories | `delegateQuestions` (all-or-nothing) | Done | `surveys.test.ts`; browser |
| 3.3 | Recipient sees consolidated progress | Recipient/admin full view, by category and owner | Done | `surveys.test.ts`, `hardening.test.ts` |
| 3.4 | One responsible per question; delegating transfers it | `current_owner` single column + row lock + history | Done | `surveys.test.ts` |
| G1 | Responsive | Bootstrap 5 + `styles/app.css` | Done | Headless Chrome |
| G2 | SSO | Google ID token verified server-side; roles | Done | `auth.test.ts`; **real account: owner** |
| G3 | Custom multi-language | Dictionaries + `t()` | Done | `check:i18n`; browser |
| G4 | Code in English, good practices | Lint clean | Done | `deno task lint`, `npm run lint` |
| G6 | AI usage and third-party code cited | README section | Done | README |

---

## Technical decisions

1. **PostgreSQL (owner's choice: Vercel + Supabase).** One async `Db` interface, two drivers with the same SQL:
   `postgres.js` with `DATABASE_URL` (Supabase, `prepare: false` for the pooler) and **PGlite** (PostgreSQL in
   WebAssembly, loaded on demand) for development and tests. Earlier SQLite step (`790f266`) was replaced because a
   file database cannot be hosted on the free serverless platforms.
2. **Row Level Security** enabled on every table without policies (the Supabase REST API cannot read data with the
   anon key). Migrations are versioned in `schema_migrations` and serialized with an advisory lock.
3. **Files** behind `FileStore`: local folder or private Supabase Storage bucket (service-role key, server only).
4. **Legacy import, read-only**, once, in one transaction. Real local data: 2 elections, 6 voters, 1 survey, 4 questions.
5. **Tokens stored as SHA-256 hashes**; imported tokens hashed, so links already sent keep working.
6. **Secret ballot:** ballots without voter reference; tallies hidden while open; no time of vote in the voter list.
   Residual risk (documented): an admin who closes and reopens repeatedly could still compare tallies.
7. **Roles:** admins from `ADMIN_*` (fallback `ALLOWED_*`); participants only see their surveys and, as participants,
   only global progress figures.
8. **Idempotent creation** with a client `requestId`.
10. **Hosting:** Deno Deploy closed new sign-ups (shutting down April 2027), so the API runs as a Docker container
   (`Dockerfile`, image `denoland/deno:2.9.7`, non-root user, no client/data/secrets in the image) on Render.
   Verified locally: injected `PORT`, health check, postgres driver over the network.
9. **Frontend loading** (`useResource`) and modal effects follow the React 19 hooks rules.

---

## Independent code review (subagent, read-only) — findings and outcome

| # | Severity | Finding | Outcome |
|---|---|---|---|
| 1 | Medium | Live tallies + exact vote time let an admin infer individual votes | Fixed: results only when closed, no `votedAt` (tests) |
| 2 | Medium | `.env.example` secret accepted → forged admin sessions | Fixed: placeholders rejected (test with a forged JWT) |
| 3 | Medium | Participants received per-person/category breakdown | Fixed server side (test) |
| 4 | Low/Med | Chunked bodies read fully before the size check | Fixed: streaming limit (test with a 5 MB stream) |
| 5 | Low | Wrong method answered 404 | Fixed: 405 (test) |
| 6 | Low | Retried creation could duplicate a vote and re-mail everyone | Fixed: `requestId` idempotency (test) |
| 7 | Low | Categorization spinner could stay on | Fixed |
| 8 | Low | Preview dropped questions with double spaces | Fixed |
| 9 | Low | Focus jumped inside dialogs | Fixed (`useEffectEvent`) |
| 10 | Low | Stale CSV check result could be shown | Fixed (sequence guard) |
| — | Note | Answer UPDATE count ignored; duplicate race → 500 | Fixed: row locks, count check, unique violation → 409 |

---

## Tests and checks

| Check | Result |
|---|---|
| `deno task check` / `deno task lint` | pass (30 files) |
| `deno task test` (PostgreSQL via PGlite) | **41 passed, 0 failed** |
| postgres.js driver smoke test over the Postgres wire protocol (pglite-socket, scratch folder) | pass: migrations, RLS on 11 tables, type parsing, rollback, create election, ballot, double vote rejected, hidden/visible results, attachment download. Simultaneous ballots over TCP not testable (test server accepts one connection) — verified on PGlite instead |
| `npm run lint` (client) | **0 problems** (initially 5 errors, 2 warnings) |
| `npm run check:i18n` | pass: 411 keys per language |
| `npm run build` | pass |
| Real server start with the real legacy data (temporary DB) | pass (SQLite step); JSON unchanged |
| Headless Chrome, 26+ screenshots at 390/820/1440 px against the PostgreSQL backend (fictitious data) | pass: no horizontal overflow; only the expected 404 of the invalid-link case |
| Browser flows | ballot end to end (desktop, mobile), invalid link, ES→EN, guards, open vs. closed results |
| Google sign-in with a real account / real SMTP / production deployment | **pending — need the owner** |

### Problems found and fixed during verification

- Sticky ballot toolbar could cover options → `scroll-padding-bottom`, compact toolbar on phones.
- Double period after Spanish times → reworded.
- Mobile: stat labels split mid-word, table titles broken per letter → stacked stat cards, `break-word`.
- React 19 hooks rule (`set-state-in-effect`) → `useResource` rewritten.
- 404 instead of 405 after the first fix (Oak sets 200 when a body is assigned) → explicit status, covered by a test.
- A shell replacement dropped a regex backslash (`/s+/`) → caught in review before committing, fixed.

---

## Security notes and pending risks

- **Git history:** personal data (4 real email addresses, a RUT in a file name, 6 voting tokens) remains in earlier
  commits of the public repository. Options (owner's decision): make the repository private, or rewrite history
  (`git filter-repo` + force push; changes every hash). Nothing has been done to the history.
- **3 voting tokens** published in the history are still valid in the local data (owner decided to keep them).
  Production starts with an empty database, so they do not work there.
- SMTP from Render (free plan) is unverified (see `docs/DESPLIEGUE.md`).
- Rate limiting is in-memory per instance.

## Pending tasks

- [ ] Owner: Supabase project, bucket, keys; Render web service (Docker); Vercel project; Google origin (see `docs/DESPLIEGUE.md`).
- [ ] Production checklist (guide section 6), including simultaneous ballots against Supabase.
- [ ] Owner: real Google sign-in; optionally SMTP.
- [ ] Owner: decision about the Git history with personal data.
- [ ] Weekly: commit + README "What changed" section.
