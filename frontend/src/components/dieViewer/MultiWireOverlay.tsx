import { useEffect, useRef } from "react";
import { distancePointToSegment, type Point } from "../../lib/geometry";
import type { LiveValue } from "../../lib/liveValue";
import type { Viewport } from "../../renderer/types";
import { usePreferences, selectNetWidth } from "../../state/preferences";
import { useSession } from "../../state/session";
import { drawSnapHalo, snapRingRadiusPx } from "./snapHalo";
import { previewEnds, tipOf, type Draft } from "./useMultiWireTool";

const COLOR = "#7fb2ff";
const DOT_PX = 3.5;

/**
 * Transient overlay for the multi-wire tool. Phase 1: the collected start
 * points. Phase 2: each wire's committed path (start → turns → via end), the
 * corners already clicked in the current turn round, and — for wires still
 * waiting for their corner — the live parallel segment toward the cursor,
 * the one the next click places drawn thicker (nets are created on Enter /
 * double-click). Own canvas above the tiled canvas (no tile-cache churn).
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
  draft,
  cursorStore,
  snapStore,
  endSnapStore,
  shiftStore,
  viewportStore
}: {
  points: Point[];
  phase: 1 | 2;
  /** Full multi-wire draft (paths, pending corners, round direction). */
  draft: Draft;
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
            snapRingRadiusPx(vp.zoom, selectNetWidth(useSession.getState().dieId)(usePreferences.getState()))
          );
        }
      }
      if (points.length === 0) return;

      ctx.strokeStyle = COLOR;
      ctx.fillStyle = COLOR;
      ctx.lineCap = "round";

      const ringR = () =>
        snapRingRadiusPx(vp.zoom, selectNetWidth(useSession.getState().dieId)(usePreferences.getState()));
      const dot = (p: Point) => {
        ctx.beginPath();
        ctx.arc(sx(p.x), sy(p.y), DOT_PX, 0, Math.PI * 2);
        ctx.fill();
      };
      const seg = (a: Point, b: Point) => {
        ctx.beginPath();
        ctx.moveTo(sx(a.x), sy(a.y));
        ctx.lineTo(sx(b.x), sy(b.y));
        ctx.stroke();
      };

      // Live ends of the wires still waiting for their corner (null for the
      // rest) — the very projection a click uses, so preview == result.
      const cur = phase === 2 ? cursorStore.get() : null;
      const live = cur ? previewEnds(draft, cur, shiftStore.get() ?? false) : points.map(() => null);
      // The waiting wire the next click would place (nearest to the cursor).
      let next = -1;
      if (cur) {
        let bestDist = Infinity;
        live.forEach((end, i) => {
          if (!end) return;
          const d = distancePointToSegment(cur, tipOf(draft, i), end);
          if (d < bestDist) {
            bestDist = d;
            next = i;
          }
        });
      }

      // Phase-2 via snaps: each waiting wire that would end on a via.
      const endSnaps = phase === 2 ? endSnapStore.get() : null;
      const snapByIndex = new Map<number, MultiWireEndSnap>();
      if (endSnaps) for (const s of endSnaps) snapByIndex.set(s.lockIndex, s);

      points.forEach((p, i) => {
        if (phase === 2) {
          // Committed path.
          ctx.lineWidth = 2;
          let prev: Point = p;
          for (const v of draft.paths[i] ?? []) {
            seg(prev, v);
            dot(v);
            prev = v;
          }
          // Corner clicked in this round.
          const corner = draft.pending[i];
          if (corner) {
            seg(prev, corner);
            dot(corner);
          }
          // Live segment of a waiting wire. One that would snap to a via
          // previews ending ON it — exactly what a click does.
          const hit = snapByIndex.get(i);
          const end = hit ? { x: hit.x, y: hit.y } : live[i];
          if (end && !draft.locked[i] && !corner) {
            const emphasised = !!hit || i === next;
            ctx.lineWidth = emphasised ? 3.5 : 2;
            ctx.globalAlpha = emphasised ? 1 : 0.55;
            seg(prev, end);
            ctx.globalAlpha = 1;
            if (hit) {
              drawSnapHalo(ctx, sx(end.x), sy(end.y), ringR());
              ctx.fillStyle = COLOR;
              ctx.strokeStyle = COLOR;
            }
          }
        }
        dot(p);
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
    draft,
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
