/**
 * @module http/helpers
 * Request parsing and authorization helpers shared by the route modules.
 * Every helper throws {@link AppError}; the error middleware turns it into JSON.
 */
import type { Context } from "@oak/oak";
import { AppError } from "../errors.ts";
import type { ServiceContext } from "../context.ts";
import type { AuthService, SessionUser } from "../services/authService.ts";
import type { EmailLanguage } from "../services/emailService.ts";

/** Everything a route module needs. */
export interface AppDeps extends ServiceContext {
  auth: AuthService;
  /** Requests per minute and IP on public endpoints (0 disables the limiter). */
  rateLimitPerMinute: number;
}

const DEFAULT_JSON_LIMIT = 256 * 1024;

function declaredLength(ctx: Context): number | null {
  const header = ctx.request.headers.get("content-length");
  if (header === null) return null;
  const value = Number(header);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function tooLarge(): AppError {
  return new AppError(413, "PAYLOAD_TOO_LARGE", "Payload too large.");
}

/**
 * Reads the body as text, never buffering more than `maxBytes`: the stream is consumed
 * chunk by chunk and cancelled as soon as the limit is exceeded (chunked uploads without
 * Content-Length cannot exhaust memory).
 */
export async function readLimitedText(ctx: Context, maxBytes: number): Promise<string> {
  const length = declaredLength(ctx);
  if (length !== null && length > maxBytes) throw tooLarge();
  const stream = ctx.request.body.stream;
  if (!stream) return "";
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw tooLarge();
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(400, "INVALID_BODY", "Unable to read the request body.");
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** Reads a JSON object body (size-limited). */
export async function readJsonBody(ctx: Context, maxBytes = DEFAULT_JSON_LIMIT): Promise<Record<string, unknown>> {
  const text = await readLimitedText(ctx, maxBytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AppError(400, "INVALID_JSON", "The request body must be valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new AppError(400, "INVALID_JSON", "The request body must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

/** Reads a multipart body. The Content-Length header is required so the size is known first. */
export async function readFormData(ctx: Context, maxBytes: number): Promise<FormData> {
  const contentType = ctx.request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
    throw new AppError(415, "UNSUPPORTED_MEDIA_TYPE", "Content-Type must be multipart/form-data.");
  }
  const length = declaredLength(ctx);
  if (length === null) throw new AppError(411, "LENGTH_REQUIRED", "Content-Length is required.");
  if (length > maxBytes) throw tooLarge();
  try {
    return await ctx.request.body.formData();
  } catch {
    throw new AppError(400, "INVALID_BODY", "Unable to read the multipart form data.");
  }
}

/** Returns the files of a multipart field (empty file inputs are ignored). */
export function filesOf(form: FormData, field: string): File[] {
  return form.getAll(field).filter((value): value is File => value instanceof File && value.name !== "" && value.size > 0);
}

/** Returns a text field of a multipart body ("" when missing). */
export function textOf(form: FormData, field: string): string {
  const value = form.get(field);
  return typeof value === "string" ? value : "";
}

/** Requires a valid session. */
export async function requireUser(ctx: Context, deps: AppDeps): Promise<SessionUser> {
  const user = await deps.auth.getSessionUser(ctx.request.headers.get("authorization"));
  if (!user) throw new AppError(401, "UNAUTHENTICATED", "Authentication required.");
  return user;
}

/** Requires a valid session with the admin role. */
export async function requireAdmin(ctx: Context, deps: AppDeps): Promise<SessionUser> {
  const user = await requireUser(ctx, deps);
  if (!user.isAdmin) throw new AppError(403, "FORBIDDEN", "Administrator role required.");
  return user;
}

/** Email language from `?lang=` or the body, defaulting to the configured language. */
export function emailLanguage(deps: AppDeps, value: unknown): EmailLanguage {
  return value === "es" || value === "en" ? value : deps.config.defaultEmailLanguage;
}

/** Sends file bytes as a download (type derived from the extension, never sniffed). */
export function sendDownload(ctx: Context, bytes: Uint8Array, name: string, mimeType: string): void {
  const asciiName = name.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
  ctx.response.headers.set("Content-Type", mimeType);
  ctx.response.headers.set(
    "Content-Disposition",
    `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(name)}`,
  );
  ctx.response.body = bytes;
}

/** Parses a positive integer route parameter. */
export function intParam(value: string | undefined, code: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new AppError(404, code, "Not found.");
  return parsed;
}
