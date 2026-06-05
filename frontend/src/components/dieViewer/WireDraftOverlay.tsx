import { useEffect, useRef } from "react";
import type { Point } from "../../lib/geometry";
import type { LiveValue } from "../../lib/liveValue";
import type { Viewport } from "../../renderer/types";
import { usePreferences } from "../../state/preferences";
import { drawSnapHalo, drawVirtualVertex, snapRingRadiusPx } from "./snapHalo";
import type { WireSnap } from "./useWireTool";

const DRAFT_COLOR = "#7fb2ff";
const POINT_RADIUS_PX = 4;

/** Preview endpoint of the rubber-band; `onNode` when snapped to an existing
 *  vertex, `onVia` when snapped to a via (ML or manual) — either draws the
 *  snap halo. `elbow` is the corner of the orthogonal L-route used when
 *  connecting into a vertex. */
export type WirePreview = {
  x: number;
  y: number;
  onNode: boolean;
  onVia?: boolean;
  elbow?: Point;
};

/**
 * Transient overlay for the in-progress wire being drawn. Lives on its own
 * absolutely-positioned canvas above the tiled canvas so updating it never
 * touches the tile cache. Redraws on viewport / preview changes (both
 * rAF-coalesced LiveValues) and whenever the committed draft points change
 * (the effect re-runs — clicks are infrequent).
 */
export function WireDraftOverlay({
  points,
  anchored,
  previewStore,
  startSnapStore,
  viewportStore
}: {
  points: Point[];
  /** True when the draft started on an existing or virtual vertex. */
  anchored: boolean;
  previewStore: LiveValue<WirePreview | null>;
  /** Pre-start hover (only meaningful before the first point): the vertex a
   *  click would start on, real or virtual (a wire-body split). */
  startSnapStore: LiveValue<WireSnap | null>;
  viewportStore: LiveValue<Viewport | null>;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    const draw = () => {
      raf = 0;
      const vp = viewportStore.get();
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      const w = Math.max(1, Math.round(rect.width * dpr));
      const h = Math.max(1, Math.round(rect.height * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, rect.width, rect.height);

      if (!vp) return;

      const toScreen = (p: Point) => ({
        x: (p.x - vp.originX) * vp.zoom,
        y: (p.y - vp.originY) * vp.zoom
      });

      // Before the first point is placed, show what a click would start on:
      // an existing vertex (solid halo) or a virtual vertex that will split a
      // wire body (dashed + plus).
      if (points.length === 0) {
        const snap = startSnapStore.get();
        if (snap) {
          const s = toScreen(snap);
          const r = snapRingRadiusPx(
            vp.zoom,
            usePreferences.getState().netWidth
          );
          // A via snap (or an existing vertex) → solid halo; an edge-body
          // split → the dashed "new vertex" marker.
          if (snap.virtual && !snap.via) drawVirtualVertex(ctx, s.x, s.y, r);
          else drawSnapHalo(ctx, s.x, s.y, r);
        }
        return;
      }

      const preview = previewStore.get();

      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.strokeStyle = DRAFT_COLOR;
      ctx.fillStyle = DRAFT_COLOR;

      // Committed segments (solid).
      ctx.lineWidth = 2;
      ctx.beginPath();
      const first = toScreen(points[0]);
      ctx.moveTo(first.x, first.y);
      for (let i = 1; i < points.length; i++) {
        const s = toScreen(points[i]);
        ctx.lineTo(s.x, s.y);
      }
      ctx.stroke();

      // Rubber-band to the (snapped) cursor (dashed). When connecting into a
      // vertex it routes through an orthogonal elbow.
      if (preview) {
        const last = toScreen(points[points.length - 1]);
        const pv = toScreen(preview);
        ctx.save();
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(last.x, last.y);
        if (preview.elbow) {
          const e = toScreen(preview.elbow);
          ctx.lineTo(e.x, e.y);
        }
        ctx.lineTo(pv.x, pv.y);
        ctx.stroke();
        ctx.restore();
      }

      // Vertex handles.
      for (const p of points) {
        const s = toScreen(p);
        ctx.beginPath();
        ctx.arc(s.x, s.y, POINT_RADIUS_PX, 0, Math.PI * 2);
        ctx.fill();
      }
      if (preview) {
        const pv = toScreen(preview);
        ctx.beginPath();
        ctx.arc(pv.x, pv.y, POINT_RADIUS_PX, 0, Math.PI * 2);
        ctx.fill();
      }

      // Snap indicator — start (anchor) and end. Drawn when the endpoint
      // snapped to an existing net vertex (`onNode`) or to a via (`onVia`),
      // matching the multi-wire overlay. Sized to clear the rendered vertex
      // at the current zoom/width.
      const netWidth = usePreferences.getState().netWidth;
      const ringR = snapRingRadiusPx(vp.zoom, netWidth);
      const ring = (s: { x: number; y: number }) =>
        drawSnapHalo(ctx, s.x, s.y, ringR);
      if (anchored) ring(toScreen(points[0]));
      if (preview?.onNode || preview?.onVia) ring(toScreen(preview));
    };

    const schedule = () => {
      if (raf === 0) raf = requestAnimationFrame(draw);
    };

    draw();
    const unsubVp = viewportStore.subscribe(schedule);
    const unsubPv = previewStore.subscribe(schedule);
    const unsubSnap = startSnapStore.subscribe(schedule);
    const ro = new ResizeObserver(schedule);
    ro.observe(canvas);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      unsubVp();
      unsubPv();
      unsubSnap();
      ro.disconnect();
    };
  }, [points, anchored, previewStore, startSnapStore, viewportStore]);

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        pointerEvents: "none"
      }}
    />
  );
}
