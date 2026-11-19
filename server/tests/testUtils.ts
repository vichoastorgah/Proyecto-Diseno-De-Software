/**
 * Shared test harness: an isolated app per test (in-memory SQLite, temporary uploads
 * directory, capturing mailer, fake Google verifier). Requests go through `app.handle()`,
 * so the real routing, middleware and services are exercised without opening a port.
 * All data below is fictitious (example.com addresses).
 */
import type { AppConfig } from "../config.ts";
import { type Db, openDatabase } from "../db/database.ts";
import { createLocalFileStore, type FileStore } from "../services/fileStore.ts";
import { createCapturingMailer } from "../services/emailService.ts";
import { createAuthService, type GoogleTokenVerifier } from "../services/authService.ts";
import { isSurveyParticipant } from "../services/surveyService.ts";
import { createApp } from "../app.ts";

export const ADMIN = "admin@example.com";
export const SESSION_SECRET = "test-secret-test-secret-test-secret-123";

/** Fake Google: `valid:<email>` is a verified account, `unverified:<email>` is not. */
const fakeGoogle: GoogleTokenVerifier = (credential) => {
  const [kind, email] = credential.split(":");
  if (kind === "valid") return Promise.resolve({ email, email_verified: true, name: `User ${email}` });
  if (kind === "unverified") return Promise.resolve({ email, email_verified: false });
  return Promise.reject(new Error("bad signature"));
};

export interface TestEnv {
  app: ReturnType<typeof createApp>;
  db: Db;
  files: FileStore;
  mailer: ReturnType<typeof createCapturingMailer>;
  config: AppConfig;
  auth: ReturnType<typeof createAuthService>;
  tempDir: string;
  sessionFor(email: string, ttlSeconds?: number): Promise<string>;
  request(method: string, path: string, options?: RequestOptions): Promise<TestResponse>;
  cleanup(): Promise<void>;
}

export interface RequestOptions {
  token?: string;
  json?: unknown;
  form?: FormData;
  text?: string;
  headers?: Record<string, string>;
}

export interface TestResponse {
  status: number;
  body: Record<string, unknown>;
  headers: Headers;
  raw: Uint8Array;
}

export async function createTestEnv(overrides: Partial<AppConfig> = {}, failFor: string[] = []): Promise<TestEnv> {
  const tempDir = await Deno.makeTempDir({ prefix: "voting-test-" });
  const config: AppConfig = {
    port: 0,
    allowedOrigins: ["http://localhost:5173"],
    databaseUrl: "",
    databasePath: ":memory:",
    uploadsDir: `${tempDir}/uploads`,
    supabaseUrl: "",
    supabaseServiceKey: "",
    supabaseBucket: "attachments",
    legacyDataDir: `${tempDir}/legacy`,
    googleClientId: "test-client-id",
    sessionSecret: SESSION_SECRET,
    adminEmails: [ADMIN],
    adminDomains: [],
    allowedEmails: [],
    allowedDomains: [],
    demoSurveyIdentity: false,
    voteBaseUrl: "http://localhost:5173/vote",
    appBaseUrl: "http://localhost:5173",
    tokenTtlHours: 48,
    staticDir: "",
    ephemeralDisk: false,
    defaultEmailLanguage: "en",
    ...overrides,
  };
  const db = await openDatabase({ dataDir: config.databasePath });
  const files = createLocalFileStore(config.uploadsDir);
  const mailer = createCapturingMailer(failFor);
  const services = { db, config, mailer, files };
  const auth = createAuthService({
    config,
    isSurveyParticipant: (email) => isSurveyParticipant(services, email),
    verifyGoogleToken: fakeGoogle,
  });
  const app = createApp({ ...services, auth, rateLimitPerMinute: 0 });

  const request = async (method: string, path: string, options: RequestOptions = {}): Promise<TestResponse> => {
    const headers = new Headers(options.headers ?? {});
    if (options.token) headers.set("Authorization", `Bearer ${options.token}`);
    let body: BodyInit | undefined;
    if (options.json !== undefined) {
      body = JSON.stringify(options.json);
      headers.set("Content-Type", "application/json");
    } else if (options.form) {
      // Serialize like a browser does, including Content-Length.
      const encoded = new Response(options.form);
      const bytes = new Uint8Array(await encoded.arrayBuffer());
      headers.set("Content-Type", encoded.headers.get("content-type") ?? "");
      headers.set("Content-Length", String(bytes.byteLength));
      body = bytes;
    } else if (options.text !== undefined) {
      body = options.text;
      headers.set("Content-Type", "text/csv");
      headers.set("Content-Length", String(new TextEncoder().encode(options.text).byteLength));
    }
    const response = await app.handle(new Request(`http://localhost${path}`, { method, headers, body }));
    if (!response) throw new Error("No response");
    const raw = new Uint8Array(await response.arrayBuffer());
    let parsed: Record<string, unknown> = {};
    if ((response.headers.get("content-type") ?? "").includes("json")) {
      parsed = JSON.parse(new TextDecoder().decode(raw));
    }
    return { status: response.status, body: parsed, headers: response.headers, raw };
  };

  return {
    app,
    db,
    files,
    mailer,
    config,
    auth,
    tempDir,
    request,
    async sessionFor(email, ttlSeconds) {
      return (await auth.issueSession({ email, name: email }, ttlSeconds)).token;
    },
    async cleanup() {
      await db.close();
      await Deno.remove(tempDir, { recursive: true }).catch(() => {});
    },
  };
}

export const VALID_CSV = [
  "email,name,birthdate,gender,weight",
  "ana@example.com,Ana Test,1990-04-12,female,2",
  "bruno@example.com,Bruno Test,1985-11-03,male,1",
  "carla@example.com,Carla Test,2000-01-15,other,3",
].join("\n");

/** A tiny but real PDF header, enough for the content check. */
export const PDF_BYTES = new TextEncoder().encode("%PDF-1.4\n% test document\n");

export function csvFile(content: string, name = "voters.csv"): File {
  return new File([content], name, { type: "text/csv" });
}

export interface ElectionFormOptions {
  title?: string;
  description?: string;
  motions?: unknown;
  csv?: string;
  attachments?: File[];
}

export function electionForm(options: ElectionFormOptions = {}): FormData {
  const form = new FormData();
  form.set("title", options.title ?? "Annual assembly 2026");
  form.set("description", options.description ?? "Decisions of the annual assembly.");
  form.set("motions", JSON.stringify(options.motions ?? [
    { title: "Approve the budget", description: "Budget 2026", options: ["approve", "reject", "abstain"] },
    { title: "Elect the board", description: "", options: ["List A", "List B"] },
  ]));
  form.set("votersCsv", csvFile(options.csv ?? VALID_CSV));
  for (const file of options.attachments ?? [new File([PDF_BYTES], "budget.pdf", { type: "application/pdf" })]) {
    form.append("attachments", file);
  }
  form.set("lang", "en");
  return form;
}

/** Extracts the voting token of a recipient from the captured invitation emails. */
export function tokenFromEmail(env: TestEnv, email: string): string {
  const message = [...env.mailer.sent].reverse().find((sent) => sent.to === email && sent.text.includes("?token="));
  const match = message ? /\?token=([A-Za-z0-9-]+)/.exec(message.text) : null;
  if (!match) throw new Error(`No invitation for ${email}`);
  return match[1];
}
