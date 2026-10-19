/**
 * The size of the analog overlay labels in the Cell RE.
 *
 * It used to be three presets (S / M / L); now it is a plain factor, so
 * the labels can be made bigger than L or smaller than S.
 */

/** What the old S / M / L buttons stood for. */
export const LABEL_SCALE_PRESETS = {
  small: 0.2,
  medium: 0.5,
  large: 1
} as const;

/** The default (the old "M"). */
export const LABEL_SCALE_DEFAULT = LABEL_SCALE_PRESETS.medium;

/** How far the factor may go. */
export const LABEL_SCALE_MIN = 0.05;
export const LABEL_SCALE_MAX = 4;

/** Keep the factor inside the range the canvas can draw. */
export function clampLabelScale(value: number): number {
  if (!Number.isFinite(value)) return LABEL_SCALE_DEFAULT;
  return Math.min(LABEL_SCALE_MAX, Math.max(LABEL_SCALE_MIN, value));
}

/**
 * The stored preference was a preset index (0 = S, 1 = M, 2 = L); it is a
 * factor now. Old values are mapped, a factor is kept as it is.
 */
export function migrateLabelScale(stored: unknown): number | undefined {
  if (stored === 0) return LABEL_SCALE_PRESETS.small;
  if (stored === 1) return LABEL_SCALE_PRESETS.medium;
  if (stored === 2) return LABEL_SCALE_PRESETS.large;
  if (typeof stored === "number" && Number.isFinite(stored) && stored > 0) {
    return clampLabelScale(stored);
  }
  return undefined;
}
