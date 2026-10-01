import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";
import sharp from "sharp";
import { ensureTileForRecord, importDieShot } from "./importer.js";
import {
  detectSourceLevels,
  openSourceLevel,
  pickSourceLevel,
  regionInLevel,
  type SourceLevel
} from "./tiffPyramid.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function createRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "chip-tiff-"));
  tempRoots.push(root);
  return root;
}

function solid(width: number, height: number) {
  return sharp({ create: { width, height, channels: 3, background: { r: 200, g: 40, b: 10 } } });
}

function hasVipsCli(): boolean {
  try {
    execFileSync("vips", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

test("detects the page levels of a pyramidal TIFF", async () => {
  const root = await createRoot();
  const file = path.join(root, "pyr.tif");
  await solid(5000, 3000).tiff({ pyramid: true, tile: true, tileWidth: 256, tileHeight: 256 }).toFile(file);

  const levels = await detectSourceLevels(file);
  assert.deepEqual(
    levels.map((level) => [level.kind, level.width, level.height, level.factorX, level.factorY]),
    [
      ["base", 5000, 3000, 1, 1],
      ["page", 2500, 1500, 2, 2],
      ["page", 1250, 750, 4, 4],
      ["page", 625, 375, 8, 8],
      ["page", 312, 187, 16, 16],
      ["page", 156, 93, 32, 32]
    ]
  );
});

test("a flat TIFF or a PNG has only the base level", async () => {
  const root = await createRoot();
  await solid(300, 200).tiff().toFile(path.join(root, "flat.tif"));
  await solid(300, 200).png().toFile(path.join(root, "flat.png"));
  for (const name of ["flat.tif", "flat.png"]) {
    const levels = await detectSourceLevels(path.join(root, name));
    assert.equal(levels.length, 1, name);
    assert.equal(levels[0].kind, "base");
  }
});

test("detects and decodes SubIFD pyramids (OME-TIFF layout)", { skip: !hasVipsCli() && "needs the vips CLI" }, async () => {
  const root = await createRoot();
  const flat = path.join(root, "flat.tif");
  const file = path.join(root, "sub.tif");
  await solid(2000, 1000).tiff().toFile(flat);
  execFileSync("vips", ["tiffsave", flat, file, "--tile", "--pyramid", "--subifd"]);

  const levels = await detectSourceLevels(file);
  const half = levels.find((level) => level.kind === "subifd" && level.width === 1000);
  assert.ok(half, "the half-size SubIFD is found");
  // Guards the sharp `subifd` workaround: the decode must really be the SubIFD.
  const { info } = await openSourceLevel(file, half).raw().toBuffer({ resolveWithObject: true });
  assert.deepEqual([info.width, info.height], [1000, 500]);
});

test("picks the least detailed level that is still detailed enough", () => {
  const level = (factor: number): SourceLevel => ({
    kind: factor === 1 ? "base" : "page",
    index: Math.log2(factor),
    width: 4096 / factor,
    height: 4096 / factor,
    factorX: factor,
    factorY: factor
  });
  const levels = [level(1), level(4), level(16)];
  assert.equal(pickSourceLevel(levels, 1).factorX, 1);
  assert.equal(pickSourceLevel(levels, 2).factorX, 1);
  assert.equal(pickSourceLevel(levels, 8).factorX, 4);
  assert.equal(pickSourceLevel(levels, 64).factorX, 16);

  assert.deepEqual(regionInLevel(level(4), { left: 1024, top: 2048, width: 2048, height: 4096 }), {
    left: 256,
    top: 512,
    width: 512,
    height: 512
  });
});

test("imports a pyramidal TIFF and tiles it from the stored levels", async () => {
  const root = await createRoot();
  const upload = path.join(root, "upload.tif");
  await solid(5000, 3000).tiff({ pyramid: true, tile: true, compression: "jpeg" }).toFile(upload);

  const record = await importDieShot({
    dataRoot: root,
    filePath: upload,
    originalFilename: "Die Shot.tif",
    // Some browsers send no MIME type for TIFF; the extension must suffice.
    mimeType: "application/octet-stream",
    tileSize: 512,
    limitInputPixels: false,
    tileConcurrency: 1
  });
  assert.equal(path.extname(record.originalPath), ".tif");
  assert.deepEqual([record.width, record.height, record.maxZoomLevel], [5000, 3000, 4]);

  for (const [z, x, y] of [
    [0, 0, 0],
    [2, 2, 1],
    [4, 9, 5]
  ]) {
    const level = record.levels[z];
    const tilePath = await ensureTileForRecord({ dataRoot: root, record, z, x, y });
    const meta = await sharp(tilePath).metadata();
    assert.equal(meta.width, Math.min(512, level.width - x * 512), `z=${z} width`);
    assert.equal(meta.height, Math.min(512, level.height - y * 512), `z=${z} height`);
    const { channels } = await sharp(tilePath).stats();
    assert.ok(Math.abs(channels[0].mean - 200) < 6, `z=${z} keeps the image colour`);
  }
});

test("rejects files that are not PNG, JPEG or TIFF", async () => {
  const root = await createRoot();
  const upload = path.join(root, "upload.webp");
  await solid(64, 64).webp().toFile(upload);
  await assert.rejects(
    importDieShot({
      dataRoot: root,
      filePath: upload,
      originalFilename: "die.png",
      mimeType: "image/png",
      tileSize: 512,
      limitInputPixels: false,
      tileConcurrency: 1
    }),
    /PNG, JPEG and TIFF/
  );
});
