import { netNodeScreenRadius } from "../../renderer/annotations/dieAnnotations";

/**
 * Shared "snapping to an existing net vertex" indicator (the single-wire look:
 * a translucent disc + ring sized to clear the rendered vertex at the current
 * zoom). Used by the wire and multi-wire overlays so snapping looks identical.
 */
export const NODE_RING_COLOR = "#2e97ff";
export const NODE_RING_FILL = "rgba(46, 151, 255, 0.25)";
const NODE_RING_MIN_PX = 10;
const NODE_RING_GAP_PX = 4;

/** Ring radius (screen px) — always outside the vertex, which scales with
 *  zoom and net width and would otherwise swallow a fixed-size halo. */
export function snapRingRadiusPx(zoom: number, netWidth: number): number {
  return Math.max(
    NODE_RING_MIN_PX,
    netNodeScreenRadius(zoom, netWidth) + NODE_RING_GAP_PX
  );
}

/** Accent for a *virtual* vertex (one that will be created by splitting an
 *  existing wire) — distinct from the "snap to an existing vertex" halo. */
export const VIRTUAL_RING_COLOR = "#3ddc97";

/** Draw the "a new vertex will be inserted here" marker: a dashed ring plus a
 *  small plus, so it reads as additive rather than "snapped onto existing". */
export function drawVirtualVertex(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  ringR: number
): void {
  ctx.save();
  ctx.strokeStyle = VIRTUAL_RING_COLOR;
  ctx.fillStyle = VIRTUAL_RING_COLOR;
  ctx.lineWidth = 2;
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.arc(x, y, ringR, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);
  const p = Math.max(3, ringR * 0.5);
  ctx.beginPath();
  ctx.moveTo(x - p, y);
  ctx.lineTo(x + p, y);
  ctx.moveTo(x, y - p);
  ctx.lineTo(x, y + p);
  ctx.stroke();
  ctx.restore();
}

/** Draw the snap halo at a screen point. */
export function drawSnapHalo(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  ringR: number
): void {
  ctx.beginPath();
  ctx.arc(x, y, ringR, 0, Math.PI * 2);
  ctx.fillStyle = NODE_RING_FILL;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = NODE_RING_COLOR;
  ctx.beginPath();
  ctx.arc(x, y, ringR, 0, Math.PI * 2);
  ctx.stroke();
}
