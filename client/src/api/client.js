import { API_BASE_URL } from "../config";

/**
 * Error thrown for every failed API call.
 * `code` is the stable server code (or "NETWORK"); `details` are structured problems
 * such as CSV rows. The UI translates both (see utils/errors.js).
 */
export class ApiError extends Error {
  /**
   * @param {number} status   HTTP status (0 for network failures).
   * @param {string} code     Stable error code.
   * @param {string} message  Server message (English, used only as a fallback).
   * @param {Array<{code: string, message: string, row?: number, field?: string, value?: string}>} [details]
   */
  constructor(status, code, message, details = []) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/**
 * Performs a request against the API.
 *
 * @param {string} path - Path starting with `/api/`.
 * @param {object} [options]
 * @param {string} [options.method]
 * @param {unknown} [options.json] - Sent as JSON.
 * @param {FormData} [options.form] - Sent as multipart (the browser sets the boundary).
 * @param {string} [options.token] - Session token (Authorization: Bearer).
 * @param {string} [options.actAs] - Demo impersonation header (admins only, demo mode).
 * @param {AbortSignal} [options.signal]
 * @param {"json"|"blob"} [options.responseType]
 * @returns {Promise<any>} Parsed JSON body, or `{ blob, fileName }` for downloads.
 */
export async function apiRequest(path, options = {}) {
  const { method = "GET", json, form, token, actAs, signal, responseType = "json" } = options;
  const headers = {};
  let body;
  if (json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(json);
  } else if (form) {
    body = form;
  }
  if (token) headers.Authorization = `Bearer ${token}`;
  if (actAs) headers["X-Act-As"] = actAs;

  let response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, { method, headers, body, signal });
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    throw new ApiError(0, "NETWORK", "Network error");
  }

  if (!response.ok) {
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    throw new ApiError(
      response.status,
      typeof payload?.code === "string" ? payload.code : `HTTP_${response.status}`,
      typeof payload?.error === "string" ? payload.error : "",
      Array.isArray(payload?.details) ? payload.details : []
    );
  }

  if (responseType === "blob") {
    const disposition = response.headers.get("content-disposition") || "";
    const match = /filename\*=UTF-8''([^;]+)/i.exec(disposition) || /filename="([^"]+)"/i.exec(disposition);
    return { blob: await response.blob(), fileName: match ? decodeURIComponent(match[1]) : "download" };
  }
  if (response.status === 204) return null;
  return response.json();
}

/** Saves a blob through a temporary link (works on desktop and mobile browsers). */
export function saveBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Builds a public URL of the API (used for voter downloads, which carry the link token). */
export function apiUrl(path) {
  return `${API_BASE_URL}${path}`;
}
