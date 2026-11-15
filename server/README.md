# Server (Deno + Oak REST API)

Backend of the Electronic Voting & Mass Survey System. See the root `README.md` for the project overview and the `client/README.md` for the frontend.

- **Runtime:** Deno 2.x, HTTP framework [Oak](https://github.com/oakserver/oak)
- **Persistence:** JSON files (no external database), written atomically behind a shared write lock
- **Auth:** Google SSO (ID token verified on the server) + signed session tokens
- **Email:** real SMTP through `nodemailer`, with a console simulation fallback

---

## Run

From the **repository root** (so `.env` is found):

```bash
deno task dev      # watch mode
deno task start    # no watch
```

Equivalent command:

```bash
deno run --allow-net --allow-read --allow-write --allow-env --allow-sys server/server.ts
```

| Permission | Why it is needed |
|------------|------------------|
| `--allow-net` | HTTP server, Google public keys (JWKS), SMTP |
| `--allow-read` / `--allow-write` | JSON data files, uploads, `.env` |
| `--allow-env` | Reading configuration |
| `--allow-sys` | `nodemailer` reads host information |

Type-check before delivering:

```bash
deno check server/server.ts
```

Environment variables are documented in the root `README.md` and in `.env.example`.

---

## Folder structure

```
server/
├── server.ts              HTTP layer: routes, validation, error mapping, CORS
├── services/
│   ├── authService.ts     Google ID-token verification, session tokens, allow-lists
│   ├── adminService.ts    Motion creation, CSV import, attachment storage, email dispatch
│   ├── emailService.ts    Localized emails: SMTP or console simulation
│   ├── voterService.ts    CSV parsing/validation, token generation, voters.json access
│   ├── votingService.ts   Vote engine: token checks, weighting, motions schema
│   └── surveyService.ts   Survey creation, auto-categorization, answers, delegation
├── utils/
│   └── fileLock.ts        Process-wide write lock (single promise queue)
├── voters.json            Voters and their one-time tokens
├── motions.json           Motions and weighted results
├── data.json              The current survey
└── uploads/               Stored attachments (created at runtime, git-ignored)
```

### Layering rules

1. `server.ts` only deals with HTTP: parsing the request, checking the session, choosing status codes. It contains no business rules.
2. Services contain the business rules and throw typed errors that carry an HTTP status and, when useful, a stable `code`:
   `VotingServiceError`, `SurveyServiceError`, `AdminServiceError`, `AuthServiceError`.
3. Services never import `server.ts`. Dependencies go one way: `server.ts` → services → `utils`.

---

## Data files

### `voters.json`

```json
[
  {
    "email": "ana@example.com",
    "name": "Ana Garcia",
    "birthdate": "1990-04-12",
    "gender": "female",
    "weight": 62,
    "token": "e9b1c2d4-....",
    "tokenExpiresAt": "2026-11-17T18:30:00.000Z",
    "hasVoted": false,
    "motionId": "0330c4a3-babe-4864-a8f7-7f2828cdc926"
  }
]
```

- One record per voter **per motion**; the token is bound to `motionId`.
- `tokenExpiresAt` is 48 hours after creation. Legacy records without it never expire.
- `weight` comes from the CSV and is the amount added to the tally.

### `motions.json` (unified schema)

```json
[
  {
    "id": "0330c4a3-babe-4864-a8f7-7f2828cdc926",
    "title": "Approve the 2027 budget",
    "description": "Full text shown on the voting page.",
    "options": ["approve", "reject"],
    "results": { "approve": 62, "reject": 0 },
    "attachment": { "originalName": "budget.pdf", "storedName": "<id>-budget.pdf", "mimeType": "application/pdf", "size": 233080 },
    "voterCount": 3,
    "createdAt": "2026-11-01T23:11:24.650Z"
  }
]
```

`votingService` migrates older files automatically: it unwraps a `{ "motions": [...] }` wrapper, defaults `options` to `approve`/`reject` and fills missing `results` with zero.

### `data.json` (survey)

```json
{
  "id": "survey-1a2b3c4d",
  "title": "Annual sustainability questionnaire",
  "initialRecipient": "ceo@company.com",
  "createdAt": "2026-11-02T10:00:00.000Z",
  "progress": { "totalQuestions": 12, "answeredQuestions": 3, "pendingQuestions": 9, "completionPercentage": 25, "byCategory": {} },
  "questions": [
    {
      "id": "q-001",
      "category": "finance",
      "text": "What is the budget for 2027?",
      "originalAssignee": "ceo@company.com",
      "currentOwner": "cfo@company.com",
      "status": "pending",
      "answer": null,
      "answeredAt": null,
      "delegationHistory": [{ "from": "ceo@company.com", "to": "cfo@company.com", "delegatedAt": "2026-11-02T10:05:00.000Z" }]
    }
  ]
}
```

`progress` is never trusted from disk: it is recalculated on every change.

---

## API reference

All error responses use the same shape:

```json
{ "error": "Human-readable message", "code": "STABLE_CODE", "details": ["optional list"] }
```

### Authentication

| Method | Route | Body | Success |
|--------|-------|------|---------|
| POST | `/api/auth/google` | `{ "credential": "<Google ID token>" }` | `200 { user, token, expiresAt }` |

Errors: `400 INVALID_CREDENTIAL`, `401 INVALID_CREDENTIAL`, `403 UNAUTHORIZED_USER`, `500 SSO_NOT_CONFIGURED`.

Protected routes expect `Authorization: Bearer <token>` and answer `401 UNAUTHENTICATED` without a valid session.

### Admin (session required)

| Method | Route | Purpose |
|--------|-------|---------|
| POST | `/api/admin/dispatch` | Multipart form: `title`, `description`, `attachment` (file, max 10 MB), `votersCsv` (file), optional `options` (comma or newline separated, 2–10 unique values; default approve/reject). Creates the motion, imports voters and sends the emails. Returns `201 { motionId, imported, emailsSent, emailsFailed, deliveryMode }`. |
| POST | `/api/admin/voters/upload?motionId=<id>&lang=en\|es` | Raw CSV body. Imports voters into an **existing** motion and sends the emails. Returns `201 { imported, emails, emailsSent, emailsFailed, deliveryMode }`. Errors: `404 MOTION_NOT_FOUND`, `409` duplicates, `413`, `422` invalid CSV. |

Voters CSV header (exact): `email,name,birthdate,gender,weight`. Dates must be real past `YYYY-MM-DD` dates, weights positive, emails unique.

`deliveryMode` is `smtp` for real delivery and `simulated` when the message was printed to the console.

### Voting (public, protected by the one-time token)

| Method | Route | Purpose |
|--------|-------|---------|
| GET | `/api/vote/context?token=…` | Returns `{ motion: { id, title, description, options }, voter: { name, hasVoted, isExpired, tokenExpiresAt } }`. |
| POST | `/api/vote` | Body `{ token, motionId, choice }`. Returns `200 { message }`. |

Vote error codes:

| Code | Status | Meaning |
|------|--------|---------|
| `INVALID_TOKEN` | 404 | Unknown token, or token of another motion |
| `MOTION_NOT_FOUND` | 404 | The motion no longer exists |
| `ALREADY_VOTED` | 403 | The token was already used |
| `TOKEN_EXPIRED` | 403 | More than 48 hours passed |
| `INVALID_OPTION` | 400 | `choice` is not one of the motion's options |

Checks run in this order: token exists and belongs to the motion → not used → not expired → motion exists → option valid.

### Survey

| Method | Route | Auth | Purpose |
|--------|-------|------|---------|
| GET | `/api/survey` | – | Current survey with progress. |
| POST | `/api/survey/create` | session | Body `{ title, initialRecipient, questions: string[], force? }`. Categorizes each question automatically. `201 { message, survey }`. `409` if the current survey already has answers and `force` is not `true`. |
| POST | `/api/survey/answer` | session* | Body `{ questionId, answerText, userEmail? }`. |
| POST | `/api/survey/delegate` | session* | Body `{ questionId \| category, newOwnerEmail, currentOwnerEmail? }` (exactly one of `questionId` or `category`). |

\* The acting email comes from the session. Only when the server runs with `ALLOW_DEMO_SURVEY_IDENTITY=true` is the email in the body accepted without a session (live-demo mode). Otherwise the answer is `401 UNAUTHENTICATED`.

Survey errors: `400` invalid input, `403` caller does not own the question, `404` unknown question or category, `409` already answered or nothing pending to delegate.

---

## How the key mechanisms work

### Write lock (`utils/fileLock.ts`)

`withWriteLock(task)` chains every read-modify-write cycle on one promise queue shared by all services. Two requests can never interleave a read and a write on the same file, which prevents lost updates (for example two simultaneous votes). Limitations: it protects a single process only, and it is not re-entrant (a locked task must not call `withWriteLock` again).

Files are written to a `.tmp` file and then renamed, so a crash never leaves half-written JSON.

### Voting engine (`services/votingService.ts`)

- The voter's `weight` is added to the chosen option **on the server**; the client never sends a weight.
- The token is burned (`hasVoted = true`) **before** the tally is saved. If saving the tally fails, the voters file is restored, so a voter is never locked out without a counted vote and a token is never reusable.
- Tokens are random UUIDs (122 random bits) and each one is bound to a single motion.

### Authentication (`services/authService.ts`)

1. The client sends the Google ID token.
2. The server checks the signature against Google's public keys, the issuer, the audience (`GOOGLE_CLIENT_ID`), the expiry and `email_verified`.
3. It applies the optional allow-lists (`ALLOWED_EMAILS`, `ALLOWED_EMAIL_DOMAINS`).
4. It issues its own HS256 session token valid for 8 hours. The email always comes from the verified payload, never from a client-supplied field.

### Email (`services/emailService.ts`)

- With `SMTP_USER` and `SMTP_PASS` set, messages go through SMTP.
- Without them, each message is printed to the console as `SIMULATED EMAIL`, including the voting link, so the flow can be demonstrated offline.
- Templates exist in English and Spanish (local data, no translation API). The greeting depends on the voter's gender and the attachment is included when the motion has one.

### Survey auto-categorization (`services/surveyService.ts`)

`categorizeQuestion(text)` lower-cases the text, removes accents and counts keyword matches (word prefixes) per category: `finance`, `operations`, `environment`, `marketing`, `hr`, `legal`, `it`. The category with the most hits wins; ties go to the earlier category; no hit gives `general`. English and Spanish keywords are supported.

### Delegation

A question has exactly one `currentOwner`. Delegating a question, or every pending question of a category owned by the caller, transfers ownership: the previous owner loses the right to answer and each transfer is appended to `delegationHistory`.

---

## Manual test checklist

1. `deno check server/server.ts` finishes without errors.
2. Sign in with Google, then create a motion from `/admin`.
3. Open the printed voting link and vote; the weight appears in `motions.json`.
4. Open the same link again: `ALREADY_VOTED`.
5. Set `tokenExpiresAt` of another voter to a past date: `TOKEN_EXPIRED`.
6. Change one character of the token: `INVALID_TOKEN`.
7. Delegate a question, switch the active user and answer it; the previous owner gets `403`.

Quick API check from PowerShell:

```powershell
Invoke-RestMethod "http://localhost:8000/api/vote/context?token=PASTE_TOKEN"
```

---

## Troubleshooting

| Symptom | Cause and fix |
|---------|---------------|
| `SSO_NOT_CONFIGURED` | `GOOGLE_CLIENT_ID` is missing. Fix `.env` and restart the server. |
| `401 UNAUTHENTICATED` on admin routes | Session expired (8 hours) or the account is not in `ALLOWED_EMAILS`. Sign in again. |
| `401` on survey routes | Sign in, or start the server with `ALLOW_DEMO_SURVEY_IDENTITY=true`. |
| CORS error in the browser | Use `http://localhost:5173` (not `127.0.0.1`), and keep `ALLOWED_ORIGIN` equal to that origin. |
| Emails never arrive | Without SMTP credentials they are only printed in the server console. For Gmail use an app password. |
| `voters.json is corrupted` | The file is not a JSON array. Restore it to `[]`. |

---

## Known limitations

- JSON files are a demo-scale database; the write lock only protects a single process.
- Voting links travel in the URL, so anyone holding the email can vote with that token until it is used or expires.
- There is no automated test suite yet.