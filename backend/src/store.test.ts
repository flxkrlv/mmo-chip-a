import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  readAnnotations,
  writeAnnotations,
  writeDieRecord,
  writeJsonAtomic
} from "./store.js";
import { ensureDataStore } from "./store.js";
import type { DieAnnotations, DieRecord } from "./types.js";

test("writeJsonAtomic replaces the target and leaves no tmp files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "chip-store-"));
  const file = path.join(root, "data.json");
  await writeJsonAtomic(file, { rev: 1 });
  assert.equal(await fs.readFile(file, "utf8"), `${JSON.stringify({ rev: 1 }, null, 2)}\n`);
  await writeJsonAtomic(file, { rev: 2, nested: { list: [1, 2, 3] } });
  assert.equal(
    await fs.readFile(file, "utf8"),
    `${JSON.stringify({ rev: 2, nested: { list: [1, 2, 3] } }, null, 2)}\n`
  );
  const leftovers = (await fs.readdir(root)).filter((f) => f.endsWith(".tmp"));
  assert.deepEqual(leftovers, []);
});

test("writeAnnotations persists valid JSON with a bumped revision", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "chip-store-"));
  await ensureDataStore(root);
  const record: DieRecord = {
    id: "die1",
    name: "die1",
    originalFilename: "die.png",
    originalPath: path.join(root, "die.png"),
    width: 100,
    height: 100,
    tileSize: 32,
    tileFormat: "jpg",
    maxZoomLevel: 0,
    levels: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
  await writeDieRecord(root, record);

  const annotations: DieAnnotations = {
    version: 2,
    rev: 0,
    nets: [],
    cellTypes: [],
    cells: [],
    grids: []
  };
  assert.equal(await writeAnnotations(root, "die1", annotations), 1);
  assert.equal(await writeAnnotations(root, "die1", { ...annotations, rev: 1 }), 2);

  const reread = await readAnnotations(root, "die1");
  assert.equal(reread.rev, 2);

  const leftovers = (await fs.readdir(path.join(root, "dies", "die1"))).filter(
    (f) => f.endsWith(".tmp")
  );
  assert.deepEqual(leftovers, []);
});
