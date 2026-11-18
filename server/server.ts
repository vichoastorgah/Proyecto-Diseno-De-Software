/**
 * @module server
 * Entry point. Run from the repository root so `.env` is found:
 *   deno task dev     (watch mode)
 *   deno task start
 *
 * Startup: configuration -> SQLite (migrations) -> one-time import of the former JSON
 * files (read-only) -> mailer -> auth -> HTTP app.
 */
import "@std/dotenv/load";
import { loadConfig } from "./config.ts";
import { openDatabase } from "./db/database.ts";
import { findIntegrityIssues, importLegacyData } from "./db/legacyImport.ts";
import { createMailer } from "./services/emailService.ts";
import { createAuthService } from "./services/authService.ts";
import { isSurveyParticipant } from "./services/surveyService.ts";
import { createApp } from "./app.ts";

const config = loadConfig();
const db = openDatabase(config.databasePath);
const mailer = createMailer();
const services = { db, config, mailer };

const report = await importLegacyData(db, config.legacyDataDir, config.uploadsDir);
if (report.status === "imported") {
  console.log(
    `[migration] Imported legacy JSON data: ${report.elections} election(s), ${report.voters} voter(s), ` +
      `${report.surveys} survey(s), ${report.questions} question(s). The JSON files were not modified.`,
  );
  for (const warning of report.warnings) console.warn(`[migration] ${warning}`);
}
for (const issue of findIntegrityIssues(db)) {
  console.warn(
    `[integrity] Election ${issue.electionId}: recorded weight ${issue.recorded} differs from the ` +
      `weight of voters who voted (${issue.expected}).`,
  );
}

const auth = createAuthService({ config, isSurveyParticipant: (email) => isSurveyParticipant(services, email) });
const app = createApp({ ...services, auth, rateLimitPerMinute: 120 });

console.log(`[email] Delivery mode: ${mailer.mode}.`);
console.log(`Server listening on http://localhost:${config.port}`);
await app.listen({ port: config.port });
