import sharp from "sharp";

/**
 * Pyramidal (multi-resolution) TIFF support.
 *
 * A pyramidal TIFF already stores the image at several resolutions, either as
 * extra pages (libvips/`tiffsave --pyramid`, Aperio SVS, ...) or as SubIFDs of
 * the main image (OME-TIFF, `tiffsave --pyramid --subifd`). A coarse tile of
 * the zoom pyramid can then be cut from the smallest stored level that is
 * still at least as detailed as the tile, instead of decoding scale² pixels of
 * the full-resolution image. Tiled TIFFs are also random-access, so even the
 * full-resolution tiles only decode the region they cover.
 */

export interface SourceLevel {
  /** Where the level lives: page `index`, or SubIFD `index` of page 0. */
  kind: "base" | "page" | "subifd";
  index: number;
  width: number;
  height: number;
  /** Downsample factor relative to the base image (1 for the base). */
  factorX: number;
  factorY: number;
}

const TIFF_EXTENSION = /\.tiff?$/i;

export function isTiffPath(filePath: string): boolean {
  return TIFF_EXTENSION.test(filePath);
}

/**
 * Open one stored resolution of `filePath`. A null/base level opens the main
 * image exactly as before.
 */
export function openSourceLevel(
  filePath: string,
  level: SourceLevel | null,
  options: sharp.SharpOptions = {}
): sharp.Sharp {
  if (!level || level.kind === "base") return sharp(filePath, options);
  if (level.kind === "page") return sharp(filePath, { ...options, page: level.index });
  const image = sharp(filePath, { ...options, tiff: { subifd: level.index } });
  // sharp 0.34 stores the option as `tiffSubifd` but its native side only
  // reads it when a `subifd` key is present too, so without this the main
  // image is silently decoded instead of the SubIFD.
  (image as unknown as { options: { input: Record<string, unknown> } }).options.input.subifd =
    level.index;
  return image;
}

/**
 * All usable resolutions of a TIFF, base first and then from most to least
 * detailed. Pages/SubIFDs that are not a downscaled copy of the base (labels,
 * macro photos, thumbnails with another aspect ratio) are left out. A
 * non-TIFF or single-resolution file yields just the base level.
 */
export async function detectSourceLevels(filePath: string): Promise<SourceLevel[]> {
  const meta = await sharp(filePath, { limitInputPixels: false }).metadata();
  if (!meta.width || !meta.height) throw new Error("Failed to read image dimensions.");
  const base: SourceLevel = {
    kind: "base",
    index: 0,
    width: meta.width,
    height: meta.height,
    factorX: 1,
    factorY: 1
  };
  if (meta.format !== "tiff") return [base];

  const candidates: Array<Pick<SourceLevel, "kind" | "index">> = [];
  for (let index = 1; index < (meta.pages ?? 1); index += 1) candidates.push({ kind: "page", index });
  for (let index = 0; index < (meta.subifds ?? 0); index += 1) candidates.push({ kind: "subifd", index });

  const levels: SourceLevel[] = [];
  for (const candidate of candidates) {
    let width: number | undefined;
    let height: number | undefined;
    try {
      const probe = { ...candidate, width: 0, height: 0, factorX: 1, factorY: 1 };
      ({ width, height } = await openSourceLevel(filePath, probe, { limitInputPixels: false }).metadata());
    } catch {
      continue;
    }
    if (!width || !height || width >= base.width || height >= base.height) continue;
    if (!matchesBaseAspect(base, width, height)) continue;
    levels.push({
      ...candidate,
      width,
      height,
      factorX: nominalFactor(base.width / width),
      factorY: nominalFactor(base.height / height)
    });
  }

  levels.sort((a, b) => b.width - a.width);
  // A file may carry the same resolution twice (e.g. as page and SubIFD).
  const unique = levels.filter((level, i) => i === 0 || level.width !== levels[i - 1].width);
  return [base, ...unique];
}

/** Each axis rounds to a whole pixel independently, so allow a pixel or two. */
function matchesBaseAspect(base: { width: number; height: number }, width: number, height: number) {
  const expectedHeight = (base.height * width) / base.width;
  return Math.abs(expectedHeight - height) <= 2;
}

/**
 * Pyramids are almost always built by halving (or quartering), but the stored
 * level size is rounded, so 5000 px → 156 px reads as 32.05. Snap to the power
 * of two so tile coordinates map onto the level exactly.
 */
function nominalFactor(ratio: number): number {
  const power = 2 ** Math.round(Math.log2(ratio));
  return Math.abs(ratio / power - 1) < 0.03 ? power : ratio;
}

/**
 * Least detailed stored level that still has at least the resolution needed
 * to render at `scale` (base pixels per output pixel), so the result is only
 * ever downscaled.
 */
export function pickSourceLevel(levels: SourceLevel[], scale: number): SourceLevel {
  let best = levels[0];
  for (const level of levels) {
    if (level.factorX <= scale && level.factorY <= scale && level.factorX > best.factorX) {
      best = level;
    }
  }
  return best;
}

/**
 * Map a rectangle in base-image pixels onto `level`'s pixel grid, rounded
 * outwards and clamped to the level.
 */
export function regionInLevel(
  level: SourceLevel,
  rect: { left: number; top: number; width: number; height: number }
) {
  const left = Math.min(level.width - 1, Math.floor(rect.left / level.factorX));
  const top = Math.min(level.height - 1, Math.floor(rect.top / level.factorY));
  const right = Math.min(level.width, Math.ceil((rect.left + rect.width) / level.factorX));
  const bottom = Math.min(level.height, Math.ceil((rect.top + rect.height) / level.factorY));
  return {
    left,
    top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top)
  };
}

const levelCache = new Map<string, Promise<SourceLevel[]>>();

/**
 * Memoised detectSourceLevels for the tile hot path. Originals are never
 * rewritten in place, so the path is a sufficient key; a failed probe is
 * dropped so the next call retries.
 */
export function getSourceLevels(filePath: string): Promise<SourceLevel[]> {
  let pending = levelCache.get(filePath);
  if (!pending) {
    pending = detectSourceLevels(filePath);
    levelCache.set(filePath, pending);
    pending.catch(() => levelCache.delete(filePath));
  }
  return pending;
}
