import { useCallback, useEffect, useRef, useState } from "react";
import type { CellType, LayerType } from "shared";
import type { ActionDispatcher } from "../../api/actions";
import type { Point } from "../../lib/geometry";
import { buildUpsertShapeAction } from "../../lib/cellLayers";
import { useDieViewerStore } from "../../state/dieViewer";

export interface LayerPolylineTool {
  points: Point[];
  addPoint: (p: Point) => void;
  commit: () => void;
  cancel: () => void;
}

export function useLayerPolylineTool(opts: {
  dispatcher: ActionDispatcher;
  cellType: CellType | null;
  activeLayer: LayerType;
  active: boolean;
}): LayerPolylineTool {
  const { dispatcher, cellType, activeLayer, active } = opts;
  const width = useCellREStore((s) => s.polylineWidth);
  const [points, setPoints] = useState<Point[]>([]);
  const pointsRef = useRef(points); pointsRef.current = points;
  const redoRef = useRef<Point[]>([]);
  const setUndoOverride = useDieViewerStore((s) => s.setUndoOverride);
  const ctxRef = useRef({ dispatcher, cellType, activeLayer, width });
  ctxRef.current = { dispatcher, cellType, activeLayer, width };

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
    const [r, ...rest] = redoRef.current;
    redoRef.current = rest;
    setPoints((p) => [...p, r]);
  }, []);

  const commit = useCallback(() => {
    const pts = pointsRef.current;
    const { cellType, activeLayer, dispatcher, width } = ctxRef.current;
    if (pts.length >= 2 && cellType) {
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        const shape = {
          id: crypto.randomUUID(),
          kind: "line" as const,
          x1: a.x, y1: a.y, x2: b.x, y2: b.y,
          width,
        };
        void dispatcher.dispatch(buildUpsertShapeAction(cellType, activeLayer, shape));
      }
    }
    redoRef.current = [];
    setPoints([]);
  }, []);

  const cancel = useCallback(() => {
    redoRef.current = [];
    if (pointsRef.current.length > 0) setPoints([]);
  }, []);

  useEffect(() => {
    if (!active && pointsRef.current.length > 0) { redoRef.current = []; setPoints([]); }
  }, [active]);
  useEffect(() => {
    if (pointsRef.current.length > 0) { redoRef.current = []; setPoints([]); }
  }, [cellType?.id]);

  const drafting = points.length > 0;
  useEffect(() => {
    if (!drafting) return;
    setUndoOverride({ undo: undoPoint, redo: redoPoint });
    return () => setUndoOverride(null);
  }, [drafting, undoPoint, redoPoint, setUndoOverride]);

  return { points, addPoint, commit, cancel };
}
