import type { Rect } from "./geometry";
import type { Rotation } from "./mergeCells";
import { rectCornerPoints } from "./libraryPlacement";

/**
 * The analog-library device template's draft: the generated device laid
 * over the die, moved, stretched and oriented until it sits on the
 * transistor in the image.
 *
 * The generated device has a fixed size (its parameters and the scale
 * decide it); `k` is the stretch the user applies on top — the tool
 * re-generates the device at the stretched scale when the draft is
 * accepted, so the placed cell's geometry is the final one.
 */
export interface AnalogDraft {
  /** Footprint centre, die px. */
  cx: number;
  cy: number;
  /** The stretch over the generated size. */
  k: number;
  rotation: Rotation;
  flippedH: boolean;
  flippedV: boolean;
}

/** The draft's footprint: the generated box, stretched and turned. */
export function analogFootprint(d: AnalogDraft, baseW: number, baseH: number): Rect {
  const w = baseW * d.k;
  const h = baseH * d.k;
  const quarter = d.rotation === 90 || d.rotation === 270;
  const fw = quarter ? h : w;
  const fh = quarter ? w : h;
  return { x: d.cx - fw / 2, y: d.cy - fh / 2, width: fw, height: fh };
}

/**
 * Stretch the draft by dragging footprint corner `corner` (an index into
 * `rectCornerPoints`) towards `to`, the opposite corner pinned. Uniform:
 * the pointer is projected onto the box diagonal, so the aspect never
 * changes. Never shrinks below `minPx` on the short side.
 */
export function analogResizeFromCorner(
  d: AnalogDraft,
  baseW: number,
  baseH: number,
  corner: number,
  to: { x: number; y: number },
  minPx = 4
): AnalogDraft {
  const fp = analogFootprint(d, baseW, baseH);
  const corners = rectCornerPoints(fp);
  const anchor = corners[(corner + 2) % 4];
  const dx = corners[corner].x - anchor.x;
  const dy = corners[corner].y - anchor.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return d;
  const t = Math.max(
    ((to.x - anchor.x) * dx + (to.y - anchor.y) * dy) / len2,
    minPx / Math.max(1e-9, Math.min(fp.width, fp.height))
  );
  return { ...d, k: d.k * t, cx: anchor.x + (dx * t) / 2, cy: anchor.y + (dy * t) / 2 };
}
