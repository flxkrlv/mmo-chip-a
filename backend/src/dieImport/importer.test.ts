import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";
import sharp from "sharp";
import { buildLevels, ensureTileForRecord } from "./importer.js";
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

test("builds a complete zoom pyramid", () => {
  const levels = buildLevels(4096, 2048, 512, 3);
  assert.deepEqual(levels, [
    { z: 0, width: 512, height: 256, columns: 1, rows: 1, scale: 8 },
    { z: 1, width: 1024, height: 512, columns: 2, rows: 1, scale: 4 },
    { z: 2, width: 2048, height: 1024, columns: 4, rows: 2, scale: 2 },
    { z: 3, width: 4096, height: 2048, columns: 8, rows: 4, scale: 1 }
  ]);
});

// A folder project's original lives in the project folder; the absolute
// `originalPath` in metadata can go stale after a move/rename/copy. Tile
// generation must use the folder copy, or the base image disappears.
test("ensureTileForRecord uses the project-folder original over a stale originalPath", async () => {
  const projectDir = await createRoot("chip-tile-proj-");
  await fs.mkdir(path.join(projectDir, "original"), { recursive: true });
  await sharp({
    create: { width: 64, height: 64, channels: 3, background: { r: 1, g: 2, b: 3 } }
  })
    .png()
    .toFile(path.join(projectDir, "original", "die.png"));

  const now = new Date().toISOString();
  const record: DieRecord = {
    id: "folder-stale",
    name: "Stale",
    originalFilename: "die.png",
    originalPath: path.join("Z:", "does-not-exist", "original", "die.png"),
    width: 64,
    height: 64,
    tileSize: 32,
    tileFormat: "png",
    maxZoomLevel: 0,
    levels: [{ z: 0, width: 64, height: 64, columns: 2, rows: 2, scale: 1 }],
    createdAt: now,
    updatedAt: now,
    location: "folder",
    folderPath: projectDir
  };

  const tilePath = await ensureTileForRecord({
    dataRoot: projectDir,
    record,
    z: 0,
    x: 0,
    y: 0,
    projectDir
  });

  await fs.access(tilePath);
  assert.equal(tilePath, path.join(projectDir, "tiles", "0", "0_0.jpg"));
  const stat = await fs.stat(tilePath);
  assert.ok(stat.size > 0, "tile must be generated from the folder copy");
});
