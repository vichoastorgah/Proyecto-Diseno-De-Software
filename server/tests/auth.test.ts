import { assertEquals } from "@std/assert";
import { ADMIN, createTestEnv } from "./testUtils.ts";

Deno.test("auth: Google sign-in issues a session with the right role", async () => {
  const env = await createTestEnv({ allowedEmails: ["member@example.com"] });
  try {
    const admin = await env.request("POST", "/api/auth/google", { json: { credential: `valid:${ADMIN}` } });
    assertEquals(admin.status, 200);
    assertEquals((admin.body.user as { isAdmin: boolean }).isAdmin, true);

    const member = await env.request("POST", "/api/auth/google", { json: { credential: "valid:member@example.com" } });
    assertEquals(member.status, 200);
    assertEquals((member.body.user as { isAdmin: boolean }).isAdmin, false);

    const me = await env.request("GET", "/api/auth/me", { token: member.body.token as string });
    assertEquals((me.body.user as { email: string }).email, "member@example.com");
  } finally {
    await env.cleanup();
  }
});

Deno.test("auth: invalid, unverified and unauthorized accounts are rejected", async () => {
  const env = await createTestEnv();
  try {
    assertEquals((await env.request("POST", "/api/auth/google", { json: {} })).status, 400);
    const bad = await env.request("POST", "/api/auth/google", { json: { credential: "forged" } });
    assertEquals([bad.status, bad.body.code], [401, "INVALID_CREDENTIAL"]);
    const unverified = await env.request("POST", "/api/auth/google", { json: { credential: `unverified:${ADMIN}` } });
    assertEquals(unverified.status, 401);
    const stranger = await env.request("POST", "/api/auth/google", { json: { credential: "valid:stranger@example.com" } });
    assertEquals([stranger.status, stranger.body.code], [403, "UNAUTHORIZED_USER"]);
  } finally {
    await env.cleanup();
  }
});

Deno.test("auth: SSO not configured", async () => {
  const env = await createTestEnv({ googleClientId: "" });
  try {
    const response = await env.request("POST", "/api/auth/google", { json: { credential: `valid:${ADMIN}` } });
    assertEquals([response.status, response.body.code], [500, "SSO_NOT_CONFIGURED"]);
  } finally {
    await env.cleanup();
  }
});

Deno.test("auth: protected routes reject missing, tampered and expired sessions", async () => {
  const env = await createTestEnv();
  try {
    assertEquals((await env.request("GET", "/api/admin/elections")).status, 401);

    const token = await env.sessionFor(ADMIN);
    const tampered = token.slice(0, -2) + (token.endsWith("A") ? "BB" : "AA");
    assertEquals((await env.request("GET", "/api/admin/elections", { token: tampered })).status, 401);

    const expired = await env.sessionFor(ADMIN, -60);
    const response = await env.request("GET", "/api/admin/elections", { token: expired });
    assertEquals([response.status, response.body.code], [401, "UNAUTHENTICATED"]);

    assertEquals((await env.request("GET", "/api/admin/elections", { token })).status, 200);
  } finally {
    await env.cleanup();
  }
});

Deno.test("auth: a participant cannot reach admin routes", async () => {
  const env = await createTestEnv({ allowedEmails: ["member@example.com"] });
  try {
    const token = await env.sessionFor("member@example.com");
    for (const path of ["/api/admin/elections", "/api/admin/summary"]) {
      const response = await env.request("GET", path, { token });
      assertEquals([response.status, response.body.code], [403, "FORBIDDEN"]);
    }
    const create = await env.request("POST", "/api/surveys", { token, json: { title: "x", initialRecipient: "a@example.com", questions: ["q"] } });
    assertEquals(create.status, 403);
  } finally {
    await env.cleanup();
  }
});

Deno.test("http: CORS, security headers, unknown routes and invalid JSON", async () => {
  const env = await createTestEnv();
  try {
    const allowed = await env.request("GET", "/api/health", { headers: { Origin: "http://localhost:5173" } });
    assertEquals(allowed.headers.get("access-control-allow-origin"), "http://localhost:5173");
    assertEquals(allowed.headers.get("x-content-type-options"), "nosniff");

    const other = await env.request("GET", "/api/health", { headers: { Origin: "https://evil.example" } });
    assertEquals(other.headers.get("access-control-allow-origin"), null);

    assertEquals((await env.request("GET", "/api/nothing")).status, 404);

    const response = await env.app.handle(new Request("http://localhost/api/vote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    }));
    assertEquals(response?.status, 400);
  } finally {
    await env.cleanup();
  }
});
