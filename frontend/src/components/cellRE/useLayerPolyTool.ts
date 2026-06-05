import { useCallback, useEffect, useRef, useState } from "react";
import type { CellType, LayerType } from "shared";
import type { ActionDispatcher } from "../../api/actions";
import type { Point } from "../../lib/geometry";
import { buildUpsertShapeAction, makePolygon } from "../../lib/cellLayers";
import { useDieViewerStore } from "../../state/dieViewer";

/**
 * Polygon-drawing helper for the Cells-RE page. Holds the in-progress
 * vertex list at the page level so the canvas can render it and the global
 * ⌘Z hook (`setUndoOverride`) can pop the last vertex while drafting —
 * mirroring the die viewer's via-polygon tool exactly.
 */
export interface LayerPolyTool {
  /** Vertices the user has clicked so far (rendered as the draft polygon). */
  points: Point[];
  /** Canvas click: append a vertex. */
  addPoint: (p: Point) => void;
  /** Enter / toolbar: ≥3 vertices commits as a polygon on the active layer. */
  commit: () => void;
  /** Esc: discards the in-progress polygon (caller may also leave the tool). */
  cancel: () => void;
}

export function useLayerPolyTool(opts: {
  dispatcher: ActionDispatcher;
  cellType: CellType | null;
  activeLayer: LayerType;
  active: boolean;
}): LayerPolyTool {
  const { dispatcher, cellType, activeLayer, active } = opts;
  const [points, setPoints] = useState<Point[]>([]);
  const pointsRef = useRef(points);
  pointsRef.current = points;
  const redoRef = useRef<Point[]>([]);
  const setUndoOverride = useDieViewerStore((s) => s.setUndoOverride);

  // Keep the dispatcher / cellType / layer reachable from the (stable) undo
  // override callbacks without bouncing them through deps (which would
  // re-install the override on every redraw and double-fire).
  const ctxRef = useRef({ dispatcher, cellType, activeLayer });
  ctxRef.current = { dispatcher, cellType, activeLayer };

  const addPoint = useCallback((p: Point) => {
    redoRef.current = [];
    setPoints((cur) => [...cur, { x: Math.round(p.x), y: Math.round(p.y) }]);
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
    const { cellType, activeLayer, dispatcher } = ctxRef.current;
    if (pts.length >= 3 && cellType) {
      const shape = makePolygon(pts);
      void dispatcher.dispatch(
        buildUpsertShapeAction(cellType, activeLayer, shape)
      );
    }
    redoRef.current = [];
    setPoints([]);
  }, []);

  const cancel = useCallback(() => {
    redoRef.current = [];
    if (pointsRef.current.length > 0) setPoints([]);
  }, []);

  // Leaving the tool (or changing the loaded cell type) abandons the draft.
  useEffect(() => {
    if (!active && pointsRef.current.length > 0) {
      redoRef.current = [];
      setPoints([]);
    }
  }, [active]);
  useEffect(() => {
    if (pointsRef.current.length > 0) {
      redoRef.current = [];
      setPoints([]);
    }
  }, [cellType?.id]);

  // While drafting, route the global ⌘Z / ⌘⇧Z through the vertex stack —
  // matches the die viewer's via-polygon tool, which uses the same store
  // override.
  const drafting = points.length > 0;
  useEffect(() => {
    if (!drafting) return;
    setUndoOverride({ undo: undoPoint, redo: redoPoint });
    return () => setUndoOverride(null);
  }, [drafting, undoPoint, redoPoint, setUndoOverride]);

  return { points, addPoint, commit, cancel };
}
