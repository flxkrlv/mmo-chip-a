/**
 * Die-viewer screenshot sizing. The scale multiplies the on-screen canvas's
 * device pixels; it is capped so the PNG stays within what browsers can
 * allocate for one canvas (side and area limits).
 */

export const SCREENSHOT_MIN_SCALE = 0.5;
export const SCREENSHOT_STEP = 0.25;
/** Upper end of the slider even when the canvas would allow more. */
export const SCREENSHOT_MAX_SCALE = 8;
const MAX_SIDE_PX = 16_384;
const MAX_AREA_PX = 120_000_000;

/** Output size for a screen canvas of `w × h` device px at `scale`. */
export function screenshotSize(w: number, h: number, scale: number): { width: number; height: number } {
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

/** Largest slider step whose PNG stays within the canvas limits. */
export function maxScreenshotScale(w: number, h: number): number {
  if (w <= 0 || h <= 0) return SCREENSHOT_MIN_SCALE;
  const bySide = MAX_SIDE_PX / Math.max(w, h);
  const byArea = Math.sqrt(MAX_AREA_PX / (w * h));
  const max = Math.min(SCREENSHOT_MAX_SCALE, bySide, byArea);
  return Math.max(SCREENSHOT_MIN_SCALE, Math.floor(max / SCREENSHOT_STEP) * SCREENSHOT_STEP);
}

/** `scale` snapped to the slider grid and clamped to `[min, max]`. */
export function clampScreenshotScale(scale: number, max: number): number {
  const snapped = Math.round(scale / SCREENSHOT_STEP) * SCREENSHOT_STEP;
  return Math.min(max, Math.max(SCREENSHOT_MIN_SCALE, snapped));
}
