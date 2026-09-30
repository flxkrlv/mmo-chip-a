import { promises as fs } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import sharp from "sharp";
import type { DieLevelMetadata } from "shared";

/**
 * Cell crops assembled from the tile pyramid instead of the original image.
 *
 * Decoding the original (often a multi-hundred-megapixel PNG, which is not
 * random-access) costs seconds per crop. Pyramid tiles are small JPEG/PNGs
 * that are usually already on disk, so a crop only decodes the few tiles it
 * overlaps — and a coarse level gives an instant low-resolution preview that
 * the client later replaces with the full-resolution crop.
 *
 * Tiles are only *read*, never generated here: generating a missing tile
 * decodes the original once per tile, so a crop over a not-yet-built area is
 * cheaper as one direct extract from the original (renderCropFromOriginal).
 */

export interface PyramidSource {
  levels: DieLevelMetadata[];
  tileSize: number;
  /** Path of the z/x/y tile if it is already on disk, else null. */
  peekTile: (z: number, x: number, y: number) => Promise<string | null>;
}

/** Crop rectangle in full-resolution (level scale 1) pixels. */
export interface CropRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Coarsest pyramid scale whose output still has a long side of at least
 * `minPx` pixels. Without `minPx` (or when the crop is already small) this is
 * 1, i.e. full resolution.
 */
export function pickCropScale(
  levels: DieLevelMetadata[],
  rect: Pick<CropRect, "width" | "height">,
  minPx: number | undefined
): number {
  if (!minPx || minPx <= 0) return 1;
  const longSide = Math.max(rect.width, rect.height);
  let best = 1;
  for (const level of levels) {
    if (level.scale > best && longSide / level.scale >= minPx) best = level.scale;
  }
  return best;
}

/** The crop rect expressed in the pixel grid of the level with `scale`. */
export function levelRegion(rect: CropRect, scale: number, level: Pick<DieLevelMetadata, "width" | "height">) {
  const x0 = Math.floor(rect.left / scale);
  const y0 = Math.floor(rect.top / scale);
  const x1 = Math.min(level.width, Math.ceil((rect.left + rect.width) / scale));
  const y1 = Math.min(level.height, Math.ceil((rect.top + rect.height) / scale));
  return { x0, y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) };
}

type Region = { x0: number; y0: number; width: number; height: number };

interface TilePiece {
  path: string;
  /** Rect to extract from the tile file. */
  extract: { left: number; top: number; width: number; height: number };
  /** Placement in the output. */
  left: number;
  top: number;
}

/**
 * Tiles of one source covering `region` (level pixel grid), or null when any
 * of them is not on disk yet. Parts outside the source's level are simply
 * absent, so a smaller overlay leaves the base visible.
 */
async function regionPieces(
  source: PyramidSource,
  scale: number,
  region: Region
): Promise<TilePiece[] | null> {
  const level = source.levels.find((l) => l.scale === scale);
  if (!level) return null;
  const ts = source.tileSize;
  const rx1 = Math.min(region.x0 + region.width, level.width);
  const ry1 = Math.min(region.y0 + region.height, level.height);
  if (rx1 <= region.x0 || ry1 <= region.y0) return [];

  const jobs: Promise<TilePiece | null>[] = [];
  for (let ty = Math.floor(region.y0 / ts); ty <= Math.floor((ry1 - 1) / ts); ty++) {
    for (let tx = Math.floor(region.x0 / ts); tx <= Math.floor((rx1 - 1) / ts); tx++) {
      const ix0 = Math.max(region.x0, tx * ts);
      const iy0 = Math.max(region.y0, ty * ts);
      const ix1 = Math.min(rx1, (tx + 1) * ts);
      const iy1 = Math.min(ry1, (ty + 1) * ts);
      jobs.push(
        source.peekTile(level.z, tx, ty).then((tilePath) =>
          tilePath
            ? {
                path: tilePath,
                extract: { left: ix0 - tx * ts, top: iy0 - ty * ts, width: ix1 - ix0, height: iy1 - iy0 },
                left: ix0 - region.x0,
                top: iy0 - region.y0
              }
            : null
        )
      );
    }
  }
  const pieces = await Promise.all(jobs);
  return pieces.every((p): p is TilePiece => p !== null) ? pieces : null;
}

async function pieceOverlay(piece: TilePiece): Promise<sharp.OverlayOptions> {
  const { data, info } = await sharp(piece.path)
    .extract(piece.extract)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    input: data,
    raw: { width: info.width, height: info.height, channels: info.channels },
    left: piece.left,
    top: piece.top
  };
}

async function writeJpegAtomic(pipeline: sharp.Sharp, target: string): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  try {
    await pipeline.jpeg({ quality: 90 }).toFile(temp);
    await fs.rename(temp, target);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

/** Whether every tile renderCropFromTiles would need is already built. */
export async function tilesAvailable(params: {
  base: PyramidSource;
  overlay?: PyramidSource | null;
  rect: CropRect;
  scale: number;
}): Promise<boolean> {
  const baseLevel = params.base.levels.find((l) => l.scale === params.scale);
  if (!baseLevel) return false;
  const region = levelRegion(params.rect, params.scale, baseLevel);
  const [basePieces, overlayPieces] = await Promise.all([
    regionPieces(params.base, params.scale, region),
    params.overlay ? regionPieces(params.overlay, params.scale, region) : Promise.resolve([])
  ]);
  return basePieces !== null && overlayPieces !== null;
}

/**
 * Render `rect` of `base` (with an optional aligned `overlay` composited on
 * top) at pyramid `scale` into a JPEG at `target`. Output size is the crop
 * size divided by `scale` (rounded outwards to whole level pixels). Returns
 * false, without writing anything, when a needed tile is not built yet.
 */
export async function renderCropFromTiles(params: {
  base: PyramidSource;
  overlay?: PyramidSource | null;
  rect: CropRect;
  scale: number;
  target: string;
}): Promise<boolean> {
  const baseLevel = params.base.levels.find((l) => l.scale === params.scale);
  if (!baseLevel) return false;
  const region = levelRegion(params.rect, params.scale, baseLevel);
  if (region.width <= 0 || region.height <= 0) throw new Error("Crop outside image");

  const [basePieces, overlayPieces] = await Promise.all([
    regionPieces(params.base, params.scale, region),
    params.overlay ? regionPieces(params.overlay, params.scale, region) : Promise.resolve([])
  ]);
  if (!basePieces || !overlayPieces) return false;

  const parts = await Promise.all([...basePieces, ...overlayPieces].map(pieceOverlay));
  await writeJpegAtomic(
    sharp({
      create: {
        width: region.width,
        height: region.height,
        channels: 3,
        background: { r: 0, g: 0, b: 0 }
      }
    }).composite(parts),
    params.target
  );
  return true;
}

/**
 * Same output as renderCropFromTiles, straight from the original image(s).
 * One decode of the original — the fallback when the pyramid is incomplete.
 */
export async function renderCropFromOriginal(params: {
  basePath: string;
  overlayPath?: string | null;
  /** Full-resolution image size, to clamp the level region. */
  imageSize: { width: number; height: number };
  rect: CropRect;
  scale: number;
  target: string;
}): Promise<void> {
  const { scale } = params;
  const region = levelRegion(params.rect, scale, {
    width: Math.ceil(params.imageSize.width / scale),
    height: Math.ceil(params.imageSize.height / scale)
  });
  if (region.width <= 0 || region.height <= 0) throw new Error("Crop outside image");
  const left = region.x0 * scale;
  const top = region.y0 * scale;
  const source = {
    left,
    top,
    width: Math.min(params.imageSize.width - left, region.width * scale),
    height: Math.min(params.imageSize.height - top, region.height * scale)
  };
  const extract = (file: string) => {
    const pipeline = sharp(file, { limitInputPixels: false }).extract(source);
    return scale === 1
      ? pipeline
      : pipeline.resize({ width: region.width, height: region.height, fit: "fill" });
  };

  let pipeline = extract(params.basePath);
  if (params.overlayPath) {
    try {
      const overlay = await extract(params.overlayPath).png().toBuffer();
      pipeline = extract(params.basePath).composite([{ input: overlay, blend: "over" }]);
    } catch {
      // Overlay not available (or smaller than the crop) — base-only crop.
    }
  }
  await writeJpegAtomic(pipeline, params.target);
}

const inFlight = new Map<string, Promise<void>>();

/**
 * Serve-from-cache helper: resolves once `target` exists, rendering it at most
 * once even when the thumbnail strip and the canvas ask concurrently.
 */
export async function ensureCrop(target: string, render: () => Promise<void>): Promise<void> {
  try {
    await fs.access(target);
    return;
  } catch { /* cache miss */ }
  const pending = inFlight.get(target);
  if (pending) return pending;
  const task = render().finally(() => inFlight.delete(target));
  inFlight.set(target, task);
  return task;
}
