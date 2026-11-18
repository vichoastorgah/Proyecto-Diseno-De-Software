/**
 * Supabase Storage adapter, tested against a recording fake `fetch` (no network):
 * request shapes, authentication headers for new and legacy keys, error handling and
 * rejection of unsafe names. The local store is covered by the election tests.
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import { createSupabaseFileStore } from "../services/fileStore.ts";

interface Recorded {
  method: string;
  url: string;
  headers: Headers;
  body: string | null;
}

function fakeFetch(responses: Record<string, Response | (() => Response)>) {
  const calls: Recorded[] = [];
  const fn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    calls.push({
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: request.body ? await request.text() : null,
    });
    const key = `${request.method} ${new URL(request.url).pathname}`;
    const response = responses[key];
    if (!response) return new Response("not found", { status: 404 });
    return typeof response === "function" ? response() : response.clone();
  };
  return { fn: fn as typeof fetch, calls };
}

const NEW_KEY = "sb_secret_testkey1234567890";
const LEGACY_KEY = "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.c2lnbmF0dXJl";

Deno.test("fileStore: upload, download, exists and remove use the Storage REST API", async () => {
  const { fn, calls } = fakeFetch({
    "POST /storage/v1/object/attachments/abc.pdf": new Response("{}", { status: 200 }),
    "GET /storage/v1/object/attachments/abc.pdf": () => new Response("%PDF-1.4"),
    "HEAD /storage/v1/object/attachments/abc.pdf": () => new Response(null, { status: 200 }),
    "DELETE /storage/v1/object/attachments": () => new Response("[]"),
  });
  const store = createSupabaseFileStore({ url: "https://proj.supabase.co/", serviceKey: NEW_KEY, bucket: "attachments", fetchFn: fn });

  await store.put("abc.pdf", new TextEncoder().encode("%PDF-1.4"), "application/pdf");
  assertEquals(new TextDecoder().decode((await store.get("abc.pdf"))!), "%PDF-1.4");
  assertEquals(await store.exists("abc.pdf"), true);
  assertEquals(await store.get("missing.pdf"), null);
  await store.remove(["abc.pdf", "../escape"]);

  const [upload] = calls;
  assertEquals(upload.method, "POST");
  assertEquals(upload.url, "https://proj.supabase.co/storage/v1/object/attachments/abc.pdf");
  assertEquals(upload.headers.get("x-upsert"), "false");
  const remove = calls.find((call) => call.method === "DELETE")!;
  assertEquals(JSON.parse(remove.body!), { prefixes: ["abc.pdf"] }); // unsafe name dropped
});

Deno.test("fileStore: new secret keys go only in apikey; legacy JWT keys also as Bearer", async () => {
  for (const [key, expectBearer] of [[NEW_KEY, false], [LEGACY_KEY, true]] as const) {
    const { fn, calls } = fakeFetch({ "GET /storage/v1/object/b/x.pdf": () => new Response("x") });
    const store = createSupabaseFileStore({ url: "https://proj.supabase.co", serviceKey: key, bucket: "b", fetchFn: fn });
    await store.get("x.pdf");
    assertEquals(calls[0].headers.get("apikey"), key);
    assertEquals(calls[0].headers.get("authorization"), expectBearer ? `Bearer ${key}` : null);
  }
});

Deno.test("fileStore: failed uploads throw and unsafe names never reach the network", async () => {
  const { fn, calls } = fakeFetch({ "POST /storage/v1/object/b/a.pdf": () => new Response("denied", { status: 403 }) });
  const store = createSupabaseFileStore({ url: "https://proj.supabase.co", serviceKey: NEW_KEY, bucket: "b", fetchFn: fn });
  await assertRejects(() => store.put("a.pdf", new Uint8Array([1]), "application/pdf"));
  await assertRejects(() => store.put("../a.pdf", new Uint8Array([1]), "application/pdf"));
  assertEquals(await store.get("../../etc/passwd"), null);
  assert(calls.every((call) => !call.url.includes("..")));
});
