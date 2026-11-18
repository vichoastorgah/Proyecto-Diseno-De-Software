/**
 * @module services/attachmentService
 * Validation and storage of the documents attached to an election.
 *
 * Defenses:
 * - Allow-list of document/image extensions (anything else is rejected).
 * - Content sniffing: the first bytes must match the extension (a renamed executable
 *   is rejected), plain-text formats must not contain NUL bytes.
 * - Files are stored as `<uuid>.<ext>`: no user-controlled text reaches the file system,
 *   which rules out path traversal and keeps personal data out of file names.
 * - Reads resolve names inside the uploads directory only.
 */
import { join, resolve, SEPARATOR } from "jsr:@std/path@^1";
import { AppError } from "../errors.ts";

export const MAX_ATTACHMENTS = 5;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_TOTAL_ATTACHMENT_BYTES = 10 * 1024 * 1024;

type Sniffer = (bytes: Uint8Array) => boolean;

const startsWith = (signature: number[]): Sniffer => (bytes) =>
  signature.every((byte, index) => bytes[index] === byte);
const ZIP = startsWith([0x50, 0x4b, 0x03, 0x04]); // docx, xlsx, pptx, odt, ods, odp
const OLE = startsWith([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]); // doc, xls, ppt
const TEXT: Sniffer = (bytes) => !bytes.subarray(0, 8192).includes(0);

const ALLOWED_TYPES: Record<string, { mime: string; sniff: Sniffer }> = {
  ".pdf": { mime: "application/pdf", sniff: startsWith([0x25, 0x50, 0x44, 0x46]) },
  ".doc": { mime: "application/msword", sniff: OLE },
  ".docx": {
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    sniff: ZIP,
  },
  ".xls": { mime: "application/vnd.ms-excel", sniff: OLE },
  ".xlsx": { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", sniff: ZIP },
  ".ppt": { mime: "application/vnd.ms-powerpoint", sniff: OLE },
  ".pptx": {
    mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    sniff: ZIP,
  },
  ".odt": { mime: "application/vnd.oasis.opendocument.text", sniff: ZIP },
  ".ods": { mime: "application/vnd.oasis.opendocument.spreadsheet", sniff: ZIP },
  ".odp": { mime: "application/vnd.oasis.opendocument.presentation", sniff: ZIP },
  ".txt": { mime: "text/plain; charset=utf-8", sniff: TEXT },
  ".csv": { mime: "text/csv; charset=utf-8", sniff: TEXT },
  ".rtf": { mime: "application/rtf", sniff: startsWith([0x7b, 0x5c, 0x72, 0x74, 0x66]) },
  ".png": { mime: "image/png", sniff: startsWith([0x89, 0x50, 0x4e, 0x47]) },
  ".jpg": { mime: "image/jpeg", sniff: startsWith([0xff, 0xd8, 0xff]) },
  ".jpeg": { mime: "image/jpeg", sniff: startsWith([0xff, 0xd8, 0xff]) },
  ".webp": { mime: "image/webp", sniff: (b) => startsWith([0x52, 0x49, 0x46, 0x46])(b) && b[8] === 0x57 },
};

/** Extensions accepted for attachments (shown to the client). */
export const ALLOWED_EXTENSIONS = Object.keys(ALLOWED_TYPES);

/** A validated attachment ready to be written. */
export interface PreparedAttachment {
  originalName: string;
  extension: string;
  mimeType: string;
  bytes: Uint8Array;
}

function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot === -1 ? "" : fileName.slice(dot).toLowerCase();
}

/** Keeps only the base name, without control characters, at most 150 characters. */
export function sanitizeDisplayName(rawName: string): string {
  // deno-lint-ignore no-control-regex
  const base = (rawName.split(/[\\/]/).pop() ?? "").replace(/[\u0000-\u001F\u007F"]/g, "").trim();
  return base.slice(-150) || "attachment";
}

/** MIME type to serve for a stored file (derived from the extension, never from the client). */
export function mimeTypeFor(fileName: string): string {
  return ALLOWED_TYPES[extensionOf(fileName)]?.mime ?? "application/octet-stream";
}

/**
 * Validates the uploaded files and loads their content.
 * @throws {AppError} 400 ATTACHMENT_* / 413 ATTACHMENT_TOO_LARGE.
 */
export async function prepareAttachments(files: readonly File[]): Promise<PreparedAttachment[]> {
  if (files.length > MAX_ATTACHMENTS) {
    throw new AppError(400, "ATTACHMENT_TOO_MANY", `At most ${MAX_ATTACHMENTS} attachments are allowed.`);
  }
  const total = files.reduce((sum, file) => sum + file.size, 0);
  if (total > MAX_TOTAL_ATTACHMENT_BYTES) {
    throw new AppError(413, "ATTACHMENT_TOO_LARGE", "Attachments exceed the 10 MB limit.");
  }

  const prepared: PreparedAttachment[] = [];
  for (const file of files) {
    const originalName = sanitizeDisplayName(file.name);
    const extension = extensionOf(originalName);
    const type = ALLOWED_TYPES[extension];
    if (!type) {
      throw new AppError(400, "ATTACHMENT_TYPE_NOT_ALLOWED", `File type not allowed: ${originalName}.`, [
        { code: "ATTACHMENT_TYPE_NOT_ALLOWED", message: originalName, value: originalName },
      ]);
    }
    if (file.size === 0) {
      throw new AppError(400, "ATTACHMENT_EMPTY", `The file is empty: ${originalName}.`);
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      throw new AppError(413, "ATTACHMENT_TOO_LARGE", "Attachments exceed the 10 MB limit.");
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!type.sniff(bytes)) {
      throw new AppError(
        400,
        "ATTACHMENT_CONTENT_MISMATCH",
        `The content of ${originalName} does not match its extension.`,
        [{ code: "ATTACHMENT_CONTENT_MISMATCH", message: originalName, value: originalName }],
      );
    }
    prepared.push({ originalName, extension, mimeType: type.mime, bytes });
  }
  return prepared;
}

/** Writes a prepared attachment and returns the generated stored name. */
export async function writeAttachment(uploadsDir: string, attachment: PreparedAttachment): Promise<string> {
  await Deno.mkdir(uploadsDir, { recursive: true });
  const storedName = `${crypto.randomUUID()}${attachment.extension}`;
  await Deno.writeFile(join(uploadsDir, storedName), attachment.bytes, { createNew: true });
  return storedName;
}

/**
 * Resolves a stored name to an absolute path inside `uploadsDir`.
 * @returns The path, or null when the name is unsafe.
 */
export function resolveStoredPath(uploadsDir: string, storedName: string): string | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,250}$/.test(storedName) || storedName.includes("..")) return null;
  const root = resolve(uploadsDir);
  const path = resolve(root, storedName);
  return path.startsWith(root + SEPARATOR) ? path : null;
}

/** Deletes files, ignoring the ones that do not exist (used to roll back failed writes). */
export async function removeStoredFiles(uploadsDir: string, storedNames: readonly string[]): Promise<void> {
  for (const name of storedNames) {
    const path = resolveStoredPath(uploadsDir, name);
    if (!path) continue;
    try {
      await Deno.remove(path);
    } catch {
      // Already gone.
    }
  }
}
