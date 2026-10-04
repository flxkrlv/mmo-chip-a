import type { Cell } from "shared";
import { cellWorldRect, dieToTypeMatrix } from "./cellFootprint";

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
