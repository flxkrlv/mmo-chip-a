import { useCallback, useEffect, useRef, useState } from "react";
import type { ActionDispatcher } from "../../api/actions";
import type { Point } from "../../lib/geometry";
import { isTypingTarget } from "../../lib/keyboard";
import { useDieViewerStore, type ToolKind } from "../../state/dieViewer";
import { uuid } from "../../lib/uuid";

export interface ViaPolyTool {
  /** Committed-so-far polygon points (drives the draft overlay). */
  points: Point[];
  /** Tool click → append a vertex. */
  addPoint: (world: Point) => void;
  /** Enter → materialize as an `irregular_via` polygon (needs ≥3 points). */
  commit: () => void;
  /** Esc → discard the in-progress polygon, else leave the tool. */
  cancel: () => void;
}

/**
 * The "Draw via polygon" tool: click to drop vertices, Enter to confirm
 * (≥3), Esc to abort. Kept transient (local state + overlay) so drawing
 * never re-renders the page or thrashes the index — same approach as the
 * wire tool, but a closed polygon committed in one `upsertAnnotation`.
 */
export function useViaPolyTool(opts: {
  dispatcher: ActionDispatcher;
  activeTool: ToolKind;
  setActiveTool: (tool: ToolKind) => void;
}): ViaPolyTool {
  const { dispatcher, activeTool, setActiveTool } = opts;
  const [points, setPoints] = useState<Point[]>([]);
  const pointsRef = useRef(points);
  pointsRef.current = points;
  // Per-point redo stack for context-aware ⌘Z while building the polygon.
  const redoRef = useRef<Point[]>([]);
  const setUndoOverride = useDieViewerStore((s) => s.setUndoOverride);

  const addPoint = useCallback((world: Point) => {
    redoRef.current = [];
    setPoints((p) => [...p, { x: Math.round(world.x), y: Math.round(world.y) }]);
  }, []);

  const undoPoint = useCallback(() => {
    const pts = pointsRef.current;
    if (pts.length === 0) return;
    redoRef.current = [pts[pts.length - 1], ...redoRef.current];
    setPoints(pts.slice(0, -1));
  }, []);

  const redoPoint = useCallback(() => {
    if (redoRef.current.length === 0) return;
    const [restored, ...rest] = redoRef.current;
    redoRef.current = rest;
    setPoints((p) => [...p, restored]);
  }, []);

  const commit = useCallback(() => {
    const pts = pointsRef.current;
    if (pts.length >= 3) {
      void dispatcher.dispatch({
        kind: "upsertAnnotation",
        annotation: {
          id: uuid(),
          class: "irregular_via",
          geometry: { kind: "polygon", points: pts },
          source: "human"
        },
        prevAnnotation: null
      });
    }
    redoRef.current = [];
    setPoints([]);
  }, [dispatcher]);

  const cancel = useCallback(() => {
    redoRef.current = [];
    if (pointsRef.current.length > 0) setPoints([]);
    else setActiveTool("select");
  }, [setActiveTool]);

  // Leaving the tool abandons the in-progress polygon.
  useEffect(() => {
    if (activeTool !== "viaPoly" && pointsRef.current.length > 0) {
      redoRef.current = [];
      setPoints([]);
    }
  }, [activeTool]);

  // While building, ⌘Z / ⌘⇧Z pop / restore the last vertex instead of the
  // app-level undo (same store override the wire tool uses).
  const drafting = points.length > 0;
  useEffect(() => {
    if (!drafting) return;
    setUndoOverride({ undo: undoPoint, redo: redoPoint });
    return () => setUndoOverride(null);
  }, [drafting, undoPoint, redoPoint, setUndoOverride]);

  // Keyboard: Enter commits, Escape cancels — only while the tool is active.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (useDieViewerStore.getState().activeTool !== "viaPoly") return;
      if (isTypingTarget(e.target)) return;
      if (e.key === "Enter") {
        e.preventDefault();
        commit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [commit, cancel]);

  return { points, addPoint, commit, cancel };
}
