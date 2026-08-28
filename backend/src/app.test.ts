import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";
import sharp from "sharp";
import request from "supertest";
import { createApp } from "./app.js";
import { ensureDataStore } from "./store.js";

const tempRoots: string[] = [];
const tempServers: Array<import("node:http").Server> = [];

afterEach(async () => {
  await Promise.all(
    tempServers.map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        })
    )
  );
  tempServers.length = 0;
  await Promise.all(tempRoots.map((root) => fs.rm(root, { recursive: true, force: true })));
  tempRoots.length = 0;
});

test("imports an image and exposes list/detail/tile endpoints", async () => {
  const { app, dataRoot } = await createHarness();

  const imageBuffer = await sharp({
    create: {
      width: 512,
      height: 256,
      channels: 3,
      background: { r: 200, g: 120, b: 80 }
    }
  })
    .png()
    .toBuffer();

  const importResponse = await request(app)
    .post("/api/dies/import")
    .attach("file", imageBuffer, {
      filename: "test-die.png",
      contentType: "image/png"
    });
  assert.equal(importResponse.status, 202);
  assert.equal(importResponse.body.originalFilename, "test-die.png");

  const completedJob = await waitForCompletedJob(app, importResponse.body.id);
  assert.equal(completedJob.status, "completed");
  assert.ok(completedJob.dieId);
  await waitForTilePrebuild(app, completedJob.dieId);

  const listResponse = await request(app).get("/api/dies");
  assert.equal(listResponse.status, 200);
  assert.equal(listResponse.body.length, 1);

  const detailResponse = await request(app).get(`/api/dies/${completedJob.dieId}`);
  assert.equal(detailResponse.status, 200);
  assert.ok(detailResponse.body.levels.length > 0);
  assert.equal(detailResponse.body.tileFormat, "jpg");
  const tileResponse = await request(app).get(
    `/api/dies/${completedJob.dieId}/tiles/${detailResponse.body.maxZoomLevel}/0/0`
  );
  assert.equal(tileResponse.status, 200);
  assert.match(tileResponse.headers["content-type"] ?? "", /image\/jpeg/);
  const lazyTilePath = path.join(
    dataRoot,
    "dies",
    completedJob.dieId,
    "tiles",
    String(detailResponse.body.maxZoomLevel),
    "0_0.jpg"
  );
  await fs.access(lazyTilePath);
});

test("rejects unsupported file types", async () => {
  const { app } = await createHarness();

  const response = await request(app)
    .post("/api/dies/import")
    .attach("file", Buffer.from("hello"), {
      filename: "notes.txt",
      contentType: "text/plain"
    });
  assert.equal(response.status, 202);
  const failedJob = await waitForCompletedJob(app, response.body.id);
  assert.equal(failedJob.status, "failed");
  assert.match(failedJob.error, /PNG and JPEG/);
});

test("deletes a die and its stored data", async () => {
  const { app, dataRoot } = await createHarness();

  const imageBuffer = await sharp({
    create: {
      width: 256,
      height: 256,
      channels: 3,
      background: { r: 40, g: 80, b: 160 }
    }
  })
    .png()
    .toBuffer();

  const importResponse = await request(app)
    .post("/api/dies/import")
    .attach("file", imageBuffer, {
      filename: "delete-me.png",
      contentType: "image/png"
    });
  assert.equal(importResponse.status, 202);

  const completedJob = await waitForCompletedJob(app, importResponse.body.id);
  assert.equal(completedJob.status, "completed");
  assert.ok(completedJob.dieId);

  const tileResponse = await request(app).get(`/api/dies/${completedJob.dieId}/tiles/0/0/0`);
  assert.equal(tileResponse.status, 200);

  const dieDir = path.join(dataRoot, "dies", completedJob.dieId);
  await fs.access(dieDir);

  const deleteResponse = await request(app).delete(`/api/dies/${completedJob.dieId}`);
  assert.equal(deleteResponse.status, 200);
  assert.deepEqual(deleteResponse.body, { ok: true });

  const listResponse = await request(app).get("/api/dies");
  assert.equal(listResponse.status, 200);
  assert.equal(listResponse.body.length, 0);

  const detailResponse = await request(app).get(`/api/dies/${completedJob.dieId}`);
  assert.equal(detailResponse.status, 404);

  await assert.rejects(fs.access(dieDir));
});

test("analyses a supplied circuit snapshot without changing annotations", async () => {
  const { app } = await createHarness();
  const imageBuffer = await sharp({ create: { width: 32, height: 32, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toBuffer();
  const imported = await request(app).post("/api/dies/import").attach("file", imageBuffer, { filename: "assistant.png", contentType: "image/png" });
  const job = await waitForCompletedJob(app, imported.body.id);
  const before = await request(app).get(`/api/dies/${job.dieId}/annotations`);
  const circuit = {
    devices: [
      { uuid: "mref", instanceName: "MREF", kind: "mos", modelName: "pmos", geometry: { W_um: 10, L_um: 1, fingers: 1, multiplier: 1, totalW_um: 10, mosType: "pmos" }, terminals: [{ name: "D", netId: 1 }, { name: "G", netId: 1 }, { name: "S", netId: 2 }, { name: "B", netId: 2 }] },
      { uuid: "mout", instanceName: "MOUT", kind: "mos", modelName: "pmos", geometry: { W_um: 10, L_um: 1, fingers: 1, multiplier: 1, totalW_um: 10, mosType: "pmos" }, terminals: [{ name: "D", netId: 3 }, { name: "G", netId: 1 }, { name: "S", netId: 2 }, { name: "B", netId: 2 }] },
    ],
    namedNets: [{ id: 1, name: "NREF" }, { id: 2, name: "VDD" }, { id: 3, name: "OUT" }],
  };
  const analysed = await request(app)
    .post(`/api/dies/${job.dieId}/assistant/analyze`)
    .send({ expectedRev: before.body.rev, scope: "die", circuit, brief: { prompt: "Find current mirrors" } });
  assert.equal(analysed.status, 200);
  assert.equal(analysed.body.ok, true);
  assert.equal(analysed.body.data.readOnly, true);
  assert.ok(analysed.body.data.findings.some((finding: { kind: string }) => finding.kind === "current_mirror"));
  const after = await request(app).get(`/api/dies/${job.dieId}/annotations`);
  assert.equal(after.body.rev, before.body.rev);
});

async function createHarness() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "chiptool-test-"));
  tempRoots.push(dataRoot);
  await ensureDataStore(dataRoot);
  const server = createServer(
    createApp({
      dataRoot,
      tileSize: 128,
      limitInputPixels: false,
      tileConcurrency: 2
    })
  );
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  tempServers.push(server);
  return { app: server, dataRoot };
}

async function waitForTilePrebuild(app: import("node:http").Server, dieId: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await request(app).get(`/api/dies/${dieId}`);
    const progress = response.body.tileProgress;
    if (progress && progress.completedTiles === progress.totalTiles) {
      return progress;
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error(`Timed out waiting for tile prebuild for ${dieId}`);
}

async function waitForCompletedJob(

  app: import("node:http").Server,
  jobId: string
) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await request(app).get(`/api/import-jobs/${jobId}`);
    if (response.body.status === "completed" || response.body.status === "failed") {
      return response.body;
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error(`Timed out waiting for import job ${jobId}`);
}
