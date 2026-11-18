/**
 * @module db/legacyImport
 * One-time, read-only migration of the former JSON storage into the database:
 *   motions.json -> elections (+ one motion each, options, legacy tallies, attachment)
 *   voters.json  -> voters (tokens are hashed: links already emailed keep working)
 *   data.json    -> one survey with its questions, answers and delegation history
 *
 * Safety:
 * - The JSON files are only read; they are never modified, moved or deleted.
 * - Everything is imported in ONE transaction: either all data arrives or nothing does.
 * - It runs once (recorded in `meta`) and only on a database without elections/surveys.
 * - Logs contain counts only, never personal data.
 */
import { join } from "@std/path";
import type { Db } from "./database.ts";
import type { FileStore } from "../services/fileStore.ts";
import { hashToken } from "../services/tokenService.ts";
import { normalizeBirthdate, normalizeEmail, normalizeGender } from "../services/csvService.ts";
import { categorizeQuestion } from "../services/surveyService.ts";

const META_KEY = "legacy_json_import";
const DEFAULT_OPTIONS = ["approve", "reject"];

export interface LegacyImportReport {
  status: "imported" | "skipped";
  reason?: string;
  elections: number;
  voters: number;
  legacyTallies: number;
  attachments: number;
  surveys: number;
  questions: number;
  delegations: number;
  warnings: string[];
}

type Json = Record<string, unknown>;

async function readJson(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await Deno.readTextFile(path));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw new Error(`Cannot read legacy file ${path}: ${error instanceof Error ? error.message : error}`);
  }
}

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown, fallback = ""): string => (typeof value === "string" ? value : fallback);
const isoOr = (value: unknown, fallback: string): string => {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isNaN(parsed) ? fallback : new Date(parsed).toISOString();
};

function emptyReport(status: LegacyImportReport["status"], reason?: string): LegacyImportReport {
  return { status, reason, elections: 0, voters: 0, legacyTallies: 0, attachments: 0, surveys: 0, questions: 0, delegations: 0, warnings: [] };
}

/**
 * Imports the legacy JSON files from `dataDir` if it has not been done yet.
 * @param files Store holding the attachments referenced by `motions.json`.
 */
export async function importLegacyData(db: Db, dataDir: string, files: FileStore): Promise<LegacyImportReport> {
  if (await db.get("SELECT value FROM meta WHERE key = $1", META_KEY)) return emptyReport("skipped", "already imported");
  if (await db.get("SELECT 1 FROM elections UNION ALL SELECT 1 FROM surveys LIMIT 1")) {
    return emptyReport("skipped", "database already contains data");
  }

  const [motionsRaw, votersRaw, surveyRaw] = await Promise.all([
    readJson(join(dataDir, "motions.json")),
    readJson(join(dataDir, "voters.json")),
    readJson(join(dataDir, "data.json")),
  ]);
  if (motionsRaw === undefined && votersRaw === undefined && surveyRaw === undefined) {
    return emptyReport("skipped", "no legacy files");
  }

  const report = emptyReport("imported");
  const motions = Array.isArray(motionsRaw) ? motionsRaw : isObject(motionsRaw) && Array.isArray(motionsRaw.motions) ? motionsRaw.motions : [];
  const voters = Array.isArray(votersRaw) ? votersRaw : [];
  const importedAt = new Date().toISOString();

  await db.transaction(async (tx) => {
    // ----- Elections (each legacy motion becomes an election with one motion) -----
    const electionIds = new Set<string>();
    for (const raw of motions) {
      if (!isObject(raw) || text(raw.id) === "") {
        report.warnings.push("A motion without id was skipped.");
        continue;
      }
      const id = text(raw.id);
      const title = text(raw.title).trim().slice(0, 200) || "Untitled motion";
      const description = text(raw.description);
      const createdAt = isoOr(raw.createdAt, importedAt);
      await tx.run(
        "INSERT INTO elections (id, title, description, status, created_by, created_at) VALUES ($1, $2, $3, 'open', NULL, $4)",
        id, title, description, createdAt,
      );
      electionIds.add(id);
      report.elections++;

      const motionId = crypto.randomUUID();
      await tx.run("INSERT INTO motions (id, election_id, position, title, description) VALUES ($1, $2, 1, $3, $4)", motionId, id, title, description);

      const declared = Array.isArray(raw.options) ? raw.options.map((o) => text(o).trim()).filter((o) => o !== "") : [];
      const options = [...new Set(declared.length > 0 ? declared : DEFAULT_OPTIONS)].map((o) => o.slice(0, 60));
      const optionIds = new Map<string, number>();
      for (const [index, label] of options.entries()) {
        const row = await tx.get<{ id: number }>(
          "INSERT INTO motion_options (motion_id, position, label) VALUES ($1, $2, $3) RETURNING id", motionId, index + 1, label,
        );
        optionIds.set(label, Number(row?.id));
      }

      // Former files only kept totals per option: they become anonymous 'legacy' rows.
      const results = isObject(raw.results) ? raw.results : {};
      for (const [label, value] of Object.entries(results)) {
        const weight = Number(value);
        if (!Number.isFinite(weight) || weight <= 0) continue;
        const optionId = optionIds.get(label);
        if (optionId === undefined) {
          report.warnings.push(`Motion ${id}: tally for an unknown option was skipped.`);
          continue;
        }
        await tx.run(
          "INSERT INTO ballots (id, motion_id, option_id, weight, source) VALUES ($1, $2, $3, $4, 'legacy')",
          crypto.randomUUID(), motionId, optionId, weight,
        );
        report.legacyTallies++;
      }

      if (isObject(raw.attachment)) {
        const storedName = text(raw.attachment.storedName);
        if (storedName && await files.exists(storedName)) {
          await tx.run(
            `INSERT INTO attachments (id, election_id, original_name, stored_name, mime_type, size, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            crypto.randomUUID(), id, text(raw.attachment.originalName, storedName).slice(-150),
            storedName, text(raw.attachment.mimeType, "application/octet-stream"),
            Math.max(1, Number(raw.attachment.size) || 1), createdAt,
          );
          report.attachments++;
        } else {
          report.warnings.push(`Motion ${id}: attachment file not found, metadata skipped.`);
        }
      }
    }

    // ----- Voters -----
    const seen = new Set<string>();
    for (const [index, raw] of voters.entries()) {
      const label = `Voter record ${index + 1}`;
      if (!isObject(raw)) {
        report.warnings.push(`${label}: not an object, skipped.`);
        continue;
      }
      const electionId = text(raw.motionId);
      const email = normalizeEmail(text(raw.email));
      const token = text(raw.token);
      const weight = Number(raw.weight);
      if (!electionIds.has(electionId)) {
        report.warnings.push(`${label}: unknown motion, skipped.`);
        continue;
      }
      if (!email || token === "" || !Number.isFinite(weight) || weight <= 0) {
        report.warnings.push(`${label}: incomplete data, skipped.`);
        continue;
      }
      if (seen.has(`${electionId}|${email}`)) {
        report.warnings.push(`${label}: duplicate in the same motion, skipped.`);
        continue;
      }
      seen.add(`${electionId}|${email}`);

      const hasVoted = raw.hasVoted === true;
      await tx.run(
        `INSERT INTO voters (election_id, email, name, birthdate, gender, weight, token_hash, token_expires_at,
                             has_voted, voted_at, invitation_status, invited_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'legacy', NULL, $11)`,
        electionId,
        email,
        text(raw.name).trim().slice(0, 200) || email,
        normalizeBirthdate(text(raw.birthdate)) ?? "1900-01-01",
        normalizeGender(text(raw.gender)) ?? "other",
        weight,
        hashToken(token),
        typeof raw.tokenExpiresAt === "string" ? isoOr(raw.tokenExpiresAt, importedAt) : null,
        hasVoted,
        hasVoted ? importedAt : null,
        isoOr(raw.createdAt, importedAt),
      );
      report.voters++;
    }

    // ----- Survey -----
    if (isObject(surveyRaw) && Array.isArray(surveyRaw.questions)) {
      const recipient = normalizeEmail(text(surveyRaw.initialRecipient));
      if (!recipient) {
        report.warnings.push("Survey without a valid initial recipient, skipped.");
      } else {
        const surveyId = text(surveyRaw.id) || crypto.randomUUID();
        await tx.run(
          "INSERT INTO surveys (id, title, initial_recipient, created_by, created_at) VALUES ($1, $2, $3, NULL, $4)",
          surveyId, text(surveyRaw.title).trim().slice(0, 200) || "Survey", recipient, isoOr(surveyRaw.createdAt, importedAt),
        );
        report.surveys++;

        for (const [index, raw] of surveyRaw.questions.entries()) {
          if (!isObject(raw) || text(raw.text).trim() === "") {
            report.warnings.push(`Question ${index + 1}: skipped.`);
            continue;
          }
          const questionId = crypto.randomUUID();
          const owner = normalizeEmail(text(raw.currentOwner)) ?? recipient;
          const answered = raw.status === "answered" && text(raw.answer).trim() !== "";
          await tx.run(
            `INSERT INTO survey_questions (id, survey_id, position, code, category, text, original_assignee, current_owner,
                                           status, answer, answered_by, answered_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
            questionId, surveyId, index + 1, text(raw.id) || `q-${String(index + 1).padStart(3, "0")}`,
            text(raw.category).trim().toLowerCase() || categorizeQuestion(text(raw.text)),
            text(raw.text).trim().slice(0, 1000),
            normalizeEmail(text(raw.originalAssignee)) ?? recipient, owner,
            answered ? "answered" : "pending", answered ? text(raw.answer) : null,
            answered ? owner : null, answered ? isoOr(raw.answeredAt, importedAt) : null,
          );
          report.questions++;

          for (const entry of Array.isArray(raw.delegationHistory) ? raw.delegationHistory : []) {
            if (!isObject(entry)) continue;
            const from = normalizeEmail(text(entry.from));
            const to = normalizeEmail(text(entry.to));
            if (!from || !to || from === to) continue;
            await tx.run(
              "INSERT INTO survey_delegations (question_id, from_email, to_email, delegated_at) VALUES ($1, $2, $3, $4)",
              questionId, from, to, isoOr(entry.delegatedAt, importedAt),
            );
            report.delegations++;
          }
        }
      }
    }

    await tx.run("INSERT INTO meta (key, value) VALUES ($1, $2)", META_KEY, JSON.stringify({
      importedAt,
      elections: report.elections,
      voters: report.voters,
      surveys: report.surveys,
      questions: report.questions,
    }));
  });

  return report;
}

/** Motions whose recorded ballot weight differs from the weight of the voters who voted. */
export async function findIntegrityIssues(db: Db): Promise<{ electionId: string; motionId: string; expected: number; recorded: number }[]> {
  const rows = await db.all<{ election_id: string; motion_id: string; expected: number; recorded: number }>(
    `SELECT m.election_id, m.id AS motion_id,
            COALESCE((SELECT SUM(weight) FROM voters v WHERE v.election_id = m.election_id AND v.has_voted), 0) AS expected,
            COALESCE((SELECT SUM(weight) FROM ballots b WHERE b.motion_id = m.id), 0) AS recorded
     FROM motions m`,
  );
  return rows
    .filter((row) => Math.abs(Number(row.expected) - Number(row.recorded)) > 1e-6)
    .map((row) => ({ electionId: row.election_id, motionId: row.motion_id, expected: Number(row.expected), recorded: Number(row.recorded) }));
}
