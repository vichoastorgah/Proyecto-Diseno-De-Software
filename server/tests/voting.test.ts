import { assert, assertEquals } from "@std/assert";
import { ADMIN, createTestEnv, electionForm, type TestEnv, tokenFromEmail } from "./testUtils.ts";

interface Ballot {
  election: { id: string; status: string };
  motions: { id: string; title: string; options: string[] }[];
  attachments: { id: string }[];
  voter: { name: string; hasVoted: boolean; isExpired: boolean; tokenExpiresAt: string | null };
}

interface MotionResult {
  id: string;
  options: { label: string; weight: number; votes: number }[];
  totalWeight: number;
  integrity: { ok: boolean; expectedWeight: number; recordedWeight: number };
}

async function setup(env: TestEnv) {
  const adminToken = await env.sessionFor(ADMIN);
  const created = await env.request("POST", "/api/admin/elections", { token: adminToken, form: electionForm() });
  const electionId = created.body.electionId as string;
  const ballotOf = async (email: string) => {
    const token = tokenFromEmail(env, email);
    const response = await env.request("GET", `/api/vote/context?token=${token}`);
    return { token, ballot: response.body as unknown as Ballot };
  };
  return { adminToken, electionId, ballotOf };
}

const choicesFor = (ballot: Ballot, picks: string[]) =>
  Object.fromEntries(ballot.motions.map((motion, index) => [motion.id, picks[index]]));

Deno.test("voting: ballot context, weighted results and integrity", async () => {
  const env = await createTestEnv();
  try {
    const { adminToken, electionId, ballotOf } = await setup(env);

    const ana = await ballotOf("ana@example.com"); // weight 2
    assertEquals(ana.ballot.voter, { name: "Ana Test", hasVoted: false, isExpired: false, tokenExpiresAt: ana.ballot.voter.tokenExpiresAt } as Ballot["voter"]);
    assertEquals(ana.ballot.motions.map((motion) => motion.options.length), [3, 2]);
    assertEquals(ana.ballot.attachments.length, 1);
    assert(!("weight" in ana.ballot.voter), "the weight must not be exposed to the voter");

    const bruno = await ballotOf("bruno@example.com"); // weight 1
    const carla = await ballotOf("carla@example.com"); // weight 3

    for (const [voter, picks] of [[ana, ["approve", "List A"]], [bruno, ["reject", "List A"]], [carla, ["approve", "List B"]]] as const) {
      const response = await env.request("POST", "/api/vote", { json: { token: voter.token, choices: choicesFor(voter.ballot, [...picks]) } });
      assertEquals(response.status, 200);
    }

    // Secret ballot: no tallies while the election is open.
    const open = await env.request("GET", `/api/admin/elections/${electionId}`, { token: adminToken });
    assertEquals(open.body.resultsAvailable, false);
    assert((open.body.motions as MotionResult[]).every((motion) => motion.options.every((option) => option.weight === null)));
    assertEquals((open.body.motions as MotionResult[])[0].integrity.ok, true);

    await env.request("POST", `/api/admin/elections/${electionId}/status`, { token: adminToken, json: { status: "closed" } });
    const detail = await env.request("GET", `/api/admin/elections/${electionId}`, { token: adminToken });
    assertEquals(detail.body.resultsAvailable, true);
    const [budget, board] = detail.body.motions as MotionResult[];
    const weights = (motion: MotionResult) => Object.fromEntries(motion.options.map((option) => [option.label, option.weight]));
    assertEquals(weights(budget), { approve: 5, reject: 1, abstain: 0 });
    assertEquals(weights(board), { "List A": 3, "List B": 3 });
    assertEquals(budget.options.map((option) => option.votes), [2, 1, 0]);
    assertEquals(budget.integrity, { ok: true, expectedWeight: 6, recordedWeight: 6 });
    assertEquals(board.integrity.ok, true);
    assertEquals((detail.body.stats as { participation: number }).participation, 100);

    // Ballots carry no reference to the voter.
    const columns = (await env.db.all<{ name: string }>(
      "SELECT column_name AS name FROM information_schema.columns WHERE table_name = 'ballots'",
    )).map((column) => column.name);
    assertEquals(columns.sort(), ["id", "motion_id", "option_id", "source", "weight"]);
  } finally {
    await env.cleanup();
  }
});

Deno.test("voting: a link can be used only once", async () => {
  const env = await createTestEnv();
  try {
    const { ballotOf } = await setup(env);
    const { token, ballot } = await ballotOf("ana@example.com");
    const choices = choicesFor(ballot, ["approve", "List A"]);
    assertEquals((await env.request("POST", "/api/vote", { json: { token, choices } })).status, 200);

    const again = await env.request("POST", "/api/vote", { json: { token, choices } });
    assertEquals([again.status, again.body.code], [403, "ALREADY_VOTED"]);
    const context = await env.request("GET", `/api/vote/context?token=${token}`);
    assertEquals((context.body.voter as { hasVoted: boolean }).hasVoted, true);
  } finally {
    await env.cleanup();
  }
});

Deno.test("voting: concurrent requests with the same link count once", async () => {
  const env = await createTestEnv();
  try {
    const { electionId, adminToken, ballotOf } = await setup(env);
    const { token, ballot } = await ballotOf("carla@example.com");
    const choices = choicesFor(ballot, ["approve", "List B"]);
    const responses = await Promise.all(
      Array.from({ length: 10 }, () => env.request("POST", "/api/vote", { json: { token, choices } })),
    );
    assertEquals(responses.filter((response) => response.status === 200).length, 1);
    assertEquals(responses.filter((response) => response.body.code === "ALREADY_VOTED").length, 9);
    await env.request("POST", `/api/admin/elections/${electionId}/status`, { token: adminToken, json: { status: "closed" } });
    const detail = await env.request("GET", `/api/admin/elections/${electionId}`, { token: adminToken });
    assertEquals((detail.body.motions as MotionResult[])[0].totalWeight, 3);
  } finally {
    await env.cleanup();
  }
});

Deno.test("voting: invalid links, incomplete ballots and foreign options are rejected", async () => {
  const env = await createTestEnv();
  try {
    const { ballotOf } = await setup(env);
    const { token, ballot } = await ballotOf("ana@example.com");

    for (const bad of ["", "short", "x".repeat(64), "../../etc/passwd"]) {
      const response = await env.request("GET", `/api/vote/context?token=${encodeURIComponent(bad)}`);
      assert([400, 404].includes(response.status), `token "${bad}" must be rejected`);
    }
    const forged = await env.request("POST", "/api/vote", { json: { token: "f".repeat(64), choices: {} } });
    assertEquals([forged.status, forged.body.code], [404, "INVALID_TOKEN"]);

    const incomplete = await env.request("POST", "/api/vote", {
      json: { token, choices: { [ballot.motions[0].id]: "approve" } },
    });
    assertEquals([incomplete.status, incomplete.body.code], [400, "INCOMPLETE_BALLOT"]);

    const wrongOption = await env.request("POST", "/api/vote", {
      json: { token, choices: choicesFor(ballot, ["approve", "List C"]) },
    });
    assertEquals([wrongOption.status, wrongOption.body.code], [400, "INVALID_OPTION"]);

    const foreignMotion = await env.request("POST", "/api/vote", {
      json: { token, choices: { ...choicesFor(ballot, ["approve", "List A"]), "other-motion": "approve" } },
    });
    assertEquals([foreignMotion.status, foreignMotion.body.code], [400, "INVALID_MOTION"]);

    // Nothing was recorded by the rejected attempts.
    assertEquals((await env.db.all("SELECT id FROM ballots")).length, 0);
    assertEquals((await env.request("POST", "/api/vote", { json: { token, choices: choicesFor(ballot, ["approve", "List A"]) } })).status, 200);
  } finally {
    await env.cleanup();
  }
});

Deno.test("voting: expired links and closed elections", async () => {
  const env = await createTestEnv();
  try {
    const { adminToken, electionId, ballotOf } = await setup(env);
    const ana = await ballotOf("ana@example.com");
    const bruno = await ballotOf("bruno@example.com");

    await env.db.run("UPDATE voters SET token_expires_at = $1 WHERE email = $2", "2000-01-01T00:00:00.000Z", "ana@example.com");
    const context = await env.request("GET", `/api/vote/context?token=${ana.token}`);
    assertEquals((context.body.voter as { isExpired: boolean }).isExpired, true);
    const expired = await env.request("POST", "/api/vote", { json: { token: ana.token, choices: choicesFor(ana.ballot, ["approve", "List A"]) } });
    assertEquals([expired.status, expired.body.code], [403, "TOKEN_EXPIRED"]);

    await env.request("POST", `/api/admin/elections/${electionId}/status`, { token: adminToken, json: { status: "closed" } });
    const closed = await env.request("POST", "/api/vote", { json: { token: bruno.token, choices: choicesFor(bruno.ballot, ["approve", "List A"]) } });
    assertEquals([closed.status, closed.body.code], [403, "ELECTION_CLOSED"]);

    await env.request("POST", `/api/admin/elections/${electionId}/status`, { token: adminToken, json: { status: "open" } });
    const reopened = await env.request("POST", "/api/vote", { json: { token: bruno.token, choices: choicesFor(bruno.ballot, ["approve", "List A"]) } });
    assertEquals(reopened.status, 200);
  } finally {
    await env.cleanup();
  }
});

Deno.test("voting: voters can download the documents of their own election only", async () => {
  const env = await createTestEnv();
  try {
    const { adminToken, ballotOf } = await setup(env);
    const ana = await ballotOf("ana@example.com");
    const attachmentId = ana.ballot.attachments[0].id;
    const ok = await env.request("GET", `/api/vote/attachments/${attachmentId}?token=${ana.token}`);
    assertEquals(ok.status, 200);
    assertEquals(ok.headers.get("content-disposition")?.startsWith("attachment;"), true);

    // A voter of another election cannot reach this attachment.
    const other = await env.request("POST", "/api/admin/elections", {
      token: adminToken,
      form: electionForm({ csv: "email,name,birthdate,gender,weight\nzoe@example.com,Zoe,1990-01-01,f,1\n" }),
    });
    assertEquals(other.status, 201);
    const zoe = tokenFromEmail(env, "zoe@example.com");
    assertEquals((await env.request("GET", `/api/vote/attachments/${attachmentId}?token=${zoe}`)).status, 404);
    assertEquals((await env.request("GET", `/api/vote/attachments/${attachmentId}`)).status, 404);
  } finally {
    await env.cleanup();
  }
});
