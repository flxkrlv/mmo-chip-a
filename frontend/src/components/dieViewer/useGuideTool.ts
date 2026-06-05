import { useCallback, useEffect, useRef, useState } from "react";
import type { Guide } from "shared";
import type { ActionDispatcher } from "../../api/actions";
import type { Point } from "../../lib/geometry";
import { isTypingTarget } from "../../lib/keyboard";
import { useDieViewerStore, type ToolKind } from "../../state/dieViewer";

/** Axis-aligned end for a guide segment (90° snap from `start`). */
export function orthoSegEnd(start: Point, world: Point): Point {
  const dx = world.x - start.x;
  const dy = world.y - start.y;
  return Math.abs(dx) >= Math.abs(dy)
    ? { x: Math.round(world.x), y: start.y } // horizontal
    : { x: start.x, y: Math.round(world.y) }; // vertical
}

export interface GuideTool {
  /** In-progress segment's first point (null = none) — drives the overlay. */
  segStart: Point | null;
  /** Guide-line tool click → drop an infinite line at the cursor. */
  placeLine: (world: Point) => void;
  /** Guide-segment tool click → set start, then commit on the 2nd click. */
  addSegPoint: (world: Point) => void;
  /** Esc → drop the in-progress segment, else leave the tool. */
  cancel: () => void;
}

/**
 * The cell-grid guide tools. "Line" places an infinite axis-aligned guide at
 * the click (orientation from the store). "Segment" is a 2-click 90°-snapped
 * finite guide. Both commit one undoable `upsertGuide`.
 */
export function useGuideTool(opts: {
  dispatcher: ActionDispatcher;
  activeTool: ToolKind;
  setActiveTool: (tool: ToolKind) => void;
}): GuideTool {
  const { dispatcher, activeTool, setActiveTool } = opts;
  const [segStart, setSegStart] = useState<Point | null>(null);
  const segRef = useRef<Point | null>(null);
  segRef.current = segStart;

  const placeLine = useCallback(
    (world: Point) => {
      const axis = useDieViewerStore.getState().guideAxis;
      const guide: Guide = {
        id: crypto.randomUUID(),
        kind: "line",
        axis,
        pos: Math.round(axis === "x" ? world.x : world.y)
      };
      void dispatcher.dispatch({ kind: "upsertGuide", guide, prevGuide: null });
    },
    [dispatcher]
  );

  const addSegPoint = useCallback(
    (world: Point) => {
      const start = segRef.current;
      if (!start) {
        setSegStart({ x: Math.round(world.x), y: Math.round(world.y) });
        return;
      }
      const end = orthoSegEnd(start, world);
      if (end.x === start.x && end.y === start.y) return; // ignore zero-length
      void dispatcher.dispatch({
        kind: "upsertGuide",
        guide: {
          id: crypto.randomUUID(),
          kind: "segment",
          x1: start.x,
          y1: start.y,
          x2: end.x,
          y2: end.y
        },
        prevGuide: null
      });
      setSegStart(null);
    },
    [dispatcher]
  );

  const cancel = useCallback(() => {
    if (segRef.current) setSegStart(null);
    else setActiveTool("select");
  }, [setActiveTool]);

  // Leaving the guide tools abandons an in-progress segment.
  useEffect(() => {
    if (
      activeTool !== "cellGuideSeg" &&
      activeTool !== "cellGuideLine" &&
      segRef.current
    ) {
      setSegStart(null);
    }
  }, [activeTool]);

  // Keyboard: Escape cancels — only while a guide tool is active.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = useDieViewerStore.getState().activeTool;
      if (t !== "cellGuideLine" && t !== "cellGuideSeg") return;
      if (isTypingTarget(e.target)) return;
      if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cancel]);

  return { segStart, placeLine, addSegPoint, cancel };
}
