/**
 * @module db/database
 * SQLite access through Deno's built-in `node:sqlite` module (no extra dependency).
 *
 * The driver is synchronous. A transaction body is a synchronous function, so no other
 * request can interleave between BEGIN and COMMIT on this single connection: async work
 * (hashing, file I/O, email) must happen before or after `transaction()`.
 */
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { dirname } from "jsr:@std/path@^1";
import { applyMigrations } from "./schema.ts";

export type Database = DatabaseSync;
export type SqlValue = SQLInputValue;
export type Row = Record<string, unknown>;

/** Opens (and creates if needed) the database, enables constraints and applies migrations. */
export function openDatabase(path: string): Database {
  if (path !== ":memory:") Deno.mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  if (path !== ":memory:") {
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA synchronous = NORMAL;");
  }
  applyMigrations(db);
  return db;
}

const activeTransactions = new WeakSet<Database>();

/**
 * Runs `work` inside `BEGIN IMMEDIATE ... COMMIT`, rolling back on any error.
 * Nested calls join the outer transaction.
 */
export function transaction<T>(db: Database, work: () => T): T {
  if (activeTransactions.has(db)) return work();

  db.exec("BEGIN IMMEDIATE");
  activeTransactions.add(db);
  try {
    const result = work();
    if (result instanceof Promise) {
      throw new Error("transaction() bodies must be synchronous.");
    }
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    activeTransactions.delete(db);
  }
}

/** Returns every row of a query. */
export function all<T = Row>(db: Database, sql: string, ...params: SqlValue[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}

/** Returns the first row of a query, or undefined. */
export function get<T = Row>(db: Database, sql: string, ...params: SqlValue[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}

/** Executes a statement and returns the number of changed rows. */
export function run(db: Database, sql: string, ...params: SqlValue[]): number {
  return Number(db.prepare(sql).run(...params).changes);
}
