import { useEffect, useRef } from "react";
import type { DieAnnotations, Guide } from "shared";
import type { LiveValue } from "../../lib/liveValue";
import type { Point } from "../../lib/geometry";
import type { Viewport } from "../../renderer/types";
import { useDieViewerStore } from "../../state/dieViewer";
import { usePreferences } from "../../state/preferences";
import { orthoSegEnd } from "./useGuideTool";

/** Live geometry while dragging/duplicating selected guides. `hideIds` are
 *  committed guides to skip (the originals being moved; empty when duping). */
export type GuideDragPreview = { previews: Guide[]; hideIds: string[] };

const GUIDE = "#67e8f9"; // cyan — distinct from wires/cells/vias
const SEL = "#f3b351"; // selection accent
const PREVIEW = "rgba(103, 232, 249, 0.7)";

/**
 * Renders cell-grid guides (infinite lines / finite segments) plus the live
 * preview while a guide tool is active. Own canvas above the tiled canvas (no
 * tile-cache churn). Not in the rbush index — guides are infinite and managed
 * via the Items panel + Delete.
 */
export function GuidesOverlay({
  annotations,
  viewportStore,
  cursorStore,
  dragStore,
  segStart
}: {
  annotations: DieAnnotations | undefined;
  viewportStore: LiveValue<Viewport | null>;
  cursorStore: LiveValue<Point | null>;
  dragStore: LiveValue<GuideDragPreview | null>;
  segStart: Point | null;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const selectedIds = useDieViewerStore((s) => s.selectedIds);
  const activeTool = useDieViewerStore((s) => s.activeTool);
  const guideAxis = useDieViewerStore((s) => s.guideAxis);
  const hidden = usePreferences((s) => s.guidesHidden);
  const guides = annotations?.guides ?? [];

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
      const W = Math.max(1, Math.round(rect.width * dpr));
      const H = Math.max(1, Math.round(rect.height * dpr));
      if (canvas.width !== W || canvas.height !== H) {
        canvas.width = W;
        canvas.height = H;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, rect.width, rect.height);
      if (!vp) return;
      const sx = (x: number) => (x - vp.originX) * vp.zoom;
      const sy = (y: number) => (y - vp.originY) * vp.zoom;
      const strokeGuide = (g: Guide) => {
        ctx.beginPath();
        if (g.kind === "line") {
          if (g.axis === "x") {
            const X = sx(g.pos);
            ctx.moveTo(X, 0);
            ctx.lineTo(X, rect.height);
          } else {
            const Y = sy(g.pos);
            ctx.moveTo(0, Y);
            ctx.lineTo(rect.width, Y);
          }
        } else {
          ctx.moveTo(sx(g.x1), sy(g.y1));
          ctx.lineTo(sx(g.x2), sy(g.y2));
        }
        ctx.stroke();
      };

      const drag = dragStore.get();
      const hideIds = new Set(drag?.hideIds ?? []);

      // Committed guides (skipped while the layer is hidden, or while their
      // original is being dragged in a non-duplicating move).
      if (!hidden) {
        ctx.setLineDash([]);
        for (const g of guides) {
          if (hideIds.has(g.id)) continue;
          const sel = selectedIds.has(`guide:${g.id}`);
          ctx.strokeStyle = sel ? SEL : GUIDE;
          ctx.lineWidth = sel ? 2.5 : 1.5;
          strokeGuide(g);
        }
      }

      // Live drag / duplicate preview (always shown, even if hidden, so the
      // gesture is visible).
      if (drag) {
        ctx.setLineDash([]);
        ctx.strokeStyle = SEL;
        ctx.lineWidth = 2.5;
        for (const g of drag.previews) strokeGuide(g);
      }

      // ── Live preview ──────────────────────────────────────────────
      const cur = cursorStore.get();
      if (!cur) return;
      ctx.strokeStyle = PREVIEW;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 4]);
      if (activeTool === "cellGuideLine") {
        ctx.beginPath();
        if (guideAxis === "x") {
          const X = sx(cur.x);
          ctx.moveTo(X, 0);
          ctx.lineTo(X, rect.height);
        } else {
          const Y = sy(cur.y);
          ctx.moveTo(0, Y);
          ctx.lineTo(rect.width, Y);
        }
        ctx.stroke();
      } else if (activeTool === "cellGuideSeg" && segStart) {
        const end = orthoSegEnd(segStart, cur);
        ctx.beginPath();
        ctx.moveTo(sx(segStart.x), sy(segStart.y));
        ctx.lineTo(sx(end.x), sy(end.y));
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = PREVIEW;
        ctx.beginPath();
        ctx.arc(sx(segStart.x), sy(segStart.y), 3.5, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.setLineDash([]);
    };

    const schedule = () => {
      if (raf === 0) raf = requestAnimationFrame(draw);
    };

    draw();
    const unsubVp = viewportStore.subscribe(schedule);
    const unsubCur = cursorStore.subscribe(schedule);
    const unsubDrag = dragStore.subscribe(schedule);
    const ro = new ResizeObserver(schedule);
    ro.observe(canvas);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      unsubVp();
      unsubCur();
      unsubDrag();
      ro.disconnect();
    };
  }, [
    guides,
    selectedIds,
    activeTool,
    guideAxis,
    hidden,
    segStart,
    viewportStore,
    cursorStore,
    dragStore
  ]);

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
