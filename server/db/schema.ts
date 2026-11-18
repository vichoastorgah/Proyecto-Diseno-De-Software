/**
 * @module db/schema
 * Versioned PostgreSQL migrations, tracked in `schema_migrations`.
 * Migrations are append-only: never edit a published step, add a new one.
 *
 * Row Level Security is enabled on every table WITHOUT policies: Supabase exposes the
 * `public` schema through its REST API to anyone holding the project URL and anon key, and
 * RLS blocks that path completely. The API server connects as the table owner, which
 * bypasses RLS, so the application keeps working.
 */
import type { Db } from "./database.ts";

const TABLES = [
  "meta",
  "elections",
  "motions",
  "motion_options",
  "attachments",
  "voters",
  "ballots",
  "surveys",
  "survey_questions",
  "survey_delegations",
];

const MIGRATIONS: readonly string[] = [
  // 1 - Initial schema.
  `
  CREATE TABLE meta (
    key   text PRIMARY KEY,
    value text NOT NULL
  );

  -- A "votación": groups one or more motions, a voter list and attachments.
  CREATE TABLE elections (
    id          text PRIMARY KEY,
    title       text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
    description text NOT NULL DEFAULT '',
    status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
    created_by  text,
    created_at  timestamptz NOT NULL,
    closed_at   timestamptz,
    -- Idempotency key sent by the client: a retried submission never creates a duplicate.
    request_id  text UNIQUE
  );

  CREATE TABLE motions (
    id          text PRIMARY KEY,
    election_id text NOT NULL REFERENCES elections(id) ON DELETE CASCADE,
    position    integer NOT NULL,
    title       text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
    description text NOT NULL DEFAULT '',
    UNIQUE (election_id, position)
  );

  CREATE TABLE motion_options (
    id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    motion_id text NOT NULL REFERENCES motions(id) ON DELETE CASCADE,
    position  integer NOT NULL,
    label     text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 60),
    UNIQUE (motion_id, label),
    UNIQUE (motion_id, position),
    UNIQUE (motion_id, id)
  );

  CREATE TABLE attachments (
    id            text PRIMARY KEY,
    election_id   text NOT NULL REFERENCES elections(id) ON DELETE CASCADE,
    original_name text NOT NULL,
    stored_name   text NOT NULL UNIQUE,
    mime_type     text NOT NULL,
    size          bigint NOT NULL CHECK (size > 0),
    created_at    timestamptz NOT NULL
  );

  -- One row per person invited to an election. Only the SHA-256 hash of the voting
  -- token is stored: a database leak does not reveal usable links.
  CREATE TABLE voters (
    id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    election_id       text NOT NULL REFERENCES elections(id) ON DELETE CASCADE,
    email             text NOT NULL,
    name              text NOT NULL,
    birthdate         date NOT NULL,
    gender            text NOT NULL CHECK (gender IN ('male', 'female', 'other')),
    weight            double precision NOT NULL CHECK (weight > 0),
    token_hash        text NOT NULL UNIQUE,
    token_expires_at  timestamptz,
    has_voted         boolean NOT NULL DEFAULT false,
    voted_at          timestamptz,
    invitation_status text NOT NULL DEFAULT 'pending'
                      CHECK (invitation_status IN ('pending', 'sent', 'simulated', 'failed', 'legacy')),
    invited_at        timestamptz,
    created_at        timestamptz NOT NULL,
    UNIQUE (election_id, email),
    CHECK (has_voted = (voted_at IS NOT NULL))
  );
  CREATE INDEX voters_election ON voters (election_id);

  -- Anonymous weighted ballots (no voter reference, random ids, no timestamps), so a
  -- vote cannot be traced back to a person. 'legacy' rows hold tallies imported from
  -- the former JSON storage, where individual ballots were not kept.
  CREATE TABLE ballots (
    id        text PRIMARY KEY,
    motion_id text NOT NULL REFERENCES motions(id) ON DELETE CASCADE,
    option_id bigint NOT NULL,
    weight    double precision NOT NULL CHECK (weight > 0),
    source    text NOT NULL DEFAULT 'vote' CHECK (source IN ('vote', 'legacy')),
    FOREIGN KEY (motion_id, option_id) REFERENCES motion_options (motion_id, id) ON DELETE CASCADE
  );
  CREATE INDEX ballots_motion ON ballots (motion_id, option_id);

  CREATE TABLE surveys (
    id                text PRIMARY KEY,
    title             text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
    initial_recipient text NOT NULL,
    created_by        text,
    created_at        timestamptz NOT NULL
  );

  -- current_owner is a single column: a question can never have two responsibles.
  CREATE TABLE survey_questions (
    id                text PRIMARY KEY,
    survey_id         text NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
    position          integer NOT NULL,
    code              text NOT NULL,
    category          text NOT NULL,
    text              text NOT NULL CHECK (char_length(text) BETWEEN 1 AND 1000),
    original_assignee text NOT NULL,
    current_owner     text NOT NULL,
    status            text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'answered')),
    answer            text,
    answered_by       text,
    answered_at       timestamptz,
    UNIQUE (survey_id, position),
    UNIQUE (survey_id, code),
    CHECK ((status = 'answered') = (answer IS NOT NULL))
  );
  CREATE INDEX survey_questions_owner ON survey_questions (current_owner);

  CREATE TABLE survey_delegations (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    question_id  text NOT NULL REFERENCES survey_questions(id) ON DELETE CASCADE,
    from_email   text NOT NULL,
    to_email     text NOT NULL,
    delegated_at timestamptz NOT NULL,
    CHECK (from_email <> to_email)
  );
  CREATE INDEX survey_delegations_question ON survey_delegations (question_id);
  CREATE INDEX survey_delegations_to ON survey_delegations (to_email);

  ${TABLES.map((table) => `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`).join("\n  ")}
  `,
];

/** Applies every pending migration, each in its own transaction (serialized with an advisory lock). */
export async function applyMigrations(db: Db): Promise<void> {
  await db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());" +
      "ALTER TABLE schema_migrations ENABLE ROW LEVEL SECURITY;",
  );
  for (let index = 0; index < MIGRATIONS.length; index++) {
    const version = index + 1;
    await db.transaction(async (tx) => {
      // Two server instances starting at once must not apply the same step twice.
      await tx.run("SELECT pg_advisory_xact_lock(4210)");
      if (await tx.get("SELECT 1 FROM schema_migrations WHERE version = $1", version)) return;
      await tx.exec(MIGRATIONS[index]);
      await tx.run("INSERT INTO schema_migrations (version) VALUES ($1)", version);
    });
  }
}

/** Latest schema version known by this build. */
export const SCHEMA_VERSION = MIGRATIONS.length;
