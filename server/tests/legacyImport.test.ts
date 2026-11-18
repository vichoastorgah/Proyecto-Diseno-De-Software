import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { all } from "../db/database.ts";
import { findIntegrityIssues, importLegacyData } from "../db/legacyImport.ts";
import { ADMIN, createTestEnv, PDF_BYTES } from "./testUtils.ts";

/** Fictitious data shaped like the former JSON files. */
async function writeLegacyFiles(dir: string, uploadsDir: string): Promise<void> {
  await Deno.mkdir(dir, { recursive: true });
  await Deno.mkdir(uploadsDir, { recursive: true });
  await Deno.writeFile(join(uploadsDir, "11111111-1111-1111-1111-111111111111-doc.pdf"), PDF_BYTES);
  await Deno.writeTextFile(join(dir, "motions.json"), JSON.stringify([
    {
      id: "11111111-1111-1111-1111-111111111111",
      title: "Legacy motion",
      description: "Imported",
      attachment: { originalName: "doc.pdf", storedName: "11111111-1111-1111-1111-111111111111-doc.pdf", mimeType: "application/pdf", size: 25 },
      options: ["approve", "reject"],
      results: { approve: 2, reject: 0 },
      voterCount: 2,
      createdAt: "2026-11-01T10:00:00.000Z",
    },
  ]));
  await Deno.writeTextFile(join(dir, "voters.json"), JSON.stringify([
    { email: "ana@example.com", name: "Ana", birthdate: "1990-04-12", gender: "female", weight: 2, token: "a".repeat(64), hasVoted: true, motionId: "11111111-1111-1111-1111-111111111111", tokenExpiresAt: "2099-01-01T00:00:00.000Z" },
    { email: "bob@example.com", name: "Bob", birthdate: "1980-01-01", gender: "male", weight: 1, token: "b".repeat(64), hasVoted: false, motionId: "11111111-1111-1111-1111-111111111111" },
    { email: "orphan@example.com", name: "Orphan", birthdate: "1980-01-01", gender: "male", weight: 1, token: "c".repeat(64), hasVoted: false, motionId: "missing" },
  ]));
  await Deno.writeTextFile(join(dir, "data.json"), JSON.stringify({
    id: "survey-legacy",
    title: "Legacy survey",
    initialRecipient: "ceo@example.com",
    createdAt: "2026-10-05T12:00:00.000Z",
    questions: [
      { id: "q-001", category: "finance", text: "Budget?", originalAssignee: "ceo@example.com", currentOwner: "cfo@example.com", status: "answered", answer: "1M", answeredAt: "2026-10-06T00:00:00.000Z", delegationHistory: [{ from: "ceo@example.com", to: "cfo@example.com", delegatedAt: "2026-10-05T13:00:00.000Z" }] },
      { id: "q-002", category: "operations", text: "Incidents?", originalAssignee: "ceo@example.com", currentOwner: "ceo@example.com", status: "pending", answer: null, answeredAt: null, delegationHistory: [] },
    ],
  }));
}

Deno.test("legacy import: JSON data is migrated once, links keep working, files untouched", async () => {
  const env = await createTestEnv();
  try {
    const dir = env.config.legacyDataDir;
    await writeLegacyFiles(dir, env.config.uploadsDir);
    const before = await Promise.all(["motions.json", "voters.json", "data.json"].map((file) => Deno.readTextFile(join(dir, file))));

    const report = await importLegacyData(env.db, dir, env.config.uploadsDir);
    assertEquals([report.status, report.elections, report.voters, report.surveys, report.questions, report.delegations, report.attachments],
      ["imported", 1, 2, 1, 2, 1, 1]);
    assertEquals(report.warnings.length, 1); // the orphan voter
    assertEquals(findIntegrityIssues(env.db), []);

    // Source files are byte-for-byte identical.
    const after = await Promise.all(["motions.json", "voters.json", "data.json"].map((file) => Deno.readTextFile(join(dir, file))));
    assertEquals(after, before);

    // A link emailed before the migration still opens the ballot; a used one stays used.
    const bob = await env.request("GET", `/api/vote/context?token=${"b".repeat(64)}`);
    assertEquals(bob.status, 200);
    assertEquals((bob.body.voter as { hasVoted: boolean; isExpired: boolean }), { name: "Bob", hasVoted: false, isExpired: false, tokenExpiresAt: null } as never);
    const ana = await env.request("GET", `/api/vote/context?token=${"a".repeat(64)}`);
    assertEquals((ana.body.voter as { hasVoted: boolean }).hasVoted, true);

    // Former single-motion body still works, and the tally adds up.
    const vote = await env.request("POST", "/api/vote", {
      json: { token: "b".repeat(64), motionId: "11111111-1111-1111-1111-111111111111", choice: "reject" },
    });
    assertEquals(vote.status, 200);
    const admin = await env.sessionFor(ADMIN);
    const detail = await env.request("GET", "/api/admin/elections/11111111-1111-1111-1111-111111111111", { token: admin });
    const motion = (detail.body.motions as { options: { label: string; weight: number }[]; includesLegacyTally: boolean; integrity: { ok: boolean } }[])[0];
    assertEquals(motion.options.map((option) => [option.label, option.weight]), [["approve", 2], ["reject", 1]]);
    assertEquals(motion.includesLegacyTally, true);
    assertEquals(motion.integrity.ok, true);

    // Survey ownership and history preserved.
    const questions = all<{ code: string; current_owner: string; status: string }>(env.db, "SELECT code, current_owner, status FROM survey_questions ORDER BY position");
    assertEquals(questions, [
      { code: "q-001", current_owner: "cfo@example.com", status: "answered" },
      { code: "q-002", current_owner: "ceo@example.com", status: "pending" },
    ]);

    // Second run does nothing.
    const again = await importLegacyData(env.db, dir, env.config.uploadsDir);
    assertEquals(again.status, "skipped");
    assertEquals(all(env.db, "SELECT id FROM elections").length, 1);
  } finally {
    await env.cleanup();
  }
});

Deno.test("legacy import: no files means nothing to do", async () => {
  const env = await createTestEnv();
  try {
    const report = await importLegacyData(env.db, env.config.legacyDataDir, env.config.uploadsDir);
    assertEquals(report.status, "skipped");
  } finally {
    await env.cleanup();
  }
});
