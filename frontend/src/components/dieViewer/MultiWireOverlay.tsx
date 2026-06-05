import { useEffect, useRef } from "react";
import { distancePointToSegment, type Point } from "../../lib/geometry";
import type { LiveValue } from "../../lib/liveValue";
import type { Viewport } from "../../renderer/types";
import { usePreferences } from "../../state/preferences";
import { drawSnapHalo, snapRingRadiusPx } from "./snapHalo";
import { multiParallelEnd, multiWireEndpoint } from "./useMultiWireTool";

const COLOR = "#7fb2ff";
const DOT_PX = 3.5;

/**
 * Transient overlay for the multi-wire tool. Phase 1: the collected start
 * points. Phase 2: a parallel 45°-snapped segment swept out of every start
 * point toward the cursor (the actual nets are created on click). Own canvas
 * above the tiled canvas (no tile-cache churn).
 */
/** Phase-2 endpoint snap: which sweeping wire would lock onto a via, and
 *  the via's position. Drives the overlay to redraw that wire ending on the
 *  via instead of the swept 45° endpoint. */
export interface MultiWireEndSnap {
  lockIndex: number;
  x: number;
  y: number;
}

export function MultiWireOverlay({
  points,
  phase,
  ends,
  cursorStore,
  snapStore,
  endSnapStore,
  shiftStore,
  viewportStore
}: {
  points: Point[];
  phase: 1 | 2;
  /** Phase-2: locked endpoint per start (null = still sweeping). */
  ends: (Point | null)[];
  cursorStore: LiveValue<Point | null>;
  /** Phase-1 hover: the existing vertex the next start would snap to. */
  snapStore: LiveValue<Point | null>;
  /** Phase-2 hover: every sweeping wire that would snap to a via on click.
   *  Snap-to-vias-near-cursor contributes at most one entry; auto-end-on-via
   *  can contribute one per wire whose projected line crosses a via. */
  endSnapStore: LiveValue<MultiWireEndSnap[] | null>;
  /** Shift held → unconstrained (free-angle) bus. */
  shiftStore: LiveValue<boolean>;
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
      const sx = (x: number) => (x - vp.originX) * vp.zoom;
      const sy = (y: number) => (y - vp.originY) * vp.zoom;

      // Phase-1 snap indicator (matches the single-wire halo) — shown even
      // before the first start point is placed.
      if (phase === 1) {
        const snap = snapStore.get();
        if (snap) {
          drawSnapHalo(
            ctx,
            sx(snap.x),
            sy(snap.y),
            snapRingRadiusPx(vp.zoom, usePreferences.getState().netWidth)
          );
        }
      }
      if (points.length === 0) return;

      ctx.strokeStyle = COLOR;
      ctx.fillStyle = COLOR;
      ctx.lineCap = "round";

      // Reference bus endpoint from the live cursor (Shift = free angle).
      // Every wire ends on the front line perpendicular to the bus direction
      // through this point, so staggered starts still finish aligned.
      const cur = phase === 2 ? cursorStore.get() : null;
      const busEnd = cur
        ? multiParallelEnd(points[0], cur, shiftStore.get() ?? false)
        : null;
      const sweeping =
        !!busEnd && (busEnd.x !== points[0].x || busEnd.y !== points[0].y);

      // The still-sweeping wire nearest the cursor — the one a click locks.
      let nearest = -1;
      if (cur && busEnd && sweeping) {
        let bestDist = Infinity;
        points.forEach((p, i) => {
          if (ends[i]) return;
          const d = distancePointToSegment(
            cur,
            p,
            multiWireEndpoint(p, points[0], busEnd)
          );
          if (d < bestDist) {
            bestDist = d;
            nearest = i;
          }
        });
      }

      // Phase-2 via snaps: each sweeping wire that would lock onto a via.
      const endSnaps = phase === 2 ? endSnapStore.get() : null;
      const snapByIndex = new Map<number, MultiWireEndSnap>();
      if (endSnaps) for (const s of endSnaps) snapByIndex.set(s.lockIndex, s);

      points.forEach((p, i) => {
        const a = { x: sx(p.x), y: sy(p.y) };
        if (phase === 2) {
          const locked = ends[i];
          // A still-sweeping wire that would snap to a via ends ON the
          // via, not at the swept 45° endpoint — so the preview shows
          // exactly what a click commits.
          const hit = !locked ? snapByIndex.get(i) : undefined;
          const snapVia = hit ? { x: hit.x, y: hit.y } : null;
          const end =
            locked ??
            snapVia ??
            (sweeping && busEnd
              ? multiWireEndpoint(p, points[0], busEnd)
              : null);
          if (end) {
            const b = { x: sx(end.x), y: sy(end.y) };
            ctx.lineWidth = !locked && (snapVia || i === nearest) ? 3.5 : 2;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
            ctx.beginPath();
            ctx.arc(b.x, b.y, DOT_PX, 0, Math.PI * 2);
            ctx.fill();
            if (snapVia) {
              drawSnapHalo(
                ctx,
                b.x,
                b.y,
                snapRingRadiusPx(vp.zoom, usePreferences.getState().netWidth)
              );
              ctx.fillStyle = COLOR;
              ctx.strokeStyle = COLOR;
            }
          }
        }
        ctx.beginPath();
        ctx.arc(a.x, a.y, DOT_PX, 0, Math.PI * 2);
        ctx.fill();
      });
    };

    const schedule = () => {
      if (raf === 0) raf = requestAnimationFrame(draw);
    };

    draw();
    const unsubVp = viewportStore.subscribe(schedule);
    const unsubCur = cursorStore.subscribe(schedule);
    const unsubSnap = snapStore.subscribe(schedule);
    const unsubEndSnap = endSnapStore.subscribe(schedule);
    const unsubShift = shiftStore.subscribe(schedule);
    const ro = new ResizeObserver(schedule);
    ro.observe(canvas);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      unsubVp();
      unsubCur();
      unsubSnap();
      unsubEndSnap();
      unsubShift();
      ro.disconnect();
    };
  }, [
    points,
    phase,
    ends,
    cursorStore,
    snapStore,
    endSnapStore,
    shiftStore,
    viewportStore
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
