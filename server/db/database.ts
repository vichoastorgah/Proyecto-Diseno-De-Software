/**
 * @module db/database
 * PostgreSQL access behind a small async interface, with two interchangeable drivers:
 *
 * - **postgres.js** when `DATABASE_URL` is set (production: Supabase Postgres).
 * - **PGlite** otherwise (local development and tests): a real PostgreSQL compiled to
 *   WebAssembly that runs inside the Deno process, persisted in a folder or in memory.
 *
 * Both speak the same SQL dialect, so the tests exercise exactly the queries used in
 * production. Values are normalized the same way by both drivers: BIGINT -> number,
 * TIMESTAMPTZ -> ISO-8601 string, DATE -> "YYYY-MM-DD".
 *
 * Concurrency: every multi-statement change runs in `transaction()`. Row-level guards such
 * as `UPDATE ... WHERE has_voted = false` make concurrent requests safe (Postgres locks the
 * row; the losing transaction sees zero changed rows).
 */
import type { PGlite } from "@electric-sql/pglite";
import postgres from "postgres";
import { applyMigrations } from "./schema.ts";

export type SqlValue = string | number | boolean | null;
export type Row = Record<string, unknown>;

export interface Db {
  /** Every row of a query. Placeholders are `$1, $2, ...`. */
  all<T = Row>(sql: string, ...params: SqlValue[]): Promise<T[]>;
  /** First row of a query, or undefined. */
  get<T = Row>(sql: string, ...params: SqlValue[]): Promise<T | undefined>;
  /** Executes a statement and returns the number of affected rows. */
  run(sql: string, ...params: SqlValue[]): Promise<number>;
  /** Executes one or more statements without parameters (migrations). */
  exec(sql: string): Promise<void>;
  /** Runs `work` in a transaction (commit on success, rollback on error). Nested calls join the outer one. */
  transaction<T>(work: (tx: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  readonly driver: "pglite" | "postgres";
}

const toIso = (value: unknown): string => new Date(value as string).toISOString();

// ---------- PGlite ----------

type PGliteLike = Pick<PGlite, "query" | "exec">;

function wrapPglite(client: PGliteLike, root: PGlite, inTransaction: boolean): Db {
  const db: Db = {
    driver: "pglite",
    async all<T>(sql: string, ...params: SqlValue[]) {
      return (await client.query<T>(sql, params)).rows;
    },
    async get<T>(sql: string, ...params: SqlValue[]) {
      return (await client.query<T>(sql, params)).rows[0];
    },
    async run(sql: string, ...params: SqlValue[]) {
      return (await client.query(sql, params)).affectedRows ?? 0;
    },
    async exec(sql: string) {
      await client.exec(sql);
    },
    transaction<T>(work: (tx: Db) => Promise<T>) {
      if (inTransaction) return work(db);
      return root.transaction((tx) => work(wrapPglite(tx, root, true)));
    },
    async close() {
      if (!inTransaction) await root.close();
    },
  };
  return db;
}

async function openPglite(dataDir: string | undefined): Promise<Db> {
  // Loaded on demand: production (DATABASE_URL) never pays for the WebAssembly engine.
  const { PGlite, types: pgliteTypes } = await import("@electric-sql/pglite");
  if (dataDir) await Deno.mkdir(dataDir, { recursive: true });
  const options = {
    parsers: {
      [pgliteTypes.INT8]: (value: string) => Number(value),
      [pgliteTypes.TIMESTAMPTZ]: toIso,
      [pgliteTypes.TIMESTAMP]: toIso,
      [pgliteTypes.DATE]: (value: string) => value,
    },
  };
  const pg = dataDir ? new PGlite(dataDir, options) : new PGlite(options);
  await pg.waitReady;
  return wrapPglite(pg, pg, false);
}

// ---------- postgres.js (Supabase) ----------

type PostgresClient = ReturnType<typeof postgres>;
type PostgresTx = postgres.TransactionSql;

function wrapPostgres(client: PostgresClient | PostgresTx, root: PostgresClient, inTransaction: boolean): Db {
  const db: Db = {
    driver: "postgres",
    async all<T>(sql: string, ...params: SqlValue[]) {
      return [...await client.unsafe(sql, params as postgres.ParameterOrJSON<never>[])] as T[];
    },
    async get<T>(sql: string, ...params: SqlValue[]) {
      return (await client.unsafe(sql, params as postgres.ParameterOrJSON<never>[]))[0] as T | undefined;
    },
    async run(sql: string, ...params: SqlValue[]) {
      return (await client.unsafe(sql, params as postgres.ParameterOrJSON<never>[])).count;
    },
    async exec(sql: string) {
      await client.unsafe(sql);
    },
    async transaction<T>(work: (tx: Db) => Promise<T>) {
      if (inTransaction) return work(db);
      return await root.begin((tx) => work(wrapPostgres(tx, root, true))) as T;
    },
    async close() {
      if (!inTransaction) await root.end({ timeout: 5 });
    },
  };
  return db;
}

/**
 * Checks the shape of a connection string WITHOUT ever echoing it: the value contains the
 * database password, and driver errors such as "Invalid URL: '<value>'" would leak it to logs.
 */
export function assertConnectionString(url: string): void {
  let parsed: URL | null = null;
  try {
    parsed = new URL(url);
  } catch {
    parsed = null;
  }
  const problems: string[] = [];
  if (!parsed) problems.push("it is not a URL");
  else {
    if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") problems.push("it must start with postgresql://");
    if (!parsed.hostname) problems.push("the host is missing");
    if (!parsed.username) problems.push("the user is missing");
    if (!parsed.password) problems.push("the password is missing");
    if (/[[\]]/.test(decodeURIComponent(parsed.password))) problems.push("the [YOUR-PASSWORD] placeholder was not replaced");
  }
  if (problems.length > 0) {
    throw new Error(
      `DATABASE_URL is invalid (${problems.join("; ")}). Expected the full Supabase connection string: ` +
        "postgresql://<user>:<password>@<host>:<port>/postgres?sslmode=require (value not shown for security).",
    );
  }
}

function openPostgres(url: string): Db {
  assertConnectionString(url);
  const client = postgres(url, {
    max: 5,
    // Supabase's transaction pooler (port 6543) does not support prepared statements.
    prepare: false,
    onnotice: () => {},
    types: {
      bigint: { to: 20, from: [20], serialize: (value: number) => String(value), parse: (value: string) => Number(value) },
      timestamp: { to: 1184, from: [1114, 1184], serialize: (value: string) => value, parse: toIso },
      date: { to: 1082, from: [1082], serialize: (value: string) => value, parse: (value: string) => value },
    },
  });
  return wrapPostgres(client, client, false);
}

// ---------- Entry point ----------

export interface DatabaseOptions {
  /** PostgreSQL connection string (Supabase). When set, PGlite is not used. */
  url?: string;
  /** PGlite data folder, or ":memory:". */
  dataDir?: string;
}

/** Opens the database and applies pending migrations. */
export async function openDatabase(options: DatabaseOptions): Promise<Db> {
  const db = options.url
    ? openPostgres(options.url)
    : await openPglite(options.dataDir && options.dataDir !== ":memory:" ? options.dataDir : undefined);
  await applyMigrations(db);
  return db;
}
