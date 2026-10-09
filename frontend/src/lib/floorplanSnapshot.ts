/**
 * floorplanSnapshot.ts — floorplan regions drawn into a canvas for the die
 * screenshot (TiledRenderer.renderSnapshotPng `drawWorld`). On screen they
 * are SVG (FloorplanOverlay), which the snapshot can't copy, so this mirrors
 * that look: dashed outline in the region color and the (multiline) name
 * label, with the same CSS-px sizes scaled to the output resolution.
 */

import type { FloorplanRegion } from "shared";
import { floorplanNameLines } from "./floorplanName";

/** FloorplanOverlay's visibility rule: a per-name override, else the global
 *  "floorplan" kind. */
export function isFloorplanVisible(
  region: FloorplanRegion,
  globallyHidden: boolean,
  hiddenTypeNames: Record<string, boolean>
): boolean {
  const override = hiddenTypeNames[region.name || "(unnamed)"];
  return override === undefined ? !globallyHidden : !override;
}

const STROKE_CSS = 2.2;
const DEFAULT_COLOR = "#4dabf7";

/**
 * Draw `regions` into `ctx`, which is transformed to world coordinates.
 * `zoom` = on-screen CSS px per world unit (label size / offsets follow the
 * screen), `pxPerWorld` / `pxPerCss` = output px per world unit / CSS px.
 */
export function drawFloorplansForSnapshot(
  ctx: CanvasRenderingContext2D,
  regions: readonly FloorplanRegion[],
  view: { zoom: number; pxPerWorld: number; pxPerCss: number }
): void {
  const cssToWorld = 1 / view.zoom; // world units per CSS px
  for (const region of regions) {
    const g = region.geometry;
    if (g.length < 2) continue;
    const color = region.color || DEFAULT_COLOR;
    const isPoly = (region.kind as string) === "poly" || region.kind === "polygon";

    ctx.save();
    ctx.beginPath();
    if (isPoly) {
      ctx.moveTo(g[0].x, g[0].y);
      for (let i = 1; i < g.length; i++) ctx.lineTo(g[i].x, g[i].y);
      ctx.closePath();
    } else {
      const x = Math.min(g[0].x, g[1].x);
      const y = Math.min(g[0].y, g[1].y);
      const w = Math.abs(g[1].x - g[0].x);
      const h = Math.abs(g[1].y - g[0].y);
      const r = Math.min(3 * cssToWorld, w / 2, h / 2);
      if (typeof ctx.roundRect === "function") ctx.roundRect(x, y, w, h, r);
      else ctx.rect(x, y, w, h);
    }
    // Same widths as the SVG (polygons are drawn 1.3× thicker there).
    ctx.lineWidth = STROKE_CSS * (isPoly ? 1.3 : 1) * cssToWorld;
    ctx.setLineDash([7 * cssToWorld, 4 * cssToWorld]);
    ctx.strokeStyle = color;
    ctx.stroke();
    ctx.restore();

    const lines = floorplanNameLines(region.name);
    if (lines.length === 0) continue;
    const fontCss = Math.max(13, (14 * view.zoom) / 1000);
    const fontWorld = fontCss * cssToWorld;
    // Label anchor: rect = top-left + (6, 16) CSS px; polygon = first vertex + (8, 18).
    const ax = isPoly ? g[0].x + 8 * cssToWorld : Math.min(g[0].x, g[1].x) + 6 * cssToWorld;
    const ay = isPoly ? g[0].y + 18 * cssToWorld : Math.min(g[0].y, g[1].y) + 16 * cssToWorld;
    ctx.save();
    ctx.font = `600 ${fontWorld}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = color;
    // Shadow sizes are in output px (not transformed).
    ctx.shadowColor = "rgba(0,0,0,0.8)";
    ctx.shadowBlur = 4 * view.pxPerCss;
    lines.forEach((line, i) => {
      if (line) ctx.fillText(line, ax, ay + i * fontWorld * 1.2);
    });
    ctx.restore();
  }
}
