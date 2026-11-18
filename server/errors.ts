/**
 * @module errors
 * Single error type shared by every service. The HTTP layer turns it into
 * `{ error, code, details? }` with the given status; the client translates `code`.
 */

/** Structured validation problem (e.g. one CSV row). `code` is translatable by the client. */
export interface ErrorDetail {
  code: string;
  message: string;
  /** 1-based CSV row number (the header is row 1), when the problem belongs to a row. */
  row?: number;
  field?: string;
  value?: string;
}

export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: ErrorDetail[];

  constructor(status: number, code: string, message: string, details?: ErrorDetail[]) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** Shorthand for a 400 validation error. */
export function validationError(message: string, details?: ErrorDetail[]): AppError {
  return new AppError(400, "VALIDATION_ERROR", message, details);
}

/** Shorthand for a 404 error with a specific code. */
export function notFound(code: string, message: string): AppError {
  return new AppError(404, code, message);
}
