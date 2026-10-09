import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";
import sharp from "sharp";
import { createTileScheduler } from "./tileScheduler.js";
import type { DieRecord } from "./types.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function createFolderDie(): Promise<{ dataRoot: string; projectDir: string; record: DieRecord }> {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "chip-sched-data-"));
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "chip-sched-proj-"));
  tempRoots.push(dataRoot, projectDir);
  await fs.mkdir(path.join(projectDir, "original"), { recursive: true });
  await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 9, g: 9, b: 9 } } })
    .png()
    .toFile(path.join(projectDir, "original", "die.png"));
  const now = new Date().toISOString();
  const record: DieRecord = {
    id: "sched-die",
    name: "Sched",
    originalFilename: "die.png",
    originalPath: path.join(projectDir, "original", "die.png"),
    width: 64,
    height: 64,
    tileSize: 32,
    tileFormat: "jpg",
    maxZoomLevel: 1,
    levels: [
      { z: 0, width: 32, height: 32, columns: 1, rows: 1, scale: 2 },
      { z: 1, width: 64, height: 64, columns: 2, rows: 2, scale: 1 }
    ],
    createdAt: now,
    updatedAt: now,
    location: "folder",
    folderPath: projectDir
  };
  return { dataRoot, projectDir, record };
}

async function writeTile(projectDir: string, name: string) {
  await fs.mkdir(path.dirname(path.join(projectDir, "tiles", name)), { recursive: true });
  await fs.writeFile(path.join(projectDir, "tiles", name), "jpg");
}

// After a restart the in-memory progress is gone. A lazy viewport render must
// not make a mostly-built die look like it is being re-tiled from 0%.
test("progress is seeded from tiles already on disk", async () => {
  const { dataRoot, projectDir, record } = await createFolderDie();
  await writeTile(projectDir, "0/0_0.jpg");
  await writeTile(projectDir, "1/0_0.jpg");
  await writeTile(projectDir, "1/1_0.jpg");
  await writeTile(projectDir, "1/0_1.jpg.deadbeef.tmp"); // killed mid-write

  const scheduler = createTileScheduler({ dataRoot, concurrency: 2 });
  await scheduler.requestTile(record, 1, 1, 1);

  const progress = scheduler.getProgress(record.id);
  assert.equal(progress?.totalTiles, 5);
  assert.equal(progress?.completedTiles, 4);
});

test("background prebuild queues only missing tiles and is a no-op when complete", async () => {
  const { dataRoot, projectDir, record } = await createFolderDie();
  await writeTile(projectDir, "0/0_0.jpg");
  await writeTile(projectDir, "1/0_0.jpg");

  const scheduler = createTileScheduler({ dataRoot, concurrency: 2 });
  scheduler.enqueueBackground(record);
  for (let i = 0; i < 100 && scheduler.getProgress(record.id)!.completedTiles < 5; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const progress = scheduler.getProgress(record.id)!;
  assert.equal(progress.completedTiles, 5);
  assert.equal(progress.generatedTiles, 3);
  // The pre-existing placeholder tiles were not re-rendered.
  assert.equal(await fs.readFile(path.join(projectDir, "tiles", "1", "0_0.jpg"), "utf8"), "jpg");

  const restarted = createTileScheduler({ dataRoot, concurrency: 2 });
  restarted.enqueueBackground(record);
  const afterRestart = restarted.getProgress(record.id)!;
  assert.equal(afterRestart.completedTiles, 5);
  assert.equal(afterRestart.generatedTiles, 0);
});
