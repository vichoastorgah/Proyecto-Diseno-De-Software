import { assertEquals } from "@std/assert";
import { normalizeBirthdate, normalizeGender, parseVotersCsv } from "../services/csvService.ts";

const TODAY = new Date("2026-11-18T00:00:00Z");
const codes = (text: string) => parseVotersCsv(text, TODAY).errors.map((error) => error.code);

Deno.test("csv: valid file with BOM, CRLF and quoted fields", () => {
  const result = parseVotersCsv(
    '﻿email,name,birthdate,gender,weight\r\n"ANA@Example.com","Test, Ana",1990-04-12,F,2.5\r\n',
    TODAY,
  );
  assertEquals(result.errors, []);
  assertEquals(result.rows, [{ email: "ana@example.com", name: "Test, Ana", birthdate: "1990-04-12", gender: "female", weight: 2.5 }]);
});

Deno.test("csv: semicolon delimiter, Spanish headers, day-first dates and decimal comma", () => {
  const result = parseVotersCsv("correo;nombre;fecha_nacimiento;género;ponderación\nana@example.com;Ana;12-04-1990;Mujer;1,5\n", TODAY);
  assertEquals(result.errors, []);
  assertEquals(result.rows[0], { email: "ana@example.com", name: "Ana", birthdate: "1990-04-12", gender: "female", weight: 1.5 });
});

Deno.test("csv: columns in any order and extra columns ignored", () => {
  const result = parseVotersCsv("weight,notes,gender,name,email,birthdate\n3,private,male,Bruno,bruno@example.com,1985-11-03\n", TODAY);
  assertEquals(result.errors, []);
  assertEquals(Object.keys(result.rows[0]).sort(), ["birthdate", "email", "gender", "name", "weight"]);
});

Deno.test("csv: empty file, missing columns and no rows", () => {
  assertEquals(codes(""), ["CSV_EMPTY"]);
  assertEquals(codes("email,name\nana@example.com,Ana\n"), ["CSV_MISSING_COLUMNS"]);
  assertEquals(codes("email,name,birthdate,gender,weight\n"), ["CSV_NO_ROWS"]);
  assertEquals(codes('email,name,birthdate,gender,weight\n"ana@example.com,Ana'), ["CSV_UNTERMINATED_QUOTE"]);
});

Deno.test("csv: incomplete and malformed rows are reported per row and field", () => {
  const result = parseVotersCsv(
    [
      "email,name,birthdate,gender,weight",
      "not-an-email,Ana,1990-04-12,female,1",
      "bruno@example.com,,1985-11-03,male,1",
      "carla@example.com,Carla,2099-01-01,female,1",
      "dario@example.com,Dario,1990-02-30,male,1",
      "eva@example.com,Eva,1990-01-01,unknown,1",
      "fede@example.com,Fede,1990-01-01,male,0",
      "gabi@example.com,Gabi,1990-01-01,male,abc",
      "hugo@example.com,Hugo,1990-01-01,male,1,extra",
    ].join("\n"),
    TODAY,
  );
  assertEquals(result.rows, []);
  assertEquals(result.errors.map((error) => [error.row, error.code]), [
    [2, "CSV_INVALID_EMAIL"],
    [3, "CSV_INVALID_NAME"],
    [4, "CSV_INVALID_BIRTHDATE"],
    [5, "CSV_INVALID_BIRTHDATE"],
    [6, "CSV_INVALID_GENDER"],
    [7, "CSV_INVALID_WEIGHT"],
    [8, "CSV_INVALID_WEIGHT"],
    [9, "CSV_TOO_MANY_FIELDS"],
  ]);
});

Deno.test("csv: duplicate emails (case-insensitive) are detected", () => {
  const result = parseVotersCsv(
    "email,name,birthdate,gender,weight\nana@example.com,Ana,1990-01-01,f,1\nANA@example.com,Ana 2,1990-01-01,f,1\n",
    TODAY,
  );
  assertEquals(result.errors.map((error) => [error.row, error.code, error.value]), [[3, "CSV_DUPLICATE_EMAIL", "ana@example.com"]]);
});

Deno.test("csv: invalid rows stay invalid after the error report cap is reached", () => {
  const lines = ["email,name,birthdate,gender,weight"];
  for (let i = 0; i < 150; i++) lines.push(`bad${i},Name,1990-01-01,male,1`);
  lines.push("good@example.com,Good,1990-01-01,male,1");
  const result = parseVotersCsv(lines.join("\n"), TODAY);
  assertEquals(result.errors.length, 100);
  assertEquals(result.rows.map((row) => row.email), ["good@example.com"]);
});

Deno.test("csv: normalizers", () => {
  assertEquals(normalizeGender("Masculino"), "male");
  assertEquals(normalizeGender("no binario"), "other");
  assertEquals(normalizeGender("robot"), null);
  assertEquals(normalizeBirthdate("5/3/1990", TODAY), "1990-03-05");
  assertEquals(normalizeBirthdate("1899-12-31", TODAY), null);
});
