import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";
import sharp from "sharp";
import request from "supertest";
import type { CellDetectionResult, DieAnnotations, MLPrediction } from "shared";
import { createApp } from "../app.js";
import { ensureDataStore } from "../store.js";

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
  await Promise.all(tempRoots.map((root) => fs.rm(root, { recursive: true, force: true })));
  tempRoots.length = 0;
});

async function createHarness() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "chiptool-celldet-"));
  tempRoots.push(dataRoot);
  await ensureDataStore(dataRoot);
  const server = createServer(
    createApp({
      dataRoot,
      tileSize: 128,
      limitInputPixels: false,
      tileConcurrency: 2,
      // Nothing listens here — detection must work with the sidecar down.
      mlSidecarUrl: "http://127.0.0.1:1",
      mlPredictPad: 8
    })
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  tempServers.push(server);
  return { app: server, dataRoot };
}

async function importDie(app: import("node:http").Server): Promise<string> {
  const png = await sharp({
    create: { width: 512, height: 256, channels: 3, background: { r: 40, g: 40, b: 40 } }
  })
    .png()
    .toBuffer();
  const res = await request(app)
    .post("/api/dies/import")
    .attach("file", png, { filename: "die.png", contentType: "image/png" });
  assert.equal(res.status, 202);
  for (let i = 0; i < 300; i++) {
    const job = await request(app).get(`/api/import-jobs/${res.body.id}`);
    if (job.body.status === "completed") return job.body.dieId as string;
    if (job.body.status === "failed") throw new Error(job.body.error);
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("import timed out");
}

const W = 60;
const H = 80;
const PATTERN = [
  { x: 6, y: 8 },
  { x: 30, y: 10 },
  { x: 52, y: 18 },
  { x: 12, y: 40 },
  { x: 44, y: 50 },
  { x: 8, y: 72 },
  { x: 50, y: 74 }
];

test("cell-detection job proposes placements from cached vias; dismiss/clear endpoints", async () => {
  const { app, dataRoot } = await createHarness();
  const dieId = await importDie(app);
  const die = (await request(app).get(`/api/dies/${dieId}`)).body as {
    maxZoomLevel: number;
    tileSize: number;
    levels: { z: number; columns: number; rows: number }[];
  };
  const z = die.maxZoomLevel;
  const level = die.levels.find((l) => l.z === z)!;

  // One placed member at (40, 40); an unlabelled copy at (300, 60), and a
  // horizontally mirrored copy at (120, 150).
  const annotations: DieAnnotations = {
    version: 2,
    rev: 7,
    nets: [],
    grids: [],
    cellTypes: [{ id: "ct1", name: "NAND2", cropRect: { x: 0, y: 0, width: W, height: H } }],
    cells: [{ id: "c1", cellTypeId: "ct1", x: 40, y: 40 }]
  };
  await fs.writeFile(
    path.join(dataRoot, "dies", dieId, "annotations.json"),
    JSON.stringify(annotations)
  );

  const vias: { x: number; y: number; score: number }[] = [];
  for (const p of PATTERN) vias.push({ x: 40 + p.x, y: 40 + p.y, score: 0.9 });
  for (const p of PATTERN) vias.push({ x: 300 + p.x, y: 60 + p.y, score: 0.8 });
  for (const p of PATTERN) vias.push({ x: 120 + (W - p.x), y: 150 + p.y, score: 0.7 });
  // Stray noise.
  vias.push({ x: 450, y: 200, score: 0.5 }, { x: 470, y: 30, score: 0.5 });

  // Fake a completed via sweep at "nohash" (sidecar down → persisted job →
  // null hash). Every native tile gets a file so coverage is complete.
  const cacheDir = path.join(dataRoot, "predictions", dieId, "nohash");
  await fs.mkdir(cacheDir, { recursive: true });
  for (let ty = 0; ty < level.rows; ty++) {
    for (let tx = 0; tx < level.columns; tx++) {
      const x0 = tx * die.tileSize;
      const y0 = ty * die.tileSize;
      const x1 = x0 + die.tileSize;
      const y1 = y0 + die.tileSize;
      const pred: MLPrediction = {
        pointVias: vias.filter((v) => v.x >= x0 && v.x < x1 && v.y >= y0 && v.y < y1),
        irregularVias: [],
        traces: [],
        bbox: [x0, y0, x1, y1],
        checkpointHash: null
      };
      await fs.writeFile(path.join(cacheDir, `${z}_${tx}_${ty}.json`), JSON.stringify(pred));
    }
  }

  // No job yet.
  assert.equal((await request(app).get(`/api/dies/${dieId}/cell-detections/job`)).body, null);
  assert.deepEqual((await request(app).get(`/api/dies/${dieId}/cell-detections`)).body, []);

  // Bad requests.
  assert.equal(
    (await request(app).post(`/api/dies/${dieId}/cell-detections/job/start`).send({})).status,
    400
  );
  assert.equal(
    (
      await request(app)
        .post(`/api/dies/${dieId}/cell-detections/job/start`)
        .send({ cellTypeId: "nope" })
    ).status,
    400
  );

  const start = await request(app)
    .post(`/api/dies/${dieId}/cell-detections/job/start`)
    .send({ cellTypeId: "ct1", allowFlipY: false });
  assert.equal(start.status, 200);
  assert.equal(start.body.status, "running");
  assert.equal(start.body.cellTypeName, "NAND2");

  let job = start.body;
  for (let i = 0; i < 500 && job.status === "running"; i++) {
    await new Promise((r) => setTimeout(r, 10));
    job = (await request(app).get(`/api/dies/${dieId}/cell-detections/job`)).body;
  }
  assert.equal(job.status, "completed", job.error ?? "");
  assert.equal(job.percentage, 100);
  assert.equal(job.detections, 2);

  const list = (await request(app).get(`/api/dies/${dieId}/cell-detections`))
    .body as CellDetectionResult[];
  assert.equal(list.length, 1);
  const result = list[0];
  assert.equal(result.cellTypeId, "ct1");
  assert.equal(result.annotationsRev, 7);
  assert.equal(result.memberCount, 1);
  assert.equal(result.templateVias, PATTERN.length);
  assert.deepEqual(result.options, {
    allowFlipX: true,
    allowFlipY: false,
    avoidExistingCells: true
  });
  // The placed member is scored against the template it seeded.
  assert.equal(result.memberScores?.c1.score, 1);
  assert.equal(result.memberScores?.c1.matched, PATTERN.length);
  assert.equal(result.detections.length, 2);
  const upright = result.detections.find((d) => Math.abs(d.x - 300) <= 2 && Math.abs(d.y - 60) <= 2);
  const mirrored = result.detections.find((d) => Math.abs(d.x - 120) <= 2 && Math.abs(d.y - 150) <= 2);
  assert.ok(upright && !upright.flippedH && !upright.rotation, "upright copy");
  assert.ok(mirrored && mirrored.flippedH === true && !mirrored.rotation, "mirrored copy");
  assert.ok(upright.score > 0.9 && mirrored.score > 0.9);

  // The results file lives beside — never inside — annotations.json.
  const raw = await fs.readFile(path.join(dataRoot, "dies", dieId, "annotations.json"), "utf8");
  assert.deepEqual(JSON.parse(raw), annotations);
  const files = await fs.readdir(path.join(dataRoot, "dies", dieId, "cell-detections"));
  assert.deepEqual(files, ["ct1.json"]);

  // Dismiss one, un-dismiss it, then clear.
  const dismiss = await request(app)
    .post(`/api/dies/${dieId}/cell-detections/ct1/dismiss`)
    .send({ ids: [upright.id, "unknown-id"] });
  assert.equal(dismiss.status, 200);
  assert.deepEqual(dismiss.body.dismissed, [upright.id]);
  const undismiss = await request(app)
    .post(`/api/dies/${dieId}/cell-detections/ct1/dismiss`)
    .send({ ids: [upright.id], dismissed: false });
  assert.deepEqual(undismiss.body.dismissed, []);
  assert.equal(
    (await request(app).post(`/api/dies/${dieId}/cell-detections/zzz/dismiss`).send({ ids: [] }))
      .status,
    404
  );

  // A rerun carries the dismissal forward by placement (ids are fresh).
  await request(app)
    .post(`/api/dies/${dieId}/cell-detections/ct1/dismiss`)
    .send({ ids: [mirrored.id] });
  const rerun = await request(app)
    .post(`/api/dies/${dieId}/cell-detections/job/start`)
    .send({ cellTypeId: "ct1" });
  assert.equal(rerun.status, 200);
  for (let i = 0; i < 500; i++) {
    const j = (await request(app).get(`/api/dies/${dieId}/cell-detections/job`)).body;
    if (j.status !== "running") break;
    await new Promise((r) => setTimeout(r, 10));
  }
  const rerunResult = (await request(app).get(`/api/dies/${dieId}/cell-detections`))
    .body[0] as CellDetectionResult;
  const mirrored2 = rerunResult.detections.find((d) => d.flippedH === true)!;
  assert.ok(mirrored2 && mirrored2.id !== mirrored.id);
  assert.deepEqual(rerunResult.dismissed, [mirrored2.id]);
  await request(app)
    .post(`/api/dies/${dieId}/cell-detections/ct1/dismiss`)
    .send({ ids: [mirrored2.id], dismissed: false });

  // Rect crop endpoint serves proposal thumbnails.
  const crop = await request(app).get(`/api/dies/${dieId}/crop?x=300&y=60&w=${W}&h=${H}`);
  assert.equal(crop.status, 200);
  assert.match(crop.headers["content-type"], /image\/jpeg/);
  assert.equal((await request(app).get(`/api/dies/${dieId}/crop?x=1&y=1&w=0&h=5`)).status, 400);

  assert.equal((await request(app).delete(`/api/dies/${dieId}/cell-detections/ct1`)).status, 200);
  assert.deepEqual((await request(app).get(`/api/dies/${dieId}/cell-detections`)).body, []);
  assert.equal((await request(app).delete(`/api/dies/${dieId}/cell-detections`)).status, 200);
  // Human annotations untouched by clear.
  assert.deepEqual(
    JSON.parse(await fs.readFile(path.join(dataRoot, "dies", dieId, "annotations.json"), "utf8")),
    annotations
  );
});

test("cell-detection job fails cleanly without cached vias", async () => {
  const { app, dataRoot } = await createHarness();
  const dieId = await importDie(app);
  await fs.writeFile(
    path.join(dataRoot, "dies", dieId, "annotations.json"),
    JSON.stringify({
      version: 2,
      rev: 1,
      nets: [],
      grids: [],
      cellTypes: [{ id: "ct1", name: "X", cropRect: { x: 0, y: 0, width: W, height: H } }],
      cells: [{ id: "c1", cellTypeId: "ct1", x: 40, y: 40 }]
    })
  );
  const start = await request(app)
    .post(`/api/dies/${dieId}/cell-detections/job/start`)
    .send({ cellTypeId: "ct1" });
  assert.equal(start.status, 200);
  let job = start.body;
  for (let i = 0; i < 300 && job.status === "running"; i++) {
    await new Promise((r) => setTimeout(r, 10));
    job = (await request(app).get(`/api/dies/${dieId}/cell-detections/job`)).body;
  }
  assert.equal(job.status, "failed");
  assert.match(job.error, /no cached via predictions/);
});
