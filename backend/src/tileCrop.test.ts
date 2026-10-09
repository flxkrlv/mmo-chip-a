import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { buildLevels } from "./dieImport/importer.js";
import {
  levelRegion,
  pickCropScale,
  renderCropFromOriginal,
  renderCropFromTiles,
  tilesAvailable,
  type PyramidSource
} from "./tileCrop.js";

const W = 300;
const H = 200;
const TILE = 64;

/** Smooth gradient + a few flat blocks: survives JPEG with small error. */
async function makeImage(file: string) {
  const data = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      const block = (Math.floor(x / 50) + Math.floor(y / 50)) % 2 ? 60 : 0;
      data[i] = Math.round((x / W) * 190) + block;
      data[i + 1] = Math.round((y / H) * 190) + block;
      data[i + 2] = 90;
    }
  }
  await sharp(data, { raw: { width: W, height: H, channels: 3 } }).png().toFile(file);
}

/** Writes every tile of the pyramid as PNG, like the importer (minus JPEG). */
async function makePyramid(original: string, dir: string, skip: string[] = []): Promise<PyramidSource> {
  const maxZ = Math.ceil(Math.log2(Math.max(W, H) / TILE));
  const levels = buildLevels(W, H, TILE, maxZ);
  for (const level of levels) {
    const levelImg = await sharp(original).resize(level.width, level.height, { fit: "fill" }).png().toBuffer();
    for (let ty = 0; ty < level.rows; ty++) {
      for (let tx = 0; tx < level.columns; tx++) {
        if (skip.includes(`${level.z}/${tx}_${ty}`)) continue;
        const left = tx * TILE;
        const top = ty * TILE;
        await fs.mkdir(path.join(dir, String(level.z)), { recursive: true });
        await sharp(levelImg)
          .extract({ left, top, width: Math.min(TILE, level.width - left), height: Math.min(TILE, level.height - top) })
          .png()
          .toFile(path.join(dir, String(level.z), `${tx}_${ty}.png`));
      }
    }
  }
  return {
    levels,
    tileSize: TILE,
    peekTile: async (z, x, y) => {
      const p = path.join(dir, String(z), `${x}_${y}.png`);
      try {
        await fs.access(p);
        return p;
      } catch {
        return null;
      }
    }
  };
}

async function meanAbsDiff(a: string, b: string) {
  const [ra, rb] = await Promise.all([a, b].map((f) => sharp(f).raw().toBuffer({ resolveWithObject: true })));
  assert.equal(ra.info.width, rb.info.width);
  assert.equal(ra.info.height, rb.info.height);
  let sum = 0;
  for (let i = 0; i < ra.data.length; i++) sum += Math.abs(ra.data[i] - rb.data[i]);
  return sum / ra.data.length;
}

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "tilecrop-"));
}

test("pickCropScale picks the coarsest level still >= px on the long side", () => {
  const levels = buildLevels(4096, 4096, 512, 3); // scales 8, 4, 2, 1
  assert.equal(pickCropScale(levels, { width: 1000, height: 600 }, undefined), 1);
  assert.equal(pickCropScale(levels, { width: 1000, height: 600 }, 256), 2);
  assert.equal(pickCropScale(levels, { width: 1000, height: 600 }, 100), 8);
  assert.equal(pickCropScale(levels, { width: 100, height: 60 }, 256), 1);
});

test("levelRegion rounds outwards and clamps to the level", () => {
  assert.deepEqual(levelRegion({ left: 5, top: 9, width: 10, height: 10 }, 4, { width: 100, height: 100 }), {
    x0: 1,
    y0: 2,
    width: 3,
    height: 3
  });
  assert.deepEqual(levelRegion({ left: 90, top: 0, width: 40, height: 4 }, 1, { width: 100, height: 100 }), {
    x0: 90,
    y0: 0,
    width: 10,
    height: 4
  });
});

test("full-resolution crop from tiles matches a crop of the original (4-tile straddle)", async () => {
  const dir = await tmpDir();
  const original = path.join(dir, "original.png");
  await makeImage(original);
  const base = await makePyramid(original, path.join(dir, "tiles"));
  const rect = { left: 40, top: 30, width: 70, height: 50 }; // straddles x=64, y=64

  assert.equal(await tilesAvailable({ base, rect, scale: 1 }), true);
  assert.equal(await renderCropFromTiles({ base, rect, scale: 1, target: path.join(dir, "t.jpg") }), true);
  await renderCropFromOriginal({ basePath: original, imageSize: { width: W, height: H }, rect, scale: 1, target: path.join(dir, "o.jpg") });
  const meta = await sharp(path.join(dir, "t.jpg")).metadata();
  assert.equal(meta.width, 70);
  assert.equal(meta.height, 50);
  assert.ok((await meanAbsDiff(path.join(dir, "t.jpg"), path.join(dir, "o.jpg"))) < 2);
});

test("preview crop comes from a coarse level with the same geometry as the original fallback", async () => {
  const dir = await tmpDir();
  const original = path.join(dir, "original.png");
  await makeImage(original);
  const base = await makePyramid(original, path.join(dir, "tiles"));
  const rect = { left: 100, top: 20, width: 160, height: 120 };

  assert.equal(await renderCropFromTiles({ base, rect, scale: 4, target: path.join(dir, "t.jpg") }), true);
  await renderCropFromOriginal({ basePath: original, imageSize: { width: W, height: H }, rect, scale: 4, target: path.join(dir, "o.jpg") });
  const meta = await sharp(path.join(dir, "t.jpg")).metadata();
  assert.equal(meta.width, 40);
  assert.equal(meta.height, 30);
  assert.ok((await meanAbsDiff(path.join(dir, "t.jpg"), path.join(dir, "o.jpg"))) < 6);
});

test("a missing tile makes the tile path decline without writing anything", async () => {
  const dir = await tmpDir();
  const original = path.join(dir, "original.png");
  await makeImage(original);
  const maxZ = Math.ceil(Math.log2(Math.max(W, H) / TILE));
  const base = await makePyramid(original, path.join(dir, "tiles"), [`${maxZ}/1_0`]);
  const rect = { left: 40, top: 30, width: 70, height: 20 };
  const target = path.join(dir, "t.jpg");

  assert.equal(await tilesAvailable({ base, rect, scale: 1 }), false);
  assert.equal(await renderCropFromTiles({ base, rect, scale: 1, target }), false);
  await assert.rejects(fs.access(target));
  // Coarser levels are still complete, so a preview is available.
  assert.equal(await tilesAvailable({ base, rect, scale: 2 }), true);
});

test("overlay tiles are composited over the base", async () => {
  const dir = await tmpDir();
  const original = path.join(dir, "original.png");
  await makeImage(original);
  const base = await makePyramid(original, path.join(dir, "tiles"));
  // Overlay: opaque white square at (50..90, 40..80), transparent elsewhere.
  const overlayFile = path.join(dir, "overlay.png");
  await sharp({ create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: { create: { width: 40, height: 40, channels: 4, background: "#ffffff" } }, left: 50, top: 40 }])
    .png()
    .toFile(overlayFile);
  const overlay = await makePyramid(overlayFile, path.join(dir, "overlay-tiles"));
  const rect = { left: 40, top: 30, width: 70, height: 60 };
  const target = path.join(dir, "t.jpg");
  assert.equal(await renderCropFromTiles({ base, overlay, rect, scale: 1, target }), true);

  const { data, info } = await sharp(target).raw().toBuffer({ resolveWithObject: true });
  const px = (x: number, y: number) => data[(y * info.width + x) * info.channels];
  assert.ok(px(30, 30) > 240, "inside overlay square is white"); // die (70, 60)
  assert.ok(px(2, 2) < 200, "outside overlay square shows the base"); // die (42, 32)
});
