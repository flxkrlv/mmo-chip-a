import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";
import AdmZip from "adm-zip";
import express from "express";
import request from "supertest";
import { createProjectIORouter } from "./api/projectIO.js";
import { createTileScheduler } from "./tileScheduler.js";
import { ensureDataStore, writeDieRecord } from "./store.js";
import type { DieRecord } from "./types.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function createRoot(): Promise<string> {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "chip-project-io-test-"));
  tempRoots.push(dataRoot);
  await ensureDataStore(dataRoot);
  return dataRoot;
}

function projectApp(dataRoot: string) {
  const app = express();
  app.use(express.json());
  app.use(
    createProjectIORouter({
      dataRoot,
      tileScheduler: createTileScheduler({ dataRoot, concurrency: 2 })
    })
  );
  app.use(
    (
      error: Error & { status?: number },
      _request: express.Request,
      response: express.Response,
      _next: express.NextFunction
    ) => {
      response.status(error.status ?? 500).json({ error: error.message });
    }
  );
  return app;
}

async function writeMinimalDie(dataRoot: string, dieId: string): Promise<void> {
  const now = new Date().toISOString();
  const record: DieRecord = {
    id: dieId,
    name: dieId,
    originalFilename: "die.png",
    originalPath: "",
    width: 512,
    height: 512,
    tileSize: 256,
    tileFormat: "png",
    maxZoomLevel: 0,
    levels: [],
    createdAt: now,
    updatedAt: now
  };
  await writeDieRecord(dataRoot, record);
  const dieDir = path.join(dataRoot, "dies", dieId);
  await fs.mkdir(dieDir, { recursive: true });
  await fs.writeFile(path.join(dieDir, "annotations.json"), "{}");
}

test("project export includes shared overlay manifest and original but excludes generated tiles", async () => {
  const dataRoot = await createRoot();
  const dieId = "shared-overlay-export";
  const sourceId = "overlay-source-1";
  await writeMinimalDie(dataRoot, dieId);

  const sourceDir = path.join(dataRoot, "overlay-images", dieId, sourceId);
  const originalPath = path.join(sourceDir, "original.png");
  await fs.mkdir(path.join(sourceDir, "tiles", "0", "0"), { recursive: true });
  await fs.writeFile(originalPath, Buffer.from("overlay-original"));
  await fs.writeFile(path.join(sourceDir, "tiles", "0", "0", "0.png"), Buffer.from("derived-tile"));
  await fs.writeFile(
    path.join(sourceDir, "manifest.json"),
    JSON.stringify({
      id: sourceId,
      name: "Shared overlay",
      originalFilename: "shared.png",
      originalPath,
      size: 16,
      width: 512,
      height: 512,
      tileSize: 512,
      tileFormat: "png",
      hasAlpha: true,
      maxZoomLevel: 0,
      levels: [],
      ready: true,
      createdAt: "2026-08-15T00:00:00.000Z",
      updatedAt: "2026-08-15T00:00:00.000Z"
    })
  );

  const response = await request(projectApp(dataRoot))
    .post(`/api/dies/${dieId}/export-project`)
    .send({ mode: "full" })
    .buffer(true)
    .parse((res, callback) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => callback(null, Buffer.concat(chunks)));
    });
  assert.equal(response.status, 200);

  const zip = new AdmZip(response.body as Buffer);
  const names = zip.getEntries().map((entry) => entry.entryName).sort();
  assert.ok(names.includes(`overlay-images/${sourceId}/manifest.json`));
  assert.ok(names.includes(`overlay-images/${sourceId}/original.png`));
  assert.equal(names.some((name) => name.includes("/tiles/")), false);
  const portableManifest = JSON.parse(
    zip.readAsText(`overlay-images/${sourceId}/manifest.json`)
  ) as { originalPath: string };
  assert.equal(portableManifest.originalPath, "original.png");
});

test("project import rejects derived overlay tile entries", async () => {
  const dataRoot = await createRoot();
  const zip = new AdmZip();
  zip.addFile(
    "metadata.json",
    Buffer.from(
      JSON.stringify({
        id: "traversal-die",
        name: "Traversal die",
        originalFilename: "die.png",
        originalPath: "",
        width: 1,
        height: 1,
        tileSize: 256,
        tileFormat: "png",
        maxZoomLevel: 0,
        levels: [],
        createdAt: "2026-08-15T00:00:00.000Z",
        updatedAt: "2026-08-15T00:00:00.000Z"
      })
    )
  );
  zip.addFile("annotations.json", Buffer.from("{}"));
  zip.addFile(
    "overlay-images/overlay-source-1/tiles/0/0/0.png",
    Buffer.from("derived-tile-must-not-be-imported")
  );

  const response = await request(projectApp(dataRoot))
    .post("/api/dies/import-project")
    .attach("file", zip.toBuffer(), {
      filename: "unsafe-project.zip",
      contentType: "application/zip"
    });
  assert.equal(response.status, 400);
  assert.match(response.body.error, /Invalid overlay archive entry|Unsupported overlay archive entry/);
  await assert.rejects(
    fs.access(
      path.join(
        dataRoot,
        "overlay-images",
        "traversal-die",
        "overlay-source-1",
        "tiles",
        "0",
        "0",
        "0.png"
      )
    )
  );
});

test("project import extracts a compressed original without buffering the archive", async () => {
  const dataRoot = await createRoot();
  const zip = new AdmZip();
  zip.addFile(
    "metadata.json",
    Buffer.from(
      JSON.stringify({
        id: "streamed-project",
        name: "Streamed project",
        originalFilename: "die.png",
        originalPath: "",
        width: 32,
        height: 32,
        tileSize: 256,
        tileFormat: "png",
        maxZoomLevel: 0,
        levels: [],
        createdAt: "2026-08-15T00:00:00.000Z",
        updatedAt: "2026-08-15T00:00:00.000Z"
      })
    )
  );
  zip.addFile("annotations.json", Buffer.from('{"layers":[]}'));
  const original = Buffer.alloc(2 * 1024 * 1024, 0x5a);
  zip.addFile("original/die.png", original);

  const response = await request(projectApp(dataRoot))
    .post("/api/dies/import-project")
    .attach("file", zip.toBuffer(), {
      filename: "compressed-project.zip",
      contentType: "application/zip"
    });

  assert.equal(response.status, 200);
  assert.equal(response.body.dieId, "streamed-project");
  const restored = await fs.readFile(path.join(dataRoot, "dies", "streamed-project", "original", "die.png"));
  assert.deepEqual(restored, original);
  const metadata = JSON.parse(
    await fs.readFile(path.join(dataRoot, "dies", "streamed-project", "metadata.json"), "utf8")
  ) as DieRecord;
  assert.equal(metadata.originalPath, path.join(dataRoot, "dies", "streamed-project", "original", "die.png"));
});
