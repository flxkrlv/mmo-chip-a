import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";
import express from "express";
import request from "supertest";
import { createFsRouter } from "./fs.js";
import { createTileScheduler } from "../tileScheduler.js";
import { ensureDataStore, listDieRecords, readAnnotations, writeAnnotations, writeDieRecord } from "../store.js";
import {
  PROJECT_MANIFEST_FILE,
  readProjectManifest,
  resolveProjectDir,
  resolveProjectDirSync
} from "../projectLayout.js";
import type { DieRecord } from "../types.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function createRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function fsApp(dataRoot: string) {
  const app = express();
  app.use(express.json());
  app.use(
    createFsRouter({
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

function minimalRecord(id: string, name: string): DieRecord {
  const now = new Date().toISOString();
  return {
    id,
    name,
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
}

test("open-folder writes a project marker and routes annotations into the folder", async () => {
  const dataRoot = await createRoot("chip-fs-root-");
  const projectFolder = await createRoot("chip-fs-proj-");
  await ensureDataStore(dataRoot);

  const response = await request(fsApp(dataRoot))
    .post("/api/dies/open-folder")
    .send({ path: projectFolder, name: "My Chip" });

  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.existing, false);
  assert.equal(response.body.renamed, false);

  const dieId = response.body.dieId as string;

  // Marker must exist in the user's folder with the registered identity.
  const manifest = await readProjectManifest(projectFolder);
  assert.ok(manifest, "project.json should exist");
  assert.equal(manifest!.id, dieId);
  assert.equal(manifest!.name, "My Chip");

  // Materialise a metadata.json so the record is readable, then verify that
  // annotations land inside the project folder — not under <dataRoot>/dies.
  await writeDieRecord(dataRoot, { ...minimalRecord(dieId, "My Chip"), location: "folder", folderPath: projectFolder });
  await writeAnnotations(dataRoot, dieId, {
    version: 2,
    rev: 0,
    nets: [],
    cellTypes: [],
    cells: [],
    grids: []
  });

  const inFolder = path.join(projectFolder, "annotations.json");
  assert.ok(await fs.access(inFolder).then(() => true, () => false), "annotations.json in folder");
  const managed = path.join(dataRoot, "dies", dieId, "annotations.json");
  assert.equal(await fs.access(managed).then(() => true, () => false), false, "not in managed dir");

  const readBack = await readAnnotations(dataRoot, dieId);
  assert.equal(readBack.rev, 1);
});

test("open-folder re-opens an existing project folder without a new id", async () => {
  const dataRoot = await createRoot("chip-fs-root-");
  const projectFolder = await createRoot("chip-fs-proj-");
  await ensureDataStore(dataRoot);

  const first = await request(fsApp(dataRoot))
    .post("/api/dies/open-folder")
    .send({ path: projectFolder, name: "Chip A" });
  assert.equal(first.status, 200);
  const dieId = first.body.dieId as string;

  const second = await request(fsApp(dataRoot))
    .post("/api/dies/open-folder")
    .send({ path: projectFolder });
  assert.equal(second.status, 200);
  assert.equal(second.body.existing, true);
  assert.equal(second.body.dieId, dieId);
});

test("opening two copies of a folder project keeps them as separate tiles", async () => {
  const dataRoot = await createRoot("chip-fs-root-");
  const folderA = await createRoot("chip-fs-copyA-");
  const folderB = await createRoot("chip-fs-copyB-");
  await ensureDataStore(dataRoot);

  const sharedId = "folder-shared-copy";
  const now = new Date().toISOString();

  for (const folder of [folderA, folderB]) {
    await fs.writeFile(
      path.join(folder, PROJECT_MANIFEST_FILE),
      JSON.stringify({ version: 1, id: sharedId, name: "Copy", createdAt: now, updatedAt: now })
    );
    await fs.writeFile(
      path.join(folder, "metadata.json"),
      JSON.stringify({ ...minimalRecord(sharedId, "Copy"), location: "folder", folderPath: folder })
    );
  }

  const first = await request(fsApp(dataRoot)).post("/api/dies/open-folder").send({ path: folderA });
  assert.equal(first.status, 200);
  const second = await request(fsApp(dataRoot)).post("/api/dies/open-folder").send({ path: folderB });
  assert.equal(second.status, 200);

  const idA = first.body.dieId as string;
  const idB = second.body.dieId as string;
  assert.notEqual(idB, idA);
  assert.equal(second.body.renamed, true);

  // Each folder keeps its own identity — the copy must not be re-pointed at the
  // original, and its metadata.json must carry the fresh id.
  assert.equal((await readProjectManifest(folderB))!.id, idB);
  const metaB = JSON.parse(await fs.readFile(path.join(folderB, "metadata.json"), "utf8")) as DieRecord;
  assert.equal(metaB.id, idB);
  const metaA = JSON.parse(await fs.readFile(path.join(folderA, "metadata.json"), "utf8")) as DieRecord;
  assert.equal(metaA.id, idA);

  assert.equal((await resolveProjectDir(dataRoot, idA)).dir, path.resolve(folderA));
  assert.equal((await resolveProjectDir(dataRoot, idB)).dir, path.resolve(folderB));

  const records = await listDieRecords(dataRoot);
  assert.deepEqual(records.map((r) => r.id).sort(), [idA, idB].sort());
});

test("re-opening the same fully-formed folder returns its existing id", async () => {
  const dataRoot = await createRoot("chip-fs-root-");
  const projectFolder = await createRoot("chip-fs-proj-");
  await ensureDataStore(dataRoot);

  const first = await request(fsApp(dataRoot))
    .post("/api/dies/open-folder")
    .send({ path: projectFolder, name: "Same Chip" });
  assert.equal(first.status, 200);
  const dieId = first.body.dieId as string;

  await fs.writeFile(
    path.join(projectFolder, "metadata.json"),
    JSON.stringify({ ...minimalRecord(dieId, "Same Chip"), location: "folder", folderPath: projectFolder })
  );

  const second = await request(fsApp(dataRoot)).post("/api/dies/open-folder").send({ path: projectFolder });
  assert.equal(second.status, 200);
  assert.equal(second.body.dieId, dieId);
  assert.equal(second.body.renamed, false);

  // Only one shortcut/record may exist — no duplicate tile pointing at the folder.
  const records = await listDieRecords(dataRoot);
  assert.equal(records.filter((r) => r.id === dieId).length, 1);
});

test("relocate points a folder project at a moved directory", async () => {
  const dataRoot = await createRoot("chip-fs-root-");
  const originalFolder = await createRoot("chip-fs-proj-");
  await ensureDataStore(dataRoot);

  const opened = await request(fsApp(dataRoot))
    .post("/api/dies/open-folder")
    .send({ path: originalFolder, name: "Movable" });
  const dieId = opened.body.dieId as string;

  // Simulate the user moving the whole folder (copy to a new path, remove old).
  const movedFolder = await createRoot("chip-fs-moved-");
  await fs.rm(movedFolder, { recursive: true, force: true });
  await fs.cp(originalFolder, movedFolder, { recursive: true });
  await fs.rm(originalFolder, { recursive: true, force: true });

  const relocated = await request(fsApp(dataRoot))
    .post(`/api/dies/${dieId}/relocate`)
    .send({ path: movedFolder });
  assert.equal(relocated.status, 200);
  assert.equal(relocated.body.path, path.resolve(movedFolder));

  // A fresh annotation read must now resolve into the moved folder.
  await writeAnnotations(dataRoot, dieId, {
    version: 2,
    rev: 0,
    nets: [],
    cellTypes: [],
    cells: [],
    grids: []
  });
  assert.ok(
    await fs.access(path.join(movedFolder, "annotations.json")).then(() => true, () => false),
    "annotations.json should be in the relocated folder"
  );
});

// ── Regression guard ────────────────────────────────────────────────
// A managed (legacy) project MUST resolve to exactly the historical paths.
// If this ever drifts, every existing project's data would become unreachable.
test("managed projects resolve to the historical in-dataRoot paths", async () => {
  const dataRoot = await createRoot("chip-fs-legacy-");
  await ensureDataStore(dataRoot);

  const dieId = "legacy-die-id";
  const async_resolved = await resolveProjectDir(dataRoot, dieId);
  assert.equal(async_resolved.kind, "managed");
  assert.equal(async_resolved.available, true);
  assert.equal(async_resolved.dir, path.join(dataRoot, "dies", dieId));
  assert.equal(async_resolved.overlayDir, path.join(dataRoot, "overlay-images", dieId));

  // Sync variant used by the hot tile path must agree.
  const sync_resolved = resolveProjectDirSync(dataRoot, dieId, "managed");
  assert.equal(sync_resolved.dir, path.join(dataRoot, "dies", dieId));
  assert.equal(sync_resolved.overlayDir, path.join(dataRoot, "overlay-images", dieId));

  // A record that predates folder support (no location field) must also fall
  // back to the managed layout — both via the resolver and via the sync path.
  const legacySync = resolveProjectDirSync(dataRoot, dieId, "managed", undefined);
  assert.equal(legacySync.dir, path.join(dataRoot, "dies", dieId));
});

test("browse lists directories and flags project folders", async () => {
  const dataRoot = await createRoot("chip-fs-root-");
  const parent = await createRoot("chip-fs-browse-");
  await ensureDataStore(dataRoot);

  const plain = path.join(parent, "plain-folder");
  const project = path.join(parent, "project-folder");
  await fs.mkdir(plain, { recursive: true });
  await fs.mkdir(project, { recursive: true });
  await fs.writeFile(path.join(plain, ".hidden"), "");
  await fs.mkdir(path.join(parent, ".secret"), { recursive: true });
  await fs.writeFile(path.join(project, PROJECT_MANIFEST_FILE), JSON.stringify({ version: 1, id: "x", name: "x", createdAt: "", updatedAt: "" }));

  const response = await request(fsApp(dataRoot)).get("/api/fs/browse").query({ path: parent });
  assert.equal(response.status, 200);
  const names = (response.body.directories as Array<{ name: string; isProject: boolean }>);
  assert.deepEqual(names.map((entry) => entry.name), ["plain-folder", "project-folder"]);
  assert.equal(names[0].isProject, false);
  assert.equal(names[1].isProject, true);
  assert.equal(response.body.parent, path.dirname(parent));
});
