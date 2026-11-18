# Server (Deno + Oak + SQLite)

REST API of the voting and survey system. Run every command from the **repository root** so `.env` and `deno.json`
are found.

```bash
deno task dev      # watch mode, http://localhost:8000
deno task start    # without watch
deno task test     # 35 integration tests
deno task check    # type check (server + tests)
deno task lint
```

Permissions: `--allow-net` (HTTP, Google keys, SMTP), `--allow-read/--allow-write` (database, uploads, `.env`),
`--allow-env`, `--allow-sys` (nodemailer).

---

## Layout

```
server/
├── server.ts            Entry point: config → openDatabase (migrations) → legacy import → mailer → auth → app.listen
├── app.ts               createApp(deps): error handler, security headers, CORS, rate limit, routers
├── config.ts            Typed environment (loadConfig)
├── context.ts           ServiceContext { db, config, mailer }
├── errors.ts            AppError(status, code, message, details?)
├── db/
│   ├── database.ts      openDatabase, transaction(), all/get/run helpers (node:sqlite, synchronous)
│   ├── schema.ts        Versioned migrations (PRAGMA user_version)
│   └── legacyImport.ts  One-time, read-only import of voters.json / motions.json / data.json
├── http/                Route modules (parsing + role checks only)
├── services/
│   ├── electionService.ts   Elections, motions, voters, invitations, results, integrity, dashboard
│   ├── votingService.ts     Ballot context and casting
│   ├── surveyService.ts     Categorization, surveys, answers, delegation, visibility
│   ├── csvService.ts        Voters CSV parsing/validation
│   ├── attachmentService.ts Allow-list, content sniffing, safe storage
│   ├── emailService.ts      Mailer (SMTP / console / test) and ES/EN templates
│   ├── authService.ts       Google ID token verification, sessions, roles
│   └── tokenService.ts      Token generation and hashing
└── tests/               Deno tests (app.handle with an in-memory database)
```

**Why synchronous SQLite?** `node:sqlite` is built into Deno (no dependency) and synchronous. A transaction body is a
synchronous function, so no other request can interleave between `BEGIN` and `COMMIT` on the single connection.
Async work (hashing, file I/O, email) happens before or after `transaction()`.

---

## Schema (migration 1)

| Table | Key columns | Notes |
|-------|-------------|-------|
| `elections` | `id`, `title`, `description`, `status` (`open`/`closed`), `created_by`, `created_at`, `closed_at` | A "votación" |
| `motions` | `id`, `election_id` → elections, `position`, `title`, `description` | 1–20 per election |
| `motion_options` | `id`, `motion_id` → motions, `position`, `label` | 2–10 per motion, unique label |
| `attachments` | `id`, `election_id`, `original_name`, `stored_name` (`<uuid>.<ext>`), `mime_type`, `size` | Files in `uploads/` |
| `voters` | `id`, `election_id`, `email`, `name`, `birthdate`, `gender`, `weight > 0`, `token_hash` (unique), `token_expires_at`, `has_voted`, `voted_at`, `invitation_status` | `UNIQUE(election_id, email)` |
| `ballots` | `id` (random), `motion_id`, `option_id`, `weight`, `source` (`vote`/`legacy`) | **No voter reference**; composite FK guarantees the option belongs to the motion |
| `surveys` | `id`, `title`, `initial_recipient`, `created_by`, `created_at` | |
| `survey_questions` | `id`, `survey_id`, `position`, `code`, `category`, `text`, `original_assignee`, `current_owner`, `status`, `answer`, `answered_by`, `answered_at` | `current_owner` is one column → one responsible |
| `survey_delegations` | `question_id`, `from_email`, `to_email`, `delegated_at` | Audit trail |
| `meta` | `key`, `value` | Records the legacy import |

---

## API

All errors: `{ "error": "<English message>", "code": "<STABLE_CODE>", "details"?: [{ code, message, row?, field?, value? }] }`.

### Auth
| Method | Route | Auth | Result |
|--------|-------|------|--------|
| POST | `/api/auth/google` `{ credential }` | – | `{ user: { email, name, picture, isAdmin }, token, expiresAt }` · 400/401 `INVALID_CREDENTIAL`, 403 `UNAUTHORIZED_USER`, 500 `SSO_NOT_CONFIGURED` |
| GET | `/api/auth/me` | session | `{ user, demoSurveyIdentity }` |

### Admin (role admin)
| Method | Route | Result |
|--------|-------|--------|
| GET | `/api/admin/summary` | Dashboard figures |
| GET | `/api/admin/elections` | `{ elections: [{ id, title, status, stats }] }` |
| POST | `/api/admin/elections` (multipart: `title`, `description`, `motions` JSON, `votersCsv`, `attachments`×0-5, `lang`) | 201 `{ electionId, imported, emailsSent, emailsFailed, deliveryMode }` · 400 `VALIDATION_ERROR`, 422 `CSV_VALIDATION_FAILED`, 400/413 `ATTACHMENT_*` |
| POST | `/api/admin/csv/validate` (multipart `votersCsv`) | `{ totalRecords, validRecords, totalWeight, errors, preview }` (nothing saved) |
| GET | `/api/admin/elections/:id` | Motions with weighted results and `integrity`, attachments, invitations, stats |
| GET | `/api/admin/elections/:id/voters?search&status=all\|voted\|pending&page&pageSize` | Paginated voters (no birthdates) |
| POST | `/api/admin/elections/:id/voters` (multipart `votersCsv`, `lang`) | 201 · 409 `VOTERS_ALREADY_EXIST` / `ELECTION_CLOSED` |
| POST | `/api/admin/elections/:id/voters/:voterId/resend?lang=` | New token (old link stops working) · 409 `ALREADY_VOTED` |
| POST | `/api/admin/elections/:id/status` `{ status: "open"\|"closed" }` | Updated summary |
| GET | `/api/admin/elections/:id/attachments/:attachmentId` | File download |
| POST | `/api/admin/dispatch`, `/api/admin/voters/upload?motionId=` | Former endpoints (single motion), still accepted |

### Voting (public, the link token is the credential)
| Method | Route | Result |
|--------|-------|--------|
| GET | `/api/vote/context?token=` | `{ election, motions[{ id, title, description, options }], attachments, voter{ name, hasVoted, isExpired, tokenExpiresAt } }` · 404 `INVALID_TOKEN` |
| POST | `/api/vote` `{ token, choices: { motionId: option } }` | 200 · 403 `ALREADY_VOTED` / `TOKEN_EXPIRED` / `ELECTION_CLOSED`, 400 `INCOMPLETE_BALLOT` / `INVALID_OPTION` / `INVALID_MOTION` |
| GET | `/api/vote/attachments/:attachmentId?token=` | Document of the link's own election |

### Surveys (signed in)
| Method | Route | Result |
|--------|-------|--------|
| GET | `/api/surveys` | Surveys visible to the caller with role and pending count |
| POST | `/api/surveys` (admin) `{ title, initialRecipient, questions[], lang }` | 201 `{ survey, notified }` |
| POST | `/api/surveys/categorize` (admin) `{ questions[] }` | Categorization preview |
| GET | `/api/surveys/:id` | Survey as seen by the caller (`viewerRole`, `progress`, visible `questions`, `hiddenQuestionCount`) |
| POST | `/api/surveys/:id/questions/:questionId/answer` `{ answer }` | 403 `NOT_QUESTION_OWNER`, 409 `QUESTION_ALREADY_ANSWERED` |
| POST | `/api/surveys/:id/delegate` `{ questionIds[] \| category, newOwnerEmail, lang }` | `{ survey, transferredQuestionIds, notified }` · all-or-nothing |

Demo mode (`ALLOW_DEMO_SURVEY_IDENTITY=true`): an admin may send `X-Act-As: <email>` to act as that person.

---

## Rules worth knowing (edge cases)

- **Single vote:** `UPDATE voters SET has_voted = 1 … WHERE id = ? AND has_voted = 0` inside the ballot transaction;
  zero changed rows means another request already voted (tested with 10 concurrent requests).
- **Weights** come from the CSV, never from the request. Integrity: per motion, ballot weight = weight of voters who voted.
- **Expiry:** links expire after `VOTE_TOKEN_TTL_HOURS` (48 h). Imported legacy links without expiry never expire.
- **CSV:** whole file rejected if any row is invalid; duplicates inside the file and against the election are reported.
- **Delegation:** only the current owner of a pending question can delegate it; delegating to oneself is rejected;
  a batch with one foreign question changes nothing.
- **Visibility:** admin and recipient see everything; participants only the questions they handled; others get 404.
- **Legacy import:** runs once, in one transaction, only on an empty database; JSON files are never modified.

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `SSO_NOT_CONFIGURED` | Set `GOOGLE_CLIENT_ID` in `.env` and restart. |
| `403 UNAUTHORIZED_USER` on sign-in | Add the account to `ADMIN_EMAILS` or `ALLOWED_EMAILS` (or assign it a survey). |
| Sessions end on every restart | Set a `SESSION_SECRET` of 32+ characters. |
| Emails never arrive | Without `SMTP_USER`/`SMTP_PASS` they are printed in the console. For Gmail use an app password. |
| `[integrity]` warning at startup | Recorded ballot weight differs from voters who voted (only possible with inconsistent legacy data). |
