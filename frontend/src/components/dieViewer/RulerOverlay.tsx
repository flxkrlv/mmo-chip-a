import { useEffect, useRef } from "react";
import type { LiveValue } from "../../lib/liveValue";
import type { Viewport } from "../../renderer/types";

/** In-progress or committed ruler measurement. */
export interface RulerDraft {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/**
 * Transient overlay for measure tool — draws ruler lines with dimension
 * labels on an absolutely-positioned canvas above the tiled canvas.
 */
export function RulerOverlay({
  draftStore,
  pendingStore,
  viewportStore,
  /** µm per pixel (0 = scale not set → show px only). */
  umPerPx = 0
}: {
  draftStore: LiveValue<RulerDraft | null>;
  pendingStore: LiveValue<RulerDraft | null>;
  viewportStore: LiveValue<Viewport | null>;
  umPerPx?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const draw = () => {
      const parent = canvas.parentElement;
      if (!parent) return;
      const w = parent.clientWidth;
      const h = parent.clientHeight;
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        canvas.style.width = w + "px";
        canvas.style.height = h + "px";
      }

      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const draft = pendingStore.get() ?? draftStore.get();
      const vp = viewportStore.get();
      if (!draft || !vp) {
        ctx.clearRect(0, 0, w, h);
        return;
      }

      ctx.clearRect(0, 0, w, h);

      // Transform screen coords from world coords.
      const worldToScreen = (wx: number, wy: number) => ({
        x: (wx - vp.originX) * vp.zoom,
        y: (wy - vp.originY) * vp.zoom
      });

      const p1 = worldToScreen(draft.x1, draft.y1);
      const p2 = worldToScreen(draft.x2, draft.y2);

      // Compute pixel length.
      const dx = draft.x2 - draft.x1;
      const dy = draft.y2 - draft.y1;
      const lengthPx = Math.sqrt(dx * dx + dy * dy);

      // Draw line.
      ctx.save();
      ctx.strokeStyle = "#ffd966";
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();
      ctx.setLineDash([]);

      // Draw endpoint circles.
      ctx.fillStyle = "#ffd966";
      ctx.beginPath();
      ctx.arc(p1.x, p1.y, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(p2.x, p2.y, 4, 0, Math.PI * 2);
      ctx.fill();

      // Draw label.
      const midX = (p1.x + p2.x) / 2;
      const midY = (p1.y + p2.y) / 2;
      const labelPx = `${Math.round(lengthPx).toLocaleString()} px`;
      const labelUm =
        umPerPx > 0
          ? `  (${(lengthPx * umPerPx).toFixed(1)} µm)`
          : "";

      ctx.font = "11px var(--mono, monospace)";
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      const label = labelPx + labelUm;
      const textWidth = ctx.measureText(label).width;

      // Background rect.
      const bgX = midX - textWidth / 2 - 6;
      const bgY = midY - 18;
      ctx.fillStyle = "rgba(0,0,0,0.75)";
      ctx.fillRect(bgX, bgY, textWidth + 12, 20);

      // Label text.
      ctx.fillStyle = "#ffd966";
      ctx.textBaseline = "bottom";
      ctx.fillText(label, midX, midY - 1);

      // Distance annotation along the line (offset slightly).
      ctx.textBaseline = "top";
      ctx.fillText(
        label,
        midX,
        midY + 4
      );

      ctx.restore();
    };

    // Subscribe to changes.
    const unsub1 = draftStore.subscribe(draw);
    const unsub2 = pendingStore.subscribe(draw);
    const unsub3 = viewportStore.subscribe(draw);

    return () => {
      unsub1();
      unsub2();
      unsub3();
    };
  }, [draftStore, pendingStore, viewportStore, umPerPx]);

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
        zIndex: 20
      }}
    />
  );
}
