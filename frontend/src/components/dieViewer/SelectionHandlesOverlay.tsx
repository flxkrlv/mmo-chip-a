import { useEffect, useRef } from "react";
import type { DieAnnotations } from "shared";
import type { LiveValue } from "../../lib/liveValue";
import type { Viewport } from "../../renderer/types";
import { useDieViewerStore } from "../../state/dieViewer";
import { rectCorners, type Point } from "../../lib/geometry";
import { resolveEditable, type EditPreview } from "./shapeEdit";

const HANDLE_PX = 10;
const COLOR = "#f3b351"; // selection accent

/**
 * Draws grab handles (corner squares for rect-like entities, vertex squares
 * for polygons) on the single selected editable ML shape. While a drag is in
 * progress the handles track the cursor via `previewStore` (the live geometry
 * pushed by `shapeDragHandler`); otherwise they sit on the committed shape.
 */
export function SelectionHandlesOverlay({
  annotations,
  viewportStore,
  previewStore
}: {
  annotations: DieAnnotations | undefined;
  viewportStore: LiveValue<Viewport | null>;
  previewStore: LiveValue<EditPreview | null>;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const selectedIds = useDieViewerStore((s) => s.selectedIds);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const only =
      selectedIds.size === 1
        ? (selectedIds.values().next().value as string)
        : null;
    const committed = only && annotations ? resolveEditable(only, annotations) : null;

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

      // Live drag geometry wins; otherwise the committed selected shape.
      const pv = previewStore.get();
      let pts: Point[] | null = null;
      if (pv) {
        pts = pv.kind === "rect" ? rectCorners(pv.rect) : pv.points;
      } else if (committed) {
        pts =
          committed.kind === "rect"
            ? rectCorners(committed.rect)
            : committed.points;
      }
      if (!pts) return;

      ctx.fillStyle = "#fff";
      ctx.strokeStyle = COLOR;
      ctx.lineWidth = 1.5;
      for (const p of pts) {
        const sx = (p.x - vp.originX) * vp.zoom;
        const sy = (p.y - vp.originY) * vp.zoom;
        ctx.beginPath();
        ctx.rect(sx - HANDLE_PX / 2, sy - HANDLE_PX / 2, HANDLE_PX, HANDLE_PX);
        ctx.fill();
        ctx.stroke();
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
  }, [annotations, selectedIds, viewportStore, previewStore]);

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
