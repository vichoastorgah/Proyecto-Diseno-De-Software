/**
 * @module services/csvService
 * Parsing and validation of the voters CSV (`email,name,birthdate,gender,weight`).
 *
 * Accepted input (pure function, never throws on bad data):
 * - Comma or semicolon delimiter (spreadsheets with a Spanish locale export `;`).
 * - UTF-8 with or without BOM, CRLF or LF, RFC 4180 quoting.
 * - Columns in any order; Spanish header aliases (correo, nombre, fecha_nacimiento,
 *   genero, ponderacion...). Extra columns are ignored and never stored.
 * - Birthdate as `YYYY-MM-DD`, or day-first `DD-MM-YYYY` / `DD/MM/YYYY`.
 * - Gender in English or Spanish (male/female/other, masculino/femenino/otro, m/f/h...).
 * - Weight > 0; a decimal comma is accepted when the delimiter is `;`.
 *
 * Every problem is reported with a stable `code` the client can translate.
 */
import type { ErrorDetail } from "../errors.ts";

export type Gender = "male" | "female" | "other";

/** A validated voter row. */
export interface VoterRow {
  email: string;
  name: string;
  /** ISO date `YYYY-MM-DD`. */
  birthdate: string;
  gender: Gender;
  weight: number;
}

export interface CsvParseResult {
  rows: VoterRow[];
  /** Problems found (capped at {@link MAX_REPORTED_ERRORS}). `rows` is usable only if empty. */
  errors: ErrorDetail[];
  /** Total number of data records read (valid or not). */
  totalRecords: number;
}

export const REQUIRED_COLUMNS = ["email", "name", "birthdate", "gender", "weight"] as const;
type Column = (typeof REQUIRED_COLUMNS)[number];

export const MAX_CSV_ROWS = 10_000;
export const MAX_WEIGHT = 1_000_000;
const MAX_REPORTED_ERRORS = 100;
const MAX_EMAIL_LENGTH = 254;
const MAX_NAME_LENGTH = 200;
const EMAIL_PATTERN = /^[^\s@,;<>"()[\]]+@[^\s@,;<>"()[\]]+\.[^\s@,;<>"()[\]]+$/;
// deno-lint-ignore no-control-regex
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g;

/** Header aliases (normalized: lower-case, no accents, spaces/dashes as underscores). */
const HEADER_ALIASES: Record<string, Column> = {
  email: "email",
  e_mail: "email",
  mail: "email",
  correo: "email",
  correo_electronico: "email",
  name: "name",
  full_name: "name",
  nombre: "name",
  nombre_completo: "name",
  birthdate: "birthdate",
  birth_date: "birthdate",
  date_of_birth: "birthdate",
  fecha_nacimiento: "birthdate",
  fecha_de_nacimiento: "birthdate",
  nacimiento: "birthdate",
  gender: "gender",
  sex: "gender",
  genero: "gender",
  sexo: "gender",
  weight: "weight",
  vote_weight: "weight",
  ponderacion: "weight",
  ponderacion_de_voto: "weight",
  peso: "weight",
};

const GENDER_ALIASES: Record<string, Gender> = {
  male: "male",
  m: "male",
  man: "male",
  masculino: "male",
  hombre: "male",
  h: "male",
  female: "female",
  f: "female",
  woman: "female",
  femenino: "female",
  mujer: "female",
  other: "other",
  o: "other",
  x: "other",
  "non-binary": "other",
  nonbinary: "other",
  otro: "other",
  otra: "other",
  "no binario": "other",
  "no-binario": "other",
};

function stripAccents(value: string): string {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

function normalizeHeader(value: string): string {
  return stripAccents(value.trim().toLowerCase()).replace(/[\s-]+/g, "_");
}

/** Picks `;` when the first line has semicolons and no commas outside quotes. */
function detectDelimiter(text: string): "," | ";" {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const unquoted = firstLine.replace(/"[^"]*"/g, "");
  return unquoted.includes(";") && !unquoted.includes(",") ? ";" : ",";
}

/**
 * Splits CSV text into records (RFC 4180 subset). Blank lines are skipped.
 * @returns The records, or null when a quoted field is never closed.
 */
function splitRecords(text: string, delimiter: string): string[][] | null {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let inQuotes = false;

  const endRecord = (): void => {
    record.push(field);
    if (record.some((cell) => cell.trim() !== "")) records.push(record);
    record = [];
    field = "";
  };

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
    } else if (char === '"' && field.trim() === "") {
      field = "";
      inQuotes = true;
    } else if (char === delimiter) {
      record.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      endRecord();
    } else {
      field += char;
    }
  }

  if (inQuotes) return null;
  if (field !== "" || record.length > 0) endRecord();
  return records;
}

/** Converts a supported date format to ISO `YYYY-MM-DD`; null when invalid or in the future. */
export function normalizeBirthdate(raw: string, today: Date = new Date()): string | null {
  let year: string, month: string, day: string;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(raw);
  const dayFirst = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(raw);
  if (iso) [, year, month, day] = iso;
  else if (dayFirst) [, day, month, year] = dayFirst;
  else return null;

  const value = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) return null;
  if (date.getUTCFullYear() < 1900 || date.getTime() > today.getTime()) return null;
  return value;
}

/** Maps English/Spanish gender labels to the stored value; null when unknown. */
export function normalizeGender(raw: string): Gender | null {
  return GENDER_ALIASES[stripAccents(raw.trim().toLowerCase())] ?? null;
}

function parseWeight(raw: string, delimiter: string): number {
  const text = delimiter === ";" && /^\d+,\d+$/.test(raw) ? raw.replace(",", ".") : raw;
  if (!/^\d+(\.\d+)?$/.test(text)) return Number.NaN;
  return Number(text);
}

/** Lower-cases and validates an email address; null when invalid. */
export function normalizeEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  return email.length <= MAX_EMAIL_LENGTH && EMAIL_PATTERN.test(email) ? email : null;
}

/**
 * Parses and validates a voters CSV.
 *
 * @param text Raw file content.
 * @param today Injectable clock (birthdates in the future are rejected).
 */
export function parseVotersCsv(text: string, today: Date = new Date()): CsvParseResult {
  const errors: ErrorDetail[] = [];
  const rows: VoterRow[] = [];
  const fail = (detail: ErrorDetail): void => {
    if (errors.length < MAX_REPORTED_ERRORS) errors.push(detail);
  };

  const source = text.replace(/^﻿/, "");
  if (source.trim() === "") {
    fail({ code: "CSV_EMPTY", message: "The CSV file is empty." });
    return { rows, errors, totalRecords: 0 };
  }

  const delimiter = detectDelimiter(source);
  const records = splitRecords(source, delimiter);
  if (records === null) {
    fail({ code: "CSV_UNTERMINATED_QUOTE", message: "A quoted field is never closed." });
    return { rows, errors, totalRecords: 0 };
  }

  // Header: map every required column to its index.
  const header = records[0].map(normalizeHeader);
  const columnIndex = new Map<Column, number>();
  header.forEach((name, index) => {
    const column = HEADER_ALIASES[name];
    if (!column) return;
    if (columnIndex.has(column)) {
      fail({ code: "CSV_DUPLICATE_COLUMN", message: `Column "${column}" appears twice.`, row: 1, field: column });
    } else {
      columnIndex.set(column, index);
    }
  });
  const missing = REQUIRED_COLUMNS.filter((column) => !columnIndex.has(column));
  if (missing.length > 0) {
    fail({
      code: "CSV_MISSING_COLUMNS",
      message: `Missing required column(s): ${missing.join(", ")}.`,
      row: 1,
      value: missing.join(", "),
    });
  }
  if (errors.length > 0) return { rows, errors, totalRecords: Math.max(0, records.length - 1) };

  const dataRecords = records.slice(1);
  if (dataRecords.length === 0) {
    fail({ code: "CSV_NO_ROWS", message: "The CSV file has no voter records." });
    return { rows, errors, totalRecords: 0 };
  }
  if (dataRecords.length > MAX_CSV_ROWS) {
    fail({
      code: "CSV_TOO_MANY_ROWS",
      message: `A maximum of ${MAX_CSV_ROWS} voters is allowed per file.`,
      value: String(MAX_CSV_ROWS),
    });
    return { rows, errors, totalRecords: dataRecords.length };
  }

  const firstRowOfEmail = new Map<string, number>();

  dataRecords.forEach((cells, index) => {
    const row = index + 2; // The header is row 1.
    const cell = (column: Column): string =>
      (cells[columnIndex.get(column) as number] ?? "").replace(CONTROL_CHARS, "").trim();
    // `valid` is tracked locally: `errors` stops growing once the report cap is reached.
    let valid = true;
    const rowFail = (detail: ErrorDetail): void => {
      valid = false;
      fail(detail);
    };

    if (cells.length > header.length) {
      fail({ code: "CSV_TOO_MANY_FIELDS", message: "The row has more fields than the header.", row });
      return;
    }

    const email = normalizeEmail(cell("email"));
    if (email === null) {
      rowFail({ code: "CSV_INVALID_EMAIL", message: "Invalid email address.", row, field: "email" });
    } else if (firstRowOfEmail.has(email)) {
      rowFail({
        code: "CSV_DUPLICATE_EMAIL",
        message: `Duplicate email (first seen on row ${firstRowOfEmail.get(email)}).`,
        row,
        field: "email",
        value: email,
      });
    }

    const name = cell("name").replace(/\s+/g, " ");
    if (name === "" || name.length > MAX_NAME_LENGTH) {
      rowFail({
        code: "CSV_INVALID_NAME",
        message: `Name is required (max. ${MAX_NAME_LENGTH} characters).`,
        row,
        field: "name",
      });
    }

    const birthdate = normalizeBirthdate(cell("birthdate"), today);
    if (birthdate === null) {
      rowFail({
        code: "CSV_INVALID_BIRTHDATE",
        message: "Birthdate must be a real past date (YYYY-MM-DD or DD-MM-YYYY).",
        row,
        field: "birthdate",
      });
    }

    const gender = normalizeGender(cell("gender"));
    if (gender === null) {
      rowFail({
        code: "CSV_INVALID_GENDER",
        message: "Gender must be male, female or other.",
        row,
        field: "gender",
      });
    }

    const weight = parseWeight(cell("weight"), delimiter);
    if (!Number.isFinite(weight) || weight <= 0 || weight > MAX_WEIGHT) {
      rowFail({
        code: "CSV_INVALID_WEIGHT",
        message: `Weight must be a number greater than 0 and at most ${MAX_WEIGHT}.`,
        row,
        field: "weight",
      });
    }

    if (email !== null && !firstRowOfEmail.has(email)) firstRowOfEmail.set(email, row);
    if (valid && email && birthdate && gender) {
      rows.push({ email, name, birthdate, gender, weight });
    }
  });

  return { rows, errors, totalRecords: dataRecords.length };
}
