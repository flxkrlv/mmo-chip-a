/**
 * FloorplanEditHandles.tsx — geometry editing for an already-drawn floorplan
 * region (the one in `editingRegionId`: selecting a region starts editing).
 *
 * Rect:    drag a corner / edge handle to resize, drag the outline to move.
 * Polygon: drag a vertex to move it, drag an edge midpoint to insert a new
 *          vertex there, double-click a vertex to delete it (min 3), drag the
 *          outline to move the whole polygon.
 * Esc cancels an in-progress drag; otherwise it stops editing, as does a
 * click anywhere outside the handles / popover.
 *
 * Everything carrying `data-fp-edit` is exempt from the popover's
 * click-outside close, so the popover stays open while reshaping.
 */

import { useEffect, useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import type { FloorplanRegion } from "shared";
import type { Viewport } from "../../renderer/types";
import {
  RECT_HANDLES,
  deleteVertex,
  dragRectHandle,
  edgeMidpoints,
  insertVertex,
  isDegenerate,
  isPolyRegion,
  moveVertex,
  rectBounds,
  rectHandlePoint,
  roundGeometry,
  translateGeometry,
  type Pt,
  type RectHandle
} from "../../lib/floorplanEdit";
import { useFloorplanStore } from "../../state/floorplan";

const HANDLE_PX = 9;
const MID_R_PX = 4;
/** Invisible stroke width of the outline "move" hit area. */
const MOVE_HIT_PX = 10;

const RECT_CURSOR: Record<RectHandle, string> = {
  nw: "nwse-resize",
  se: "nwse-resize",
  ne: "nesw-resize",
  sw: "nesw-resize",
  n: "ns-resize",
  s: "ns-resize",
  e: "ew-resize",
  w: "ew-resize"
};

interface Props {
  region: FloorplanRegion;
  viewport: Viewport;
  /** Geometry to draw while a drag is in progress (null = committed). */
  live: Pt[] | null;
  setLive: (geometry: Pt[] | null) => void;
  /** Persist the edited region; resolves/rejects with the save. */
  onCommit: (updated: FloorplanRegion) => void;
}

export function FloorplanEditHandles({ region, viewport, live, setLive, onCommit }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const setEditingRegion = useFloorplanStore((s) => s.setEditingRegion);
  const openRegion = useFloorplanStore((s) => s.openRegion);
  const selectRegion = useFloorplanStore((s) => s.selectRegion);

  const geometry = live ?? region.geometry;
  const isPoly = isPolyRegion(region);

  // Esc / click-away ends editing (an in-progress drag handles its own Esc).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !dragCleanupRef.current) setEditingRegion(null);
    };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (t?.closest?.("[data-fp-edit], [data-fp-popover]")) return;
      setEditingRegion(null);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown, true);
    };
  }, [setEditingRegion]);

  // Abort a drag if the component goes away mid-gesture.
  useEffect(() => () => dragCleanupRef.current?.(), []);

  const toWorld = (clientX: number, clientY: number): Pt => {
    const rect = svgRef.current!.getBoundingClientRect();
    const v = viewportRef.current;
    return {
      x: (clientX - rect.left) / v.zoom + v.originX,
      y: (clientY - rect.top) / v.zoom + v.originY
    };
  };

  /**
   * Generic drag: `compute(start, current)` maps pointer positions to the new
   * geometry (from the committed geometry at drag start). Commits on release
   * only if something changed; Esc restores.
   */
  const startDrag = (
    e: ReactPointerEvent,
    compute: (start: Pt, current: Pt) => Pt[],
    initial?: Pt[]
  ) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    dragCleanupRef.current?.();
    const start = toWorld(e.clientX, e.clientY);
    let latest: Pt[] | null = initial ?? null;
    if (initial) setLive(initial);

    const onMove = (ev: PointerEvent) => {
      latest = compute(start, toWorld(ev.clientX, ev.clientY));
      setLive(latest);
    };
    const onUp = () => {
      cleanup();
      if (!latest) {
        setLive(null);
        return;
      }
      const next = roundGeometry(latest);
      const same =
        next.length === region.geometry.length &&
        next.every((p, i) => p.x === region.geometry[i].x && p.y === region.geometry[i].y);
      if (same || isDegenerate(region, next)) {
        setLive(null);
        return;
      }
      onCommit({ ...region, geometry: next });
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      ev.stopPropagation();
      cleanup();
      setLive(null);
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      window.removeEventListener("keydown", onKey, true);
      dragCleanupRef.current = null;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    window.addEventListener("keydown", onKey, true);
    dragCleanupRef.current = cleanup;
  };

  const base = region.geometry;
  const toCss = (p: Pt) => ({
    x: (p.x - viewport.originX) * viewport.zoom,
    y: (p.y - viewport.originY) * viewport.zoom
  });

  const moveHandler = (e: ReactPointerEvent) =>
    startDrag(e, (s, c) => translateGeometry(base, c.x - s.x, c.y - s.y));

  // Outline hit area: drag to move; double-click opens the window, Shift+click
  // removes the region from the selection (this stroke sits on top of the
  // region's own outline, which would otherwise handle those).
  const outlineProps = {
    "data-fp-edit": true,
    fill: "none",
    stroke: "transparent",
    strokeWidth: MOVE_HIT_PX,
    style: { pointerEvents: "stroke" as const, cursor: "move" },
    onPointerDown: moveHandler,
    onClick: (e: React.MouseEvent) => {
      if (e.shiftKey) selectRegion(region.id, "toggle");
    },
    onDoubleClick: (e: React.MouseEvent) => {
      e.stopPropagation();
      openRegion(region.id, e.shiftKey);
    }
  };

  const square = (p: Pt, key: string, cursor: string, onPointerDown: (e: ReactPointerEvent) => void, onDoubleClick?: () => void) => {
    const c = toCss(p);
    return (
      <rect
        key={key}
        data-fp-edit
        x={c.x - HANDLE_PX / 2}
        y={c.y - HANDLE_PX / 2}
        width={HANDLE_PX}
        height={HANDLE_PX}
        fill="#fff"
        stroke="#222"
        strokeWidth={1.2}
        style={{ pointerEvents: "auto", cursor }}
        onPointerDown={onPointerDown}
        onDoubleClick={onDoubleClick}
      />
    );
  };

  let body: ReactNode;
  if (isPoly) {
    const pts = geometry.map(toCss);
    body = (
      <>
        <polygon points={pts.map((p) => `${p.x},${p.y}`).join(" ")} {...outlineProps} />
        {live && (
          <polygon
            points={pts.map((p) => `${p.x},${p.y}`).join(" ")}
            fill="rgba(255,255,255,0.06)"
            stroke="#fff"
            strokeWidth={1}
            strokeDasharray="4 3"
            style={{ pointerEvents: "none" }}
          />
        )}
        {/* Edge midpoints: pull out a new vertex. Hidden while dragging. */}
        {!live &&
          edgeMidpoints(geometry).map((m, i) => {
            const c = toCss(m);
            return (
              <circle
                key={`m${i}`}
                data-fp-edit
                cx={c.x}
                cy={c.y}
                r={MID_R_PX}
                fill="rgba(0,0,0,0.5)"
                stroke="#fff"
                strokeWidth={1.2}
                style={{ pointerEvents: "auto", cursor: "copy" }}
                onPointerDown={(e) =>
                  startDrag(
                    e,
                    (_s, c2) => moveVertex(insertVertex(base, i, m), i + 1, c2),
                    insertVertex(base, i, m)
                  )
                }
              >
                <title>Drag to add a vertex</title>
              </circle>
            );
          })}
        {geometry.map((p, i) =>
          square(
            p,
            `v${i}`,
            "move",
            (e) => startDrag(e, (_s, c2) => moveVertex(base, i, c2)),
            () => {
              const next = deleteVertex(base, i);
              if (next) onCommit({ ...region, geometry: next });
            }
          )
        )}
      </>
    );
  } else {
    const { x0, y0, x1, y1 } = rectBounds(geometry);
    const a = toCss({ x: x0, y: y0 });
    const b = toCss({ x: x1, y: y1 });
    body = (
      <>
        <rect x={a.x} y={a.y} width={Math.max(0, b.x - a.x)} height={Math.max(0, b.y - a.y)} rx={3} ry={3} {...outlineProps} />
        {live && (
          <rect
            x={a.x}
            y={a.y}
            width={Math.max(0, b.x - a.x)}
            height={Math.max(0, b.y - a.y)}
            fill="rgba(255,255,255,0.06)"
            stroke="#fff"
            strokeWidth={1}
            strokeDasharray="4 3"
            style={{ pointerEvents: "none" }}
          />
        )}
        {RECT_HANDLES.map((h) =>
          square(rectHandlePoint(geometry, h), h, RECT_CURSOR[h], (e) =>
            startDrag(e, (_s, c) => dragRectHandle(base, h, c))
          )
        )}
        {live && (
          <text
            x={b.x - 4}
            y={b.y - 4}
            fill="#ddd"
            fontSize={11}
            textAnchor="end"
            style={{ pointerEvents: "none", textShadow: "0 0 3px rgba(0,0,0,0.8)" }}
          >
            {Math.round(x1 - x0)} × {Math.round(y1 - y0)} px
          </text>
        )}
      </>
    );
  }

  return (
    <svg
      ref={svgRef}
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        height: "100%",
        pointerEvents: "none",
        zIndex: 10
      }}
    >
      {body}
    </svg>
  );
}
