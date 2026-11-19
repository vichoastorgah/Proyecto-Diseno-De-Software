/**
 * Single-service deployment (Render): configuration defaults, safety checks that prevent
 * data loss on an ephemeral disk, and the API serving the built frontend.
 */
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { loadConfig, productionProblems } from "../config.ts";
import { createTestEnv } from "./testUtils.ts";

Deno.test("deployment: Render's public URL becomes the app URL, vote URL and CORS origin", () => {
  const config = loadConfig({ RENDER: "true", RENDER_EXTERNAL_URL: "https://voting-app.onrender.com/" });
  assertEquals(config.appBaseUrl, "https://voting-app.onrender.com");
  assertEquals(config.voteBaseUrl, "https://voting-app.onrender.com/vote");
  assertEquals(config.allowedOrigins, ["https://voting-app.onrender.com"]);
  assertEquals(config.ephemeralDisk, true);

  const local = loadConfig({});
  assertEquals(local.appBaseUrl, "http://localhost:5173");
  assertEquals(local.ephemeralDisk, false);
});

Deno.test("deployment: refuses to start on an ephemeral disk without persistent storage", () => {
  const missing = productionProblems(loadConfig({ RENDER: "true" }));
  assertEquals(missing.length, 4);
  assert(missing.some((problem) => problem.startsWith("DATABASE_URL")));
  assert(missing.some((problem) => problem.startsWith("SUPABASE_URL")));
  assert(missing.some((problem) => problem.startsWith("GOOGLE_CLIENT_ID")));
  assert(missing.some((problem) => problem.startsWith("ADMIN_EMAILS")));

  const complete = productionProblems(loadConfig({
    RENDER: "true",
    DATABASE_URL: "postgresql://user:pass@host:5432/postgres",
    SUPABASE_URL: "https://proj.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "sb_secret_x",
    GOOGLE_CLIENT_ID: "id",
    ADMIN_EMAILS: "admin@example.com",
  }));
  assertEquals(complete, []);
  assertEquals(productionProblems(loadConfig({})), []); // local development: no requirement
});

Deno.test("deployment: the API serves the frontend, SPA routes and assets without hiding the API", async () => {
  const site = await Deno.makeTempDir({ prefix: "site-" });
  await Deno.mkdir(join(site, "assets"));
  await Deno.writeTextFile(join(site, "index.html"), "<!doctype html><title>app</title>");
  await Deno.writeTextFile(join(site, "assets", "app-123.js"), "console.log(1)");
  await Deno.writeTextFile(join(site, "favicon.svg"), "<svg/>");
  const env = await createTestEnv({ staticDir: site, googleClientId: "public-client-id" });
  try {
    const home = await env.request("GET", "/");
    assertEquals(home.status, 200);
    assert(new TextDecoder().decode(home.raw).includes("<title>app</title>"));
    assertEquals(home.headers.get("cache-control"), "no-cache");
    assertEquals(home.headers.get("referrer-policy"), "strict-origin-when-cross-origin");

    // Client-side routes (reload or link from an email) get index.html.
    for (const path of ["/vote?token=abc", "/admin/elections/123", "/surveys"]) {
      const page = await env.request("GET", path);
      assertEquals(page.status, 200, path);
      assert(new TextDecoder().decode(page.raw).includes("<title>app</title>"), path);
    }

    const asset = await env.request("GET", "/assets/app-123.js");
    assertEquals(asset.status, 200);
    assertEquals(asset.headers.get("cache-control"), "public, max-age=31536000, immutable");
    assertEquals((await env.request("GET", "/favicon.svg")).status, 200);

    // Missing files are real 404s; the API keeps its JSON answers.
    assertEquals((await env.request("GET", "/assets/missing.js")).status, 404);
    const api404 = await env.request("GET", "/api/nothing");
    assertEquals([api404.status, api404.body.code], [404, "NOT_FOUND"]);
    assertEquals((await env.request("GET", "/api/health")).body, { status: "ok" });
    assertEquals((await env.request("GET", "/api/config")).body, { googleClientId: "public-client-id" });

    // Traversal attempts never leave the site folder.
    for (const path of ["/../server.ts", "/%2e%2e/%2e%2e/deno.json", "/assets/../../deno.json"]) {
      const response = await env.request("GET", path);
      assert(!new TextDecoder().decode(response.raw).includes("imports"), path);
    }
  } finally {
    await env.cleanup();
    await Deno.remove(site, { recursive: true });
  }
});

Deno.test("deployment: HSTS only on the hosted deployment", async () => {
  const hosted = await createTestEnv({ ephemeralDisk: true });
  const local = await createTestEnv();
  try {
    const onRender = await hosted.request("GET", "/api/health");
    assertEquals(onRender.headers.get("strict-transport-security"), "max-age=15552000; includeSubDomains");
    assertEquals((await local.request("GET", "/api/health")).headers.get("strict-transport-security"), null);
  } finally {
    await hosted.cleanup();
    await local.cleanup();
  }
});
