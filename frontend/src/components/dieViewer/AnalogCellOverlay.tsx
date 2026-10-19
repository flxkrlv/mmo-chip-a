import { useEffect, useRef } from "react";
import type { LiveValue } from "../../lib/liveValue";
import { analogFootprint } from "../../lib/analogPlacement";
import { rectCornerPoints } from "../../lib/libraryPlacement";
import { drawCellLayers } from "../../renderer/annotations/shapes";
import type { TileBounds, Viewport } from "../../renderer/types";
import type { AnalogCellTool } from "./useAnalogCellTool";

/** Visual handle size in CSS px — matches the other editable overlays. */
const HANDLE_PX = 10;
const COLOR = "#8fe3b0";

/**
 * The analog-library device template: the generated device drawn where the
 * draft sits — stretched and turned as fitted — with a dashed footprint,
 * corner handles and a name / scale tag. Its own canvas above the tiled
 * one, redrawn on draft / viewport changes.
 */
export function AnalogCellOverlay({
  tool,
  viewportStore
}: {
  tool: AnalogCellTool;
  viewportStore: LiveValue<Viewport | null>;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { draftLive, layout, scale } = tool;

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    let raf = 0;
    const schedule = () => {
      if (raf === 0) raf = requestAnimationFrame(draw);
    };
    function draw() {
      raf = 0;
      if (!canvas || !ctx) return;
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      const cw = Math.max(1, Math.round(rect.width * dpr));
      const ch = Math.max(1, Math.round(rect.height * dpr));
      if (canvas.width !== cw || canvas.height !== ch) {
        canvas.width = cw;
        canvas.height = ch;
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, cw, ch);
      const d = draftLive.get();
      const vp = viewportStore.get();
      if (!d || !vp || layout.cropRect.width === 0) return;
      const w = layout.cropRect.width;
      const h = layout.cropRect.height;

      // Die → device pixels, then the placed cell's frame (as the die
      // renderer draws cells), then the generated device's own units.
      ctx.setTransform(dpr * vp.zoom, 0, 0, dpr * vp.zoom, -vp.originX * vp.zoom * dpr, -vp.originY * vp.zoom * dpr);
      ctx.save();
      const boxW = w * d.k;
      const boxH = h * d.k;
      ctx.translate(d.cx, d.cy);
      ctx.rotate((d.rotation * Math.PI) / 180);
      ctx.scale(d.flippedH ? -1 : 1, d.flippedV ? -1 : 1);
      ctx.translate(-boxW / 2, -boxH / 2);
      // The stretch: the device is drawn bigger, exactly as it will be
      // placed (the placed cell is laid out at the stretched scale).
      ctx.scale(d.k, d.k);
      ctx.fillStyle = "rgba(143,227,176,0.10)";
      ctx.fillRect(0, 0, w, h);
      const bounds: TileBounds = {
        size: 0,
        i: 0,
        j: 0,
        world: { x: 0, y: 0, width: 0, height: 0 },
        dpr,
        zoom: vp.zoom * d.k
      };
      drawCellLayers(ctx, layout.layers, bounds, { outline: true });
      // Orientation mark: the device's own top-left corner.
      const m = Math.min(w, h) * 0.18;
      ctx.fillStyle = COLOR;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(m, 0);
      ctx.lineTo(0, m);
      ctx.closePath();
      ctx.fill();
      ctx.restore();

      // Footprint, handles and tag in screen space.
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const fp = analogFootprint(d, w, h);
      const sx = (fp.x - vp.originX) * vp.zoom;
      const sy = (fp.y - vp.originY) * vp.zoom;
      const sw = fp.width * vp.zoom;
      const sh = fp.height * vp.zoom;
      ctx.strokeStyle = COLOR;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(sx, sy, sw, sh);
      ctx.setLineDash([]);
      ctx.fillStyle = "#fff";
      for (const c of rectCornerPoints({ x: sx, y: sy, width: sw, height: sh })) {
        ctx.beginPath();
        ctx.rect(c.x - HANDLE_PX / 2, c.y - HANDLE_PX / 2, HANDLE_PX, HANDLE_PX);
        ctx.fill();
        ctx.stroke();
      }
      const tag = `${layout.summary} · ×${d.k.toFixed(3)} · ${scale.toFixed(2)} px/µm`;
      ctx.font = "500 11px ui-monospace, SFMono-Regular, Menlo, monospace";
      const tw = ctx.measureText(tag).width + 10;
      const ty = sy - 24 < 0 ? sy + sh + 6 : sy - 24;
      ctx.fillStyle = "rgba(20,24,32,0.85)";
      ctx.fillRect(sx, ty, tw, 18);
      ctx.fillStyle = COLOR;
      ctx.fillText(tag, sx + 5, ty + 13);
    }

    draw();
    const unsubDraft = draftLive.subscribe(schedule);
    const unsubVp = viewportStore.subscribe(schedule);
    const ro = new ResizeObserver(schedule);
    ro.observe(canvas);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      unsubDraft();
      unsubVp();
      ro.disconnect();
    };
  }, [draftLive, viewportStore, layout, scale]);

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
