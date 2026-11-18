/**
 * Regression tests for the issues found in the independent review:
 * secret ballot while open, placeholder session secret, participant data leak,
 * unbounded chunked bodies, 405 responses and duplicated submissions.
 */
import { assert, assertEquals } from "@std/assert";
import { SignJWT } from "jose";
import { ADMIN, createTestEnv, electionForm, tokenFromEmail } from "./testUtils.ts";

Deno.test("hardening: voter list exposes no time of vote", async () => {
  const env = await createTestEnv();
  try {
    const admin = await env.sessionFor(ADMIN);
    const created = await env.request("POST", "/api/admin/elections", { token: admin, form: electionForm() });
    const id = created.body.electionId as string;
    const token = tokenFromEmail(env, "ana@example.com");
    const ballot = (await env.request("GET", `/api/vote/context?token=${token}`)).body as { motions: { id: string; options: string[] }[] };
    const choices = Object.fromEntries(ballot.motions.map((motion) => [motion.id, motion.options[0]]));
    assertEquals((await env.request("POST", "/api/vote", { json: { token, choices } })).status, 200);

    const voters = await env.request("GET", `/api/admin/elections/${id}/voters?status=voted`, { token: admin });
    const [ana] = voters.body.items as Record<string, unknown>[];
    assertEquals(ana.hasVoted, true);
    assert(!("votedAt" in ana), "the time of vote must not be exposed");
  } finally {
    await env.cleanup();
  }
});

Deno.test("hardening: a session signed with the example secret is rejected", async () => {
  const placeholder = "change-me-to-a-long-random-value";
  const env = await createTestEnv({ sessionSecret: placeholder });
  try {
    const forged = await new SignJWT({ name: "Mallory" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(ADMIN)
      .setIssuer("voting-survey-system")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(placeholder));
    const response = await env.request("GET", "/api/admin/elections", { token: forged });
    assertEquals(response.status, 401);
  } finally {
    await env.cleanup();
  }
});

Deno.test("hardening: participants do not receive the per-person or per-category breakdown", async () => {
  const env = await createTestEnv();
  try {
    const admin = await env.sessionFor(ADMIN);
    const created = await env.request("POST", "/api/surveys", {
      token: admin,
      json: { title: "S", initialRecipient: "ceo@example.com", questions: ["Budget?", "Recycling?", "Hiring?"] },
    });
    const survey = created.body.survey as { id: string; questions: { id: string }[] };
    const ceo = await env.sessionFor("ceo@example.com");
    await env.request("POST", `/api/surveys/${survey.id}/delegate`, {
      token: ceo, json: { questionIds: [survey.questions[0].id], newOwnerEmail: "cfo@example.com" },
    });

    const cfo = await env.sessionFor("cfo@example.com");
    const view = (await env.request("GET", `/api/surveys/${survey.id}`, { token: cfo })).body as {
      progress: { totalQuestions: number; byCategory: object; pendingByOwner: object };
    };
    assertEquals(view.progress.totalQuestions, 3);
    assertEquals(view.progress.byCategory, {});
    assertEquals(view.progress.pendingByOwner, {});

    const recipientView = (await env.request("GET", `/api/surveys/${survey.id}`, { token: ceo })).body as {
      progress: { pendingByOwner: Record<string, number> };
    };
    assertEquals(recipientView.progress.pendingByOwner, { "cfo@example.com": 1, "ceo@example.com": 2 });
  } finally {
    await env.cleanup();
  }
});

Deno.test("hardening: chunked bodies without Content-Length are cut at the limit", async () => {
  const env = await createTestEnv();
  try {
    const chunk = new TextEncoder().encode("x".repeat(64 * 1024));
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= 5 * 1024 * 1024) return controller.close();
        sent += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    const response = await env.app.handle(new Request("http://localhost/api/vote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    }));
    assertEquals(response?.status, 413);
    assert(sent < 5 * 1024 * 1024, "the server stopped reading before the end of the stream");
  } finally {
    await env.cleanup();
  }
});

Deno.test("hardening: wrong method is 405, unknown route is 404", async () => {
  const env = await createTestEnv();
  try {
    const wrongMethod = await env.request("GET", "/api/vote");
    assertEquals([wrongMethod.status, wrongMethod.body.code], [405, "METHOD_NOT_ALLOWED"]);
    const unknown = await env.request("GET", "/api/does-not-exist");
    assertEquals([unknown.status, unknown.body.code], [404, "NOT_FOUND"]);
  } finally {
    await env.cleanup();
  }
});

Deno.test("hardening: a retried submission with the same requestId creates and mails nothing new", async () => {
  const env = await createTestEnv();
  try {
    const admin = await env.sessionFor(ADMIN);
    const first = electionForm();
    first.set("requestId", "retry-key-1");
    const created = await env.request("POST", "/api/admin/elections", { token: admin, form: first });
    assertEquals(created.status, 201);
    const mailsAfterFirst = env.mailer.sent.length;

    const retry = electionForm();
    retry.set("requestId", "retry-key-1");
    const again = await env.request("POST", "/api/admin/elections", { token: admin, form: retry });
    assertEquals([again.status, again.body.duplicate, again.body.electionId], [200, true, created.body.electionId]);
    assertEquals(env.mailer.sent.length, mailsAfterFirst);
    assertEquals((await env.db.all("SELECT id FROM elections")).length, 1);
  } finally {
    await env.cleanup();
  }
});
