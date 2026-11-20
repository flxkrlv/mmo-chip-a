/**
 * Processing bounds for the imaging (specimen / wire-map) jobs — the fork
 * equivalent of upstream's security.ts region limits, scoped to what we
 * actually run. HTTP crops and ML inference keep their own local checks.
 *
 * Specimen and wire-map jobs crop whole cells, which on a high-magnification
 * die shot outgrow request-sized limits, so they get a bound of their own
 * (upstream deeff76). Everything is configurable via env.
 */
function positiveLimit(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export const imagingLimits = {
  /** Largest region (source px) a specimen/wire-map crop may cover. */
  regionPixels: positiveLimit("CHIPTOOL_MAX_IMAGING_REGION_PIXELS", 16_777_216),
  regionDimension: positiveLimit("CHIPTOOL_MAX_IMAGING_REGION_DIMENSION", 8192),
  /** Float buffers held at once while stacking one specimen's instances. */
  specimenBudgetBytes: positiveLimit("CHIPTOOL_SPECIMEN_BUDGET_BYTES", 2 * 1024 ** 3)
};

/** A crop over the region bound — its type is skipped, not the whole job. */
export class ImagingLimitError extends Error {
  constructor(message = "Image region exceeds imaging processing limits") {
    super(message);
    this.name = "ImagingLimitError";
  }
}

export function checkImagingRegion(width: number, height: number): void {
  const { regionPixels, regionDimension } = imagingLimits;
  if (
    ![width, height].every((n) => Number.isSafeInteger(n) && n > 0) ||
    width > regionDimension ||
    height > regionDimension ||
    width * height > regionPixels
  ) {
    throw new ImagingLimitError(
      `region ${width}x${height} exceeds the imaging bound (${regionDimension} px per side, ${regionPixels} px)`
    );
  }
}
