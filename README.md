# Electronic Voting & Mass Survey System

A web platform that manages **weighted electronic votes** and **mass questionnaires with delegation**, in the spirit of "SurveyMonkey, but for votes". Built for the *Software Design* course (TICS316-2-2026), project topic 6.

- **Admin portal** (Google SSO): create a motion, upload a voters CSV, attach a document and send a personalized email with a unique voting link to every voter.
- **One-time voting links**: each voter votes once; the server applies the weight from the CSV.
- **Mass surveys**: questions are categorized automatically, the recipient can delegate questions or whole categories, and progress is consolidated in real time.
- **Responsive UI** (Bootstrap 5) and **custom multi-language support** (English / Spanish, local JSON dictionaries, no translation APIs).

---

## Documentation map

| Document | Contents |
|----------|----------|
| `README.md` (this file) | Overview, architecture, setup, environment variables, AI usage |
| [`server/README.md`](server/README.md) | Deno API: routes, data schemas, error codes, locking, auth, troubleshooting |
| [`client/README.md`](client/README.md) | React app: scripts and routes |

---

## Architecture (monorepo)

```
.
├── client/                      React 19 + Vite single-page app
│   └── src/
│       ├── config.js            API base URL and Google client id (Vite env)
│       ├── context/
│       │   ├── AuthContext.jsx      Google SSO session (token kept in sessionStorage)
│       │   └── LanguageContext.jsx  t(key, params) with {placeholder} interpolation
│       ├── locales/             en.json / es.json (identical key sets)
│       ├── pages/               LoginView, AdminView, VotingView, SurveyView
│       └── components/          Navbar, ProtectedRoute
├── server/                      Deno + Oak REST API
│   ├── server.ts                HTTP layer: routing, validation, error mapping
│   ├── services/
│   │   ├── authService.ts       Google ID-token verification + signed session tokens
│   │   ├── adminService.ts      Motion creation, CSV import, attachment storage, dispatch
│   │   ├── emailService.ts      Personalized emails (SMTP via nodemailer, console fallback)
│   │   ├── voterService.ts      CSV parsing/validation, token generation, voters.json access
│   │   ├── votingService.ts     Vote engine, token expiry, unified motions schema
│   │   └── surveyService.ts     Survey creation, auto-categorization, answers, delegation
│   ├── utils/fileLock.ts        Shared write lock (single promise queue)
│   ├── README.md                Backend documentation
│   ├── voters.json              Voters and their one-time tokens
│   ├── motions.json             Motions and weighted results
│   ├── data.json                Current survey
│   └── uploads/                 Stored attachments (created at runtime)
├── .env.example                 Server environment template
├── deno.json                    Deno tasks
└── README.md
```

**Layering.** `server.ts` only handles HTTP concerns (parsing, status codes, auth checks). All business rules live in `services/`, which throw typed errors (`VotingServiceError`, `SurveyServiceError`, `AdminServiceError`, `AuthServiceError`) carrying an HTTP status and, where relevant, a stable `code` that the client translates.

**Persistence.** JSON files are used as a lightweight database. Every read-modify-write cycle goes through `withWriteLock` (`server/utils/fileLock.ts`), a single promise queue shared by all services, and files are written atomically (temp file + rename). The lock protects a single server process; it is not re-entrant.

---

## Requirements

| Tool | Version |
|------|---------|
| [Deno](https://deno.com) | 2.x |
| Node.js | 20.19+ or 22.12+ (for Vite) |
| A Google OAuth client | Web application type |

---

## Getting started

### 1. Google OAuth client

1. In Google Cloud Console create an **OAuth client ID** of type *Web application*.
2. Add `http://localhost:5173` to **Authorized JavaScript origins**.
3. Copy the client id; it is used by both the client and the server.

### 2. Server

```bash
cp .env.example .env        # then edit the values
deno task dev               # or: deno run --allow-net --allow-read --allow-write --allow-env --allow-sys server/server.ts
```

Run it from the repository root so `.env` is found. The API listens on `http://localhost:8000`.

| Variable | Required | Description |
|----------|----------|-------------|
| `GOOGLE_CLIENT_ID` | yes | OAuth client id (must match the client). |
| `SESSION_SECRET` | recommended | 32+ characters used to sign session tokens. A random one is generated if missing (sessions reset on restart). |
| `ALLOWED_EMAILS` / `ALLOWED_EMAIL_DOMAINS` | recommended | Comma-separated allow-lists. If both are empty, **any** verified Google account can sign in. |
| `SMTP_USER`, `SMTP_PASS` | no | Enable real email delivery. If either is missing, emails are **simulated in the console**. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_FROM` | no | SMTP details (defaults: `smtp.gmail.com`, `587`, `false`, `SMTP_USER`). For Gmail use an *app password*. |
| `VOTE_BASE_URL` | no | Base URL of the voting page used in emails (default `http://localhost:5173/vote`). |
| `DEFAULT_EMAIL_LANGUAGE` | no | `en` or `es` (default `en`). |
| `ALLOW_DEMO_SURVEY_IDENTITY` | no | `true` lets the survey endpoints accept the email in the request body when no session exists (live-demo mode, to act as several colleagues). Default `false`: a Google sign-in is required. |
| `ALLOWED_ORIGIN` | no | CORS origin (default `http://localhost:5173`). |
| `PORT` | no | API port (default `8000`). |

### 3. Client

```bash
cd client
npm install
npm install @react-oauth/google
cp .env.example .env        # set VITE_GOOGLE_CLIENT_ID
npm run dev
```

Open `http://localhost:5173`.

---

## How it works

### Authentication (real Google SSO)

1. The login page renders Google's button (`@react-oauth/google`) and receives a signed **ID token**.
2. The client sends it to `POST /api/auth/google`.
3. The server verifies signature, issuer, audience, expiry and `email_verified` against Google's public keys (`jose`), applies the optional allow-list and returns its own **8-hour session token** (HS256).
4. Protected routes read `Authorization: Bearer <token>`. The user's email always comes from the verified token, never from the request body.

### Voting flow

1. The admin submits the motion form (`POST /api/admin/dispatch`): title, description, attachment, voters CSV and optional custom options (default: approve / reject).
2. Each voter gets a unique token **bound to that motion** and valid for **48 hours**, plus a personalized email (greeting by gender, language `en`/`es`, attachment included).
3. The voting page calls `GET /api/vote/context?token=…` and renders the title, description and options returned by the server. Nothing about the motion is hardcoded in the client.
4. `POST /api/vote` checks, in order: token exists and belongs to the motion → not already used → not expired → option valid. It then adds the voter's CSV `weight` to the chosen option on the server.

### Surveys

- `POST /api/survey/create` categorizes every question by keyword matching (finance, operations, environment, marketing, hr, legal, it; fallback `general`). English and Spanish keywords are supported.
- A question has exactly one owner. Delegating a question (or all pending questions of a category) transfers ownership and records an audit trail.
- Progress (global and per category) is always recalculated on the server.

### Internationalization

`t(key, params)` resolves dotted keys in `en.json` / `es.json`, interpolates `{placeholders}` (for example `t("voting.greeting", { name })`) and falls back to English, then to the key itself. The selected language is persisted in `localStorage`. Server errors carry a `code` that the client maps to translated messages; emails are localized with their own local templates.

---

## API reference

| Method | Route | Auth | Purpose |
|--------|-------|------|---------|
| POST | `/api/auth/google` | – | Exchange a Google ID token for a session. |
| POST | `/api/admin/dispatch` | session | Create a motion, import voters (multipart), send emails. |
| POST | `/api/admin/voters/upload?motionId=…&lang=en\|es` | session | Import a CSV (raw body) into an existing motion and send emails. |
| GET | `/api/vote/context?token=…` | – | Motion details and voter status for a link. |
| POST | `/api/vote` | token | Cast a weighted vote. |
| GET | `/api/survey` | – | Current survey. |
| POST | `/api/survey/create` | session | Create a survey with automatic categorization. |
| POST | `/api/survey/answer` | session* | Answer a question you own. |
| POST | `/api/survey/delegate` | session* | Delegate a question or category. |

\* The identity comes from the session. Only when the server runs with `ALLOW_DEMO_SURVEY_IDENTITY=true` is the `userEmail` / `currentOwnerEmail` body field accepted without a session.

Vote error codes: `INVALID_TOKEN` (404), `MOTION_NOT_FOUND` (404), `TOKEN_EXPIRED` (403), `ALREADY_VOTED` (403), `INVALID_OPTION` (400).

### Voters CSV

```csv
email,name,birthdate,gender,weight
ana.garcia@example.com,Ana Garcia,1990-04-12,female,62
carlos.perez@example.com,Carlos Perez,1985-09-30,male,78
```

Exact header required, valid past `YYYY-MM-DD` dates, positive weights, no duplicate emails.

---

## Known limitations

- Data lives in JSON files; this is intended for a course demo, not for production scale. The write lock only covers a single process.
- In demo mode (`ALLOW_DEMO_SURVEY_IDENTITY=true`) the survey dashboard lets the presenter type any email to act as a colleague; this is intentionally disabled by default.
- Voting links travel in the URL, so anyone holding the email can vote with that token until it is used or expires.
- There is no automated test suite yet; behavior was verified manually.

---

## Use of AI tools and third-party code

This project was developed with AI assistance, as permitted by the course rules.

- **Claude (Anthropic)** was used for architecture review, code generation and refactoring (concurrency lock, vote/token logic, email service, Google SSO flow, survey auto-categorization, i18n interpolation, this README). All generated code was reviewed, adapted and tested by the author, who is responsible for understanding it.

Third-party libraries (each under its own license): [Oak](https://github.com/oakserver/oak) (HTTP framework), [nodemailer](https://github.com/nodemailer/nodemailer) by Andris Reinman (SMTP), [jose](https://github.com/panva/jose) by Filip Skokan (JWT verification and signing), [@react-oauth/google](https://github.com/MomenSherif/react-oauth) by MomenSherif (Google sign-in button), React, React Router, Bootstrap and Vite.