# Electronic Voting & Mass Survey System

A web platform that manages **weighted electronic votes** and **mass questionnaires with delegation**, in the spirit of
"SurveyMonkey, but for votes". Built for the *Software Design* course (TICS316-2-2026), project topic 6.

> **Status (2026-11-18):** every functional requirement of topic 6 is implemented and covered by automated tests on the
> development branch `feature/professional-upgrade`. Online deployment is pending (see [Deployment](#deployment)).
> Detailed log, requirement/rubric matrices and pending items: [`PROJECT_PROGRESS.md`](PROJECT_PROGRESS.md).

---

## Features

| Area | What it does |
|------|--------------|
| **Admin portal** | Create votes with **one or several motions**, each with its own options; bulk-load voters from a **CSV** (email, name, birthdate, gender, weight) validated row by row before saving; attach up to 5 documents; email every voter a **personalized** message (name + gender) with the attachments and a unique link. Dashboard, results, voter list, resend link, add voters, close/reopen. |
| **Unique-link voting** | One link per voter covers every motion of the vote. The ballot is cast **once** (enforced by the server and the database, even with simultaneous requests). Each ballot adds the voter's **weight** to the chosen option of each motion; ballots are **anonymous** and the results show an **integrity check**. |
| **Mass surveys** | Questions are **categorized automatically** (finance, operations, environment, marketing, HR, legal, technology, general; English and Spanish keywords). Each survey is addressed to **one person**, who can **delegate one, several or a whole category** of questions. Every question has **exactly one responsible**; delegating transfers the responsibility and is recorded in a history. The recipient sees **consolidated progress** (per category and per person). |
| **SSO** | Google sign-in verified on the server; two roles (administrator, participant). |
| **i18n** | Custom Spanish/English dictionaries (`t('login.title')`), no external translation API; emails in both languages. |
| **Responsive UI** | Bootstrap 5 + custom design tokens; verified at 390, 820 and 1440 px. |

---

## What changed in this iteration (2026-11-18)

- **Persistence:** JSON files replaced by **SQLite** (Deno's built-in `node:sqlite`) with migrations, foreign keys,
  constraints and transactions. The former JSON data is imported once, read-only.
- **Multiple motions per vote**, anonymous weighted ballots and per-motion integrity check.
- **Security:** voting tokens stored as SHA-256 hashes, admin/participant roles, the public survey endpoint was removed,
  attachment allow-list with content check, security headers, exact-origin CORS, rate limiting, personal data no longer
  versioned in Git.
- **Multiple surveys** with atomic delegation of several questions or a whole category and email notifications.
- **Frontend redesign** of every view, shared UI components, live CSV validation, complete ES/EN dictionaries.
- **Quality:** 35 backend integration tests, ESLint clean (was 5 errors / 2 warnings), i18n consistency script,
  headless browser checks.

---

## Architecture

```
.
├── client/                         React 19 + Vite 8 single-page app
│   ├── scripts/check-i18n.mjs      Dictionary consistency check
│   └── src/
│       ├── api/client.js           fetch wrapper + ApiError (stable error codes)
│       ├── context/                Auth (session, roles) and Language (t()) providers
│       ├── components/             Layout, navbar, guards, CSV result, demo bar, ui/*
│       ├── pages/                  Login, ballot, surveys, admin/* (dashboard, elections, surveys)
│       ├── hooks/ utils/           Data loading, formatting, error translation
│       ├── locales/                es.json / en.json (identical key sets)
│       └── styles/app.css          Design tokens on top of Bootstrap 5
├── server/                         Deno 2 + Oak 17 REST API
│   ├── server.ts                   Entry point (config → DB → legacy import → app)
│   ├── app.ts                      Middleware (errors, security headers, CORS, rate limit) + routes
│   ├── http/                       Route modules: auth, admin, voting, surveys
│   ├── services/                   Business logic (elections, voting, surveys, CSV, email, auth, tokens, attachments)
│   ├── db/                         SQLite connection, schema migrations, legacy JSON import
│   ├── tests/                      Integration tests (app.handle, in-memory DB)
│   ├── storage/                    SQLite database (git-ignored, created at runtime)
│   └── uploads/                    Attachments (git-ignored)
├── samples/                        Fictitious voter CSVs (valid and with errors)
├── PROJECT_PROGRESS.md             Work log, traceability and rubric matrices
└── deno.json                       Import map and tasks
```

**Layers.** `http/` only parses requests and checks roles; `services/` hold the rules and throw a single `AppError`
(HTTP status + stable `code` + optional structured `details`); `db/` owns the schema. The client translates the codes.

**Data model.** `elections` 1—N `motions` 1—N `motion_options`; `elections` 1—N `voters` (token hash, weight,
`has_voted`); `ballots` (motion, option, weight — no voter reference); `surveys` 1—N `survey_questions`
(`current_owner` single column) 1—N `survey_delegations`.

---

## Getting started

Requirements: [Deno](https://deno.com) 2.x, Node.js 20.19+ (for Vite), a Google OAuth client of type *Web application*
with `http://localhost:5173` as an authorized JavaScript origin.

```bash
# 1. Server (from the repository root)
cp .env.example .env              # fill GOOGLE_CLIENT_ID, SESSION_SECRET, ADMIN_EMAILS
deno task dev                     # http://localhost:8000

# 2. Client
cd client
cp .env.example .env              # VITE_GOOGLE_CLIENT_ID (same id), VITE_API_BASE_URL
npm install
npm run dev                       # http://localhost:5173
```

On the first start the server creates `server/storage/app.db` and, if the former `voters.json`, `motions.json` and
`data.json` exist in `server/`, imports them once (the files are not modified).

Without `SMTP_USER`/`SMTP_PASS`, emails are **printed in the server console** (including the voting links), which is
enough for a demo. Try the flow with `samples/voters.example.csv`.

### Environment variables (server `.env`)

| Variable | Required | Description |
|----------|----------|-------------|
| `GOOGLE_CLIENT_ID` | yes | OAuth client id (same as the client). |
| `SESSION_SECRET` | yes | 32+ random characters to sign sessions (otherwise sessions end on restart). |
| `ADMIN_EMAILS` / `ADMIN_EMAIL_DOMAINS` | recommended | Administrators. If both are empty, `ALLOWED_*` are the admins. |
| `ALLOWED_EMAILS` / `ALLOWED_EMAIL_DOMAINS` | no | Other accounts allowed to sign in. Survey participants can always sign in. With no list at all, every Google account is admin (development only). |
| `ALLOW_DEMO_SURVEY_IDENTITY` | no | `true` lets a signed-in admin act as another person in surveys (live demos). |
| `APP_BASE_URL`, `VOTE_BASE_URL` | no | Public URLs used in emails (default `http://localhost:5173`, `…/vote`). |
| `VOTE_TOKEN_TTL_HOURS` | no | Lifetime of voting links (default 48). |
| `DEFAULT_EMAIL_LANGUAGE` | no | `es` or `en`. |
| `ALLOWED_ORIGIN` | no | CORS origin(s) of the web app, comma-separated. |
| `PORT`, `DATABASE_PATH`, `UPLOADS_DIR` | no | Port (8000), SQLite file, attachments folder. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | no | Real email delivery (for Gmail use an app password). |

Client `.env`: `VITE_API_BASE_URL`, `VITE_GOOGLE_CLIENT_ID`.

---

## Quality checks

| Command | What it checks |
|---------|----------------|
| `deno task test` | 35 integration tests: CSV, elections, attachments, voting (weights, single use, concurrency, expiry, closed votes), surveys (delegation, visibility), auth (roles, expired/tampered sessions), legacy import |
| `deno task check` / `deno task lint` | TypeScript types and lint rules of the server |
| `cd client && npm run lint` | ESLint (React hooks rules) |
| `cd client && npm run check:i18n` | Same keys in `es.json`/`en.json`; every `t("…")` key exists |
| `cd client && npm run build` | Production build |

---

## Demo script (≈5 minutes)

1. **SSO + i18n:** sign in with Google; switch ES/EN in the navbar.
2. **Admin portal:** *New vote* → two motions (presets *Approve/Reject/Abstain* and custom options) → select
   `samples/voters-with-errors.example.csv` (per-row errors appear) → select `samples/voters.example.csv` (preview) →
   attach a PDF → *Create vote and send links*. The console shows the personalized emails.
3. **Voting:** open a link from the console, answer every motion, review, cast. Reload: *You already voted*.
4. **Results:** vote detail → weighted results, integrity badge, voter status, resend link, close the vote.
5. **Surveys:** *New survey* (live categorization) → as the recipient delegate a category and a single question →
   as the delegate (demo bar *Act as*) answer → consolidated progress for the recipient.

---

## Security and privacy

- Voting tokens are 256-bit random values; only their SHA-256 hash is stored. Ballots have no voter reference.
- Every rule (single vote, expiry, ownership of questions, roles) is enforced on the server and in the database.
- Uploaded files: extension allow-list, content sniffing, server-generated names, downloads with `nosniff`.
- Personal data (database, uploads, voter CSVs, former JSON files, `.env`) is git-ignored. Earlier commits of this
  repository still contain some of that data; see `PROJECT_PROGRESS.md` for the pending decision.

---

## Deployment

Planned target: static frontend on **Vercel** (env `VITE_API_BASE_URL`, `VITE_GOOGLE_CLIENT_ID`) and the Deno API with
its database on a host with persistent storage. The options and the decision are tracked in `PROJECT_PROGRESS.md`.

---

## Use of AI tools and third-party code

This project was developed with AI assistance, as permitted by the course rules.

- **Claude (Anthropic)** was used for architecture review, code generation and refactoring (SQLite migration, voting
  engine, CSV validation, Google SSO roles, survey delegation, UI redesign, tests and documentation). All generated code
  was reviewed and tested; the author is responsible for understanding it.

Third-party libraries (each under its own license): [Oak](https://github.com/oakserver/oak) (HTTP framework),
[nodemailer](https://github.com/nodemailer/nodemailer) by Andris Reinman (SMTP),
[jose](https://github.com/panva/jose) by Filip Skokan (JWT), [@react-oauth/google](https://github.com/MomenSherif/react-oauth)
by MomenSherif (Google button), React, React Router, Bootstrap and Vite. The icons in `client/src/components/ui/Icon.jsx`
were drawn for this project.
