/**
 * Die-viewer screenshot sizing. A scale multiplies the on-screen canvas's
 * device pixels. The top of the range is the die's native resolution for
 * the current view — one output pixel per pixel of the finest image
 * pyramid level — so higher settings keep adding real detail. The PNG is
 * streamed (see pngStream.ts), so only a total pixel budget applies.
 */

/** A fixed multiple of the screen, or "native": as fine as the die's tiles
 *  allow for whatever the current zoom is. */
export type ScreenshotScale = number | "native";

export const SCREENSHOT_MIN_SCALE = 0.5;
/** The slider reaches at least this far even when zoomed in past native
 *  (annotations still get sharper). */
const MIN_TOP_SCALE = 4;
/** Total output budget (pixels): beyond this the PNG gets too big to hold. */
export const SCREENSHOT_MAX_PIXELS = 2_000_000_000;

/** Scale at which the output has one pixel per finest-level image pixel. */
export function nativeScreenshotScale(zoom: number, dpr: number, finestLevelScale = 1): number {
  return 1 / Math.max(1e-9, zoom * dpr * finestLevelScale);
}

/** Output size for a screen canvas of `w × h` device px at `scale`. */
export function screenshotSize(w: number, h: number, scale: number): { width: number; height: number } {
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

/** Top of the slider: native (at least MIN_TOP_SCALE), within the pixel budget. */
export function maxScreenshotScale(w: number, h: number, native: number): number {
  if (w <= 0 || h <= 0) return SCREENSHOT_MIN_SCALE;
  const byBudget = Math.sqrt(SCREENSHOT_MAX_PIXELS / (w * h));
  return Math.max(SCREENSHOT_MIN_SCALE, Math.min(Math.max(native, MIN_TOP_SCALE), byBudget));
}

/** Round to a readable step: ¼ below 2×, ½ below 10×, whole above. */
export function snapScreenshotScale(s: number): number {
  const step = s < 2 ? 0.25 : s < 10 ? 0.5 : 1;
  return Math.round(s / step) * step;
}

/** The scale a preference means right now, inside `[min, max]`. */
export function resolveScreenshotScale(pref: ScreenshotScale, native: number, max: number): number {
  const s = pref === "native" ? native : pref;
  return Math.min(max, Math.max(SCREENSHOT_MIN_SCALE, s));
}

/** Slider position ↔ scale (logarithmic: the range can span 0.5× … 100×+). */
export const scaleToSlider = (s: number) => Math.log2(s);
export const sliderToScale = (v: number) => 2 ** v;
