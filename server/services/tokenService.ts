/**
 * @module services/tokenService
 * Voting tokens: 256-bit random values sent only by email. The database stores their
 * SHA-256 hash, so stored data alone can never be turned into a working voting link.
 */
import { createHash, randomBytes } from "node:crypto";

/** Generates a cryptographically secure token (64 hex characters). */
export function generateToken(): string {
  return randomBytes(32).toString("hex");
}

/** Hashes a token for storage and lookup. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** True when the value has the shape of a token (cheap rejection before any lookup). */
export function isWellFormedToken(value: unknown): value is string {
  return typeof value === "string" && value.length >= 16 && value.length <= 128 &&
    /^[A-Za-z0-9-]+$/.test(value);
}
