import type { Cell, CellWarp } from "shared";
import { cellWorldRect, dieToTypeMatrix } from "./cellFootprint";
import { warpPieces } from "./cellWarp";

/** Draw a cell's crop (its die footprint, as served by `cellCropUrl`) into
 *  the type box at (0, 0), un-oriented so it shows upright like its type.
 *  Without a cell the image is the type template crop, already upright. */
export function drawCellCrop(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  cell: Cell | null,
  box: { w: number; h: number }
): void {
  if (!cell) {
    ctx.drawImage(img, 0, 0, box.w, box.h);
    return;
  }
  // Placed like the server cuts it (whole pixels, clamped at the die origin).
  const r = cellWorldRect(cell, box.w, box.h);
  const left = Math.max(0, Math.round(r.x));
  const top = Math.max(0, Math.round(r.y));
  ctx.save();
  ctx.transform(...dieToTypeMatrix(cell, box.w, box.h));
  ctx.drawImage(img, left - cell.x, top - cell.y, Math.round(r.x + r.width) - left, Math.round(r.y + r.height) - top);
  ctx.restore();
}

/**
 * Run `paint` (which draws image content in the type frame) through a
 * cell's piecewise stretch: once per grid rectangle, clipped to where that
 * rectangle is shown and scaled from where its content is. No stretch ⇒ one
 * plain call.
 */
export function drawWarped(
  ctx: CanvasRenderingContext2D,
  warp: CellWarp | undefined,
  box: { w: number; h: number },
  paint: () => void
): void {
  if (!warp) {
    paint();
    return;
  }
  // Each clip runs ~1 device px past its right / bottom side so the
  // anti-aliased clip edges between neighbouring pieces don't leave seams.
  const t = ctx.getTransform();
  const ex = 1 / Math.max(1e-6, Math.hypot(t.a, t.b));
  const ey = 1 / Math.max(1e-6, Math.hypot(t.c, t.d));
  for (const p of warpPieces(warp, box.w, box.h)) {
    const sw = p.sx1 - p.sx0;
    const sh = p.sy1 - p.sy0;
    if (sw <= 0 || sh <= 0) continue;
    ctx.save();
    ctx.beginPath();
    ctx.rect(p.dx0, p.dy0, p.dx1 - p.dx0 + ex, p.dy1 - p.dy0 + ey);
    ctx.clip();
    ctx.translate(p.dx0, p.dy0);
    ctx.scale((p.dx1 - p.dx0) / sw, (p.dy1 - p.dy0) / sh);
    ctx.translate(-p.sx0, -p.sy0);
    paint();
    ctx.restore();
  }
}
