import { useEffect, useRef } from "react";
import type { Point } from "../../lib/geometry";
import type { LiveValue } from "../../lib/liveValue";
import type { Viewport } from "../../renderer/types";

const COLOR = "#82d6a6"; // via green (hex so it reads on dark imagery)
const POINT_RADIUS_PX = 3.5;

/**
 * Transient overlay for the in-progress via polygon. Own canvas above the
 * tiled canvas (no tile-cache churn). Redraws on viewport changes and when
 * the committed points change (clicks are infrequent → effect re-run is fine).
 */
export function PolyDraftOverlay({
  points,
  previewStore,
  viewportStore
}: {
  points: Point[];
  /** Live cursor world position for the rubber-band preview (null = idle). */
  previewStore: LiveValue<Point | null>;
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
      if (!vp || points.length === 0) return;

      const toS = (p: Point) => ({
        x: (p.x - vp.originX) * vp.zoom,
        y: (p.y - vp.originY) * vp.zoom
      });

      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.strokeStyle = COLOR;
      ctx.fillStyle = "rgba(130, 214, 166, 0.12)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      const s0 = toS(points[0]);
      ctx.moveTo(s0.x, s0.y);
      for (let i = 1; i < points.length; i++) {
        const s = toS(points[i]);
        ctx.lineTo(s.x, s.y);
      }
      if (points.length >= 3) {
        ctx.closePath();
        ctx.fill();
      }
      ctx.stroke();

      ctx.fillStyle = COLOR;
      for (const p of points) {
        const s = toS(p);
        ctx.beginPath();
        ctx.arc(s.x, s.y, POINT_RADIUS_PX, 0, Math.PI * 2);
        ctx.fill();
      }

      // Rubber-band from the last point to the cursor (and a faint closing
      // segment back to the first point) so the next edge is previewed.
      const cur = previewStore.get();
      if (cur) {
        const last = toS(points[points.length - 1]);
        const c = toS(cur);
        ctx.strokeStyle = COLOR;
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(last.x, last.y);
        ctx.lineTo(c.x, c.y);
        ctx.stroke();
        if (points.length >= 2) {
          const first = toS(points[0]);
          ctx.globalAlpha = 0.5;
          ctx.beginPath();
          ctx.moveTo(c.x, c.y);
          ctx.lineTo(first.x, first.y);
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
        ctx.setLineDash([]);
        ctx.fillStyle = COLOR;
        ctx.beginPath();
        ctx.arc(c.x, c.y, POINT_RADIUS_PX, 0, Math.PI * 2);
        ctx.fill();
      }
    };

    const schedule = () => {
      if (raf === 0) raf = requestAnimationFrame(draw);
    };

    draw();
    const unsubVp = viewportStore.subscribe(schedule);
    const unsubPv = previewStore.subscribe(schedule);
    const ro = new ResizeObserver(schedule);
    ro.observe(canvas);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      unsubVp();
      unsubPv();
      ro.disconnect();
    };
  }, [points, previewStore, viewportStore]);

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
