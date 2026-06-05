import { useEffect, useRef } from "react";
import { withAlpha } from "../../lib/color";
import { normalizeRect, type Rect } from "../../lib/geometry";
import type { LiveValue } from "../../lib/liveValue";
import type { Viewport } from "../../renderer/types";

/**
 * Transient rubber-band rectangle for any rect-drawing tool (cell / via-rect /
 * ROI / ignore). Lives on its own absolutely-positioned canvas above the tiled
 * canvas so updating it never touches the tile cache. Redraws on viewport /
 * rect changes (both rAF-coalesced LiveValues). `color` matches the committed
 * entity so the preview reads as what you're about to create.
 */
/** Visual handle size in CSS px — matches `SelectionHandlesOverlay`. */
const HANDLE_PX = 10;

export function RectDraftOverlay({
  rectStore,
  viewportStore,
  color,
  handles = false
}: {
  rectStore: LiveValue<Rect | null>;
  viewportStore: LiveValue<Viewport | null>;
  color: string;
  /** Render grab handles at the four corners so the draft reads as editable
   *  (used by the addCell tool while waiting for Enter to confirm). */
  handles?: boolean;
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
      const rectW = rectStore.get();
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
      if (!vp || !rectW) return;

      const n = normalizeRect(rectW);
      const tlx = (n.x - vp.originX) * vp.zoom;
      const tly = (n.y - vp.originY) * vp.zoom;
      const sw = n.width * vp.zoom;
      const sh = n.height * vp.zoom;

      ctx.strokeStyle = color;
      ctx.fillStyle = withAlpha(color, 0.1);
      ctx.lineWidth = 2;
      ctx.setLineDash([]);
      ctx.fillRect(tlx, tly, sw, sh);
      ctx.strokeRect(tlx, tly, sw, sh);

      if (handles) {
        // Filled-white grab squares at each corner — same look as the
        // selection handles, so the rect reads as editable.
        ctx.fillStyle = "#fff";
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        const corners: [number, number][] = [
          [tlx, tly],
          [tlx + sw, tly],
          [tlx + sw, tly + sh],
          [tlx, tly + sh]
        ];
        for (const [hx, hy] of corners) {
          ctx.beginPath();
          ctx.rect(hx - HANDLE_PX / 2, hy - HANDLE_PX / 2, HANDLE_PX, HANDLE_PX);
          ctx.fill();
          ctx.stroke();
        }
      }
    };

    const schedule = () => {
      if (raf === 0) raf = requestAnimationFrame(draw);
    };

    draw();
    const unsubVp = viewportStore.subscribe(schedule);
    const unsubRect = rectStore.subscribe(schedule);
    const ro = new ResizeObserver(schedule);
    ro.observe(canvas);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      unsubVp();
      unsubRect();
      ro.disconnect();
    };
  }, [rectStore, viewportStore, color, handles]);

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
