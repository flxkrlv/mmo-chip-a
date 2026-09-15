import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";
import sharp from "sharp";
import request from "supertest";
import { createApp } from "../app.js";
import { ensureDataStore } from "../store.js";
import { readProjectManifest } from "../projectLayout.js";

const tempRoots: string[] = [];
const tempServers: Array<import("node:http").Server> = [];

afterEach(async () => {
  await Promise.all(
    tempServers.map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        })
    )
  );
  tempServers.length = 0;
  // Background tile generation can still hold file handles on Windows; retry the
  // removal a few times before giving up so teardown never masks a real result.
  await Promise.all(tempRoots.splice(0).map((root) => rmWithRetry(root)));
});

async function rmWithRetry(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await fs.rm(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EBUSY" || attempt === 9) {
        return; // best-effort: a leaked temp dir must not fail the run
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

async function createHarness() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "chiptool-folder-"));
  tempRoots.push(dataRoot);
  await ensureDataStore(dataRoot);
  const server = createServer(
    createApp({ dataRoot, tileSize: 128, limitInputPixels: false, tileConcurrency: 2 })
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  tempServers.push(server);
  return { app: server, dataRoot };
}

async function createFolder(prefix: string): Promise<string> {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(folder);
  return folder;
}

async function waitForCompletedJob(app: import("node:http").Server, jobId: string) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const response = await request(app).get(`/api/import-jobs/${jobId}`);
    if (response.body.status === "completed" || response.body.status === "failed") {
      return response.body;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for import job ${jobId}`);
}

function pngBuffer() {
  return sharp({ create: { width: 256, height: 256, channels: 3, background: { r: 10, g: 20, b: 30 } } })
    .png()
    .toBuffer();
}

test("import image into a chosen folder creates a folder project in place", async () => {
  const { app, dataRoot } = await createHarness();
  const target = await createFolder("chip-proj-");

  const response = await request(app)
    .post("/api/dies/import")
    .field("targetFolder", target)
    .attach("file", await pngBuffer(), { filename: "chip.png", contentType: "image/png" });

  assert.equal(response.status, 202);
  const job = await waitForCompletedJob(app, response.body.id);
  assert.equal(job.status, "completed");
  const dieId = job.dieId as string;
  assert.match(dieId, /^folder-/, "folder projects get a folder-* id");

  // The project lives in the user's folder…
  await fs.access(path.join(target, "metadata.json"));
  await fs.access(path.join(target, "project.json"));
  const originalEntries = await fs.readdir(path.join(target, "original"));
  assert.ok(originalEntries.length > 0, "original image moved into the folder");

  // …and NOT in the managed store.
  await assert.rejects(fs.access(path.join(dataRoot, "dies", dieId)));

  // The manifest carries the same identity as the record.
  const manifest = await readProjectManifest(target);
  assert.ok(manifest);
  assert.equal(manifest!.id, dieId);

  // The API reports it as a folder project with the correct path.
  const detail = await request(app).get(`/api/dies/${dieId}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.location, "folder");
  assert.equal(path.resolve(detail.body.folderPath), path.resolve(target));

  // It shows up in the library list.
  const list = await request(app).get("/api/dies");
  assert.ok(list.body.some((die: { id: string }) => die.id === dieId));
});

test("import image into a folder that is already a project fails with 409", async () => {
  const { app } = await createHarness();
  const target = await createFolder("chip-existing-");

  // First import creates the project.
  const first = await request(app)
    .post("/api/dies/import")
    .field("targetFolder", target)
    .attach("file", await pngBuffer(), { filename: "first.png", contentType: "image/png" });
  assert.equal(first.status, 202);
  const firstJob = await waitForCompletedJob(app, first.body.id);
  assert.equal(firstJob.status, "completed");

  // Second import into the same folder must be rejected synchronously.
  const second = await request(app)
    .post("/api/dies/import")
    .field("targetFolder", target)
    .attach("file", await pngBuffer(), { filename: "second.png", contentType: "image/png" });
  assert.equal(second.status, 409);
  assert.equal(second.body.error, "project_exists");
});

test("import image into a non-empty folder fails with 409", async () => {
  const { app } = await createHarness();
  const target = await createFolder("chip-nonempty-");

  // A single unrelated file is enough to make the folder ineligible.
  await fs.writeFile(path.join(target, "notes.txt"), "not a project");

  const response = await request(app)
    .post("/api/dies/import")
    .field("targetFolder", target)
    .attach("file", await pngBuffer(), { filename: "chip.png", contentType: "image/png" });

  assert.equal(response.status, 409);
  assert.equal(response.body.error, "folder_not_empty");

  // The pre-existing file is left untouched (no partial import happened).
  const entries = await fs.readdir(target);
  assert.deepEqual(entries, ["notes.txt"]);
});

test("import image into a non-existent folder fails with 400", async () => {
  const { app } = await createHarness();
  const missing = path.join(os.tmpdir(), `definitely-missing-${Date.now()}`);

  const response = await request(app)
    .post("/api/dies/import")
    .field("targetFolder", missing)
    .attach("file", await pngBuffer(), { filename: "chip.png", contentType: "image/png" });
  assert.equal(response.status, 400);
  assert.equal(response.body.error, "folder_missing");
});
