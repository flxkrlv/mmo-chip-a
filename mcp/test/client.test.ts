import test from "node:test";
import assert from "node:assert/strict";
import { BackendClient, BackendError } from "../src/client.js";
import { loadConfig } from "../src/config.js";
import { jsonResponse, recordingFetch, testConfig } from "./helpers.js";

test("loadConfig reads env vars and falls back to defaults", () => {
  const configured = loadConfig({
    MMO_BASE_URL: "http://localhost:9999/",
    MMO_TOKEN: " s3cret ",
    MMO_AGENT_NAME: "bot",
    MMO_CROPS_DIR: "D:\\crops"
  } as NodeJS.ProcessEnv);
  assert.equal(configured.baseUrl, "http://localhost:9999");
  assert.equal(configured.token, "s3cret");
  assert.equal(configured.agentName, "bot");
  assert.equal(configured.cropsDir, "D:\\crops");

  const defaults = loadConfig({} as NodeJS.ProcessEnv);
  assert.equal(defaults.baseUrl, "http://127.0.0.1:3001");
  assert.equal(defaults.agentName, "mcp-agent");
  assert.equal(defaults.token, undefined);
});

test("getJson resolves a JSON success body and hits the configured base URL", async () => {
  const { impl, requests } = recordingFetch(() => jsonResponse({ id: "die-1" }));
  const client = new BackendClient(testConfig(), impl);
  const body = await client.getJson<{ id: string }>("/api/dies/die-1");
  assert.deepEqual(body, { id: "die-1" });
  assert.equal(requests[0].url, "http://mmo.test:3001/api/dies/die-1");
  assert.equal(requests[0].method, "GET");
  assert.equal(requests[0].headers.authorization, undefined);
});

test("a non-2xx {error} body becomes a readable BackendError", async () => {
  const { impl, requests } = recordingFetch(() => jsonResponse({ error: "Not found" }, 404));
  const client = new BackendClient(testConfig(), impl);
  await assert.rejects(
    () => client.getJson("/api/dies/missing"),
    (error: unknown) => {
      assert.ok(error instanceof BackendError);
      assert.equal(error.status, 404);
      assert.match(error.message, /HTTP 404: Not found/);
      return true;
    }
  );
  assert.equal(requests.length, 1);
});

test("mutations carry a JSON content type and the bearer token", async () => {
  const { impl, requests } = recordingFetch(() => jsonResponse({ ok: true, rev: 3 }));
  const client = new BackendClient(testConfig({ token: "tok-1" }), impl);
  const body = await client.putJson<{ rev: number }>("/api/dies/x/nets/n1", { id: "n1" });
  assert.equal(body.rev, 3);
  assert.equal(requests[0].method, "PUT");
  assert.equal(requests[0].headers.authorization, "Bearer tok-1");
  assert.equal(requests[0].headers["content-type"], "application/json");
  assert.equal(requests[0].body, JSON.stringify({ id: "n1" }));
});

test("an unreachable backend names the base URL", async () => {
  const impl = async (): Promise<Response> => {
    const failure = new Error("fetch failed");
    (failure as { cause?: unknown }).cause = new Error("connect ECONNREFUSED 127.0.0.1:3001");
    throw failure;
  };
  const client = new BackendClient(testConfig(), impl);
  await assert.rejects(
    () => client.getJson("/api/dies"),
    (error: unknown) => {
      assert.ok(error instanceof BackendError);
      assert.equal(error.status, 0);
      assert.match(error.message, /Backend unreachable at http:\/\/mmo\.test:3001/);
      assert.match(error.message, /ECONNREFUSED/);
      return true;
    }
  );
});

test("getRaw returns bytes, content type and the X-Filename header", async () => {
  const { impl } = recordingFetch(
    () =>
      new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 200,
        headers: {
          "content-type": "application/zip",
          "x-filename": "mmochip-demo-light.zip"
        }
      })
  );
  const client = new BackendClient(testConfig(), impl);
  const raw = await client.getRaw("/api/dies/x/export-project");
  assert.deepEqual([...raw.data], [1, 2, 3, 4]);
  assert.equal(raw.contentType, "application/zip");
  assert.equal(raw.filename, "mmochip-demo-light.zip");
});

test("getRaw refuses a JSON body where a file was expected", async () => {
  const { impl } = recordingFetch(() => jsonResponse({ error: "Crop source image not found" }, 200));
  const client = new BackendClient(testConfig(), impl);
  await assert.rejects(
    () => client.getRaw("/api/dies/x/crop?x=0&y=0&w=8&h=8"),
    (error: unknown) => {
      assert.ok(error instanceof BackendError);
      assert.match(error.message, /Crop source image not found/);
      return true;
    }
  );
});
