/**
 * @module db/schema
 * Versioned schema migrations (tracked with `PRAGMA user_version`).
 * Migrations are append-only: never edit a published step, add a new one.
 */
import type { DatabaseSync } from "node:sqlite";

const MIGRATIONS: readonly string[] = [
  // 1 - Initial schema.
  `
  CREATE TABLE meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- A "votación": groups one or more motions, a voter list and attachments.
  CREATE TABLE elections (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
    description TEXT NOT NULL DEFAULT '',
    status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
    created_by  TEXT,
    created_at  TEXT NOT NULL,
    closed_at   TEXT
  );

  CREATE TABLE motions (
    id          TEXT PRIMARY KEY,
    election_id TEXT NOT NULL REFERENCES elections(id) ON DELETE CASCADE,
    position    INTEGER NOT NULL,
    title       TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
    description TEXT NOT NULL DEFAULT '',
    UNIQUE (election_id, position)
  );

  CREATE TABLE motion_options (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    motion_id TEXT NOT NULL REFERENCES motions(id) ON DELETE CASCADE,
    position  INTEGER NOT NULL,
    label     TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 60),
    UNIQUE (motion_id, label),
    UNIQUE (motion_id, position),
    UNIQUE (motion_id, id)
  );

  CREATE TABLE attachments (
    id            TEXT PRIMARY KEY,
    election_id   TEXT NOT NULL REFERENCES elections(id) ON DELETE CASCADE,
    original_name TEXT NOT NULL,
    stored_name   TEXT NOT NULL UNIQUE,
    mime_type     TEXT NOT NULL,
    size          INTEGER NOT NULL CHECK (size > 0),
    created_at    TEXT NOT NULL
  );

  -- One row per person invited to an election. Only the SHA-256 hash of the voting
  -- token is stored: a database leak does not reveal usable links.
  CREATE TABLE voters (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    election_id       TEXT NOT NULL REFERENCES elections(id) ON DELETE CASCADE,
    email             TEXT NOT NULL,
    name              TEXT NOT NULL,
    birthdate         TEXT NOT NULL,
    gender            TEXT NOT NULL CHECK (gender IN ('male', 'female', 'other')),
    weight            REAL NOT NULL CHECK (weight > 0),
    token_hash        TEXT NOT NULL UNIQUE,
    token_expires_at  TEXT,
    has_voted         INTEGER NOT NULL DEFAULT 0 CHECK (has_voted IN (0, 1)),
    voted_at          TEXT,
    invitation_status TEXT NOT NULL DEFAULT 'pending'
                      CHECK (invitation_status IN ('pending', 'sent', 'simulated', 'failed', 'legacy')),
    invited_at        TEXT,
    created_at        TEXT NOT NULL,
    UNIQUE (election_id, email),
    CHECK ((has_voted = 1) = (voted_at IS NOT NULL))
  );
  CREATE INDEX voters_election ON voters(election_id);

  -- Anonymous weighted ballots (no voter reference, random ids, no timestamps), so a
  -- vote cannot be traced back to a person. 'legacy' rows hold tallies imported from
  -- the former JSON storage, where individual ballots were not kept.
  CREATE TABLE ballots (
    id        TEXT PRIMARY KEY,
    motion_id TEXT NOT NULL REFERENCES motions(id) ON DELETE CASCADE,
    option_id INTEGER NOT NULL,
    weight    REAL NOT NULL CHECK (weight > 0),
    source    TEXT NOT NULL DEFAULT 'vote' CHECK (source IN ('vote', 'legacy')),
    FOREIGN KEY (motion_id, option_id) REFERENCES motion_options(motion_id, id) ON DELETE CASCADE
  ) WITHOUT ROWID;
  CREATE INDEX ballots_motion ON ballots(motion_id, option_id);

  CREATE TABLE surveys (
    id                TEXT PRIMARY KEY,
    title             TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
    initial_recipient TEXT NOT NULL,
    created_by        TEXT,
    created_at        TEXT NOT NULL
  );

  -- current_owner is a single column: a question can never have two responsibles.
  CREATE TABLE survey_questions (
    id                TEXT PRIMARY KEY,
    survey_id         TEXT NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
    position          INTEGER NOT NULL,
    code              TEXT NOT NULL,
    category          TEXT NOT NULL,
    text              TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 1000),
    original_assignee TEXT NOT NULL,
    current_owner     TEXT NOT NULL,
    status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'answered')),
    answer            TEXT,
    answered_by       TEXT,
    answered_at       TEXT,
    UNIQUE (survey_id, position),
    UNIQUE (survey_id, code),
    CHECK ((status = 'answered') = (answer IS NOT NULL))
  );
  CREATE INDEX survey_questions_owner ON survey_questions(current_owner);

  CREATE TABLE survey_delegations (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    question_id  TEXT NOT NULL REFERENCES survey_questions(id) ON DELETE CASCADE,
    from_email   TEXT NOT NULL,
    to_email     TEXT NOT NULL,
    delegated_at TEXT NOT NULL,
    CHECK (from_email <> to_email)
  );
  CREATE INDEX survey_delegations_question ON survey_delegations(question_id);
  CREATE INDEX survey_delegations_to ON survey_delegations(to_email);
  `,
];

/** Applies every migration newer than the database's `user_version`, each in a transaction. */
export function applyMigrations(db: DatabaseSync): void {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  for (let version = row.user_version; version < MIGRATIONS.length; version++) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(MIGRATIONS[version]);
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}

/** Latest schema version known by this build. */
export const SCHEMA_VERSION = MIGRATIONS.length;
