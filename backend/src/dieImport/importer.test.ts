import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";
import sharp from "sharp";
import { buildLevels, ensureTileForRecord, importDieShot } from "./importer.js";
import { detectSourceLevels } from "./tiffPyramid.js";
import type { DieRecord } from "../types.js";

// Match backend/src/index.ts: never cache open input files, or a pyramidal
// TIFF read through a stored level stays locked (EBUSY on cleanup) on Windows.
sharp.cache({ memory: 256, files: 0, items: 200 });

const tempRoots: string[] = [];

afterEach(async () => {
  // Windows can hold a lock on freshly-written TIFFs for a moment (AV /
  // indexer); retry the cleanup before giving up.
  await Promise.all(tempRoots.splice(0).map(async (root) => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await fs.rm(root, { recursive: true, force: true });
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EBUSY" || attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }));
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

// Upstream 40da967 adapted: PNG/JPEG originals are converted to a lossless
// tiled pyramidal TIFF at import so lazy tiles read stored levels.
test("importDieShot converts a JPEG original to a tiled pyramidal TIFF", async () => {
  const root = await createRoot("chip-import-conv-");
  const upload = path.join(root, "shot.jpg");
  await sharp({
    create: { width: 900, height: 600, channels: 3, background: { r: 2, g: 4, b: 8 } }
  }).jpeg().toFile(upload);

  const record = await importDieShot({
    dataRoot: root,
    filePath: upload,
    originalFilename: "shot.jpg",
    mimeType: "image/jpeg",
    tileSize: 512,
    limitInputPixels: false,
    tileConcurrency: 2
  });

  assert.equal(record.originalPath, path.join(root, "dies", record.id, "original", "shot.tif"));
  await fs.access(record.originalPath);
  const levels = await detectSourceLevels(record.originalPath);
  assert.ok(levels.length > 1, "stored TIFF must be pyramidal");

  // A tile is cut from the stored levels (tile + its coarse level exist).
  const tilePath = await ensureTileForRecord({
    dataRoot: root,
    record,
    z: 0,
    x: 0,
    y: 0
  });
  await fs.access(tilePath);

  // --keep-original equivalence: no conversion stores the file as-is.
  const raw = path.join(root, "raw.png");
  await sharp({
    create: { width: 100, height: 100, channels: 3, background: { r: 1, g: 2, b: 3 } }
  }).png().toFile(raw);
  const kept = await importDieShot({
    dataRoot: root,
    filePath: raw,
    originalFilename: "raw.png",
    mimeType: "image/png",
    tileSize: 512,
    limitInputPixels: false,
    tileConcurrency: 2,
    tiledOriginal: false
  });
  assert.ok(kept.originalPath.endsWith(".png"));
});
