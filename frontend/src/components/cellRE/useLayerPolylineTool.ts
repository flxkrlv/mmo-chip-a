import { useCallback, useEffect, useRef, useState } from "react";
import type { CellType, LayerShape, LayerType } from "shared";
import type { ActionDispatcher } from "../../api/actions";
import type { Point } from "../../lib/geometry";
import { useCellREStore } from "../../state/cellRE";
import { useDieViewerStore } from "../../state/dieViewer";
import { uuid } from "../../lib/uuid";

export interface LayerPolylineTool {
  points: Point[];
  width: number;
  addPoint: (p: Point) => void;
  commit: () => void;
  cancel: () => void;
}

export function useLayerPolylineTool(opts: {
  dispatcher: ActionDispatcher;
  cellType: CellType | null;
  activeLayer: LayerType;
  active: boolean;
  /** µm per pixel — for converting polyline width from µm to px on commit. */
  umPerPx?: number;
}): LayerPolylineTool {
  const { dispatcher, cellType, activeLayer, active, umPerPx } = opts;
  // Store polylineWidth in µm; convert to px for drawing.
  const widthUm = useCellREStore((s) => s.polylineWidth);
  const [points, setPoints] = useState<Point[]>([]);
  const pointsRef = useRef(points); pointsRef.current = points;
  const redoRef = useRef<Point[]>([]);
  const setUndoOverride = useDieViewerStore((s) => s.setUndoOverride);
  const widthPx = umPerPx ? Math.round(widthUm / umPerPx) : widthUm;
  const ctxRef = useRef({ dispatcher, cellType, activeLayer, width: widthPx, umPerPx });
  ctxRef.current = { dispatcher, cellType, activeLayer, width: widthPx, umPerPx };

  const addPoint = useCallback((p: Point) => {
    redoRef.current = [];
    const pts = pointsRef.current;
    if (pts.length > 0) {
      const last = pts[pts.length - 1];
      const dx = Math.abs(p.x - last.x), dy = Math.abs(p.y - last.y);
      // Snap to nearest 90° axis
      p = dx > dy ? { x: p.x, y: last.y } : { x: last.x, y: p.y };
    }
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
    const { cellType, activeLayer, dispatcher, width, umPerPx } = ctxRef.current;

    if (pts.length >= 2 && cellType) {
      const shapes: LayerShape[] = [];
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        shapes.push({
          id: uuid(),
          kind: "line" as const,
          x1: a.x, y1: a.y, x2: b.x, y2: b.y,
          width,
        });
      }
      // Build ONE action with all shapes so each doesn't overwrite the previous
      const layerList = cellType.layers?.[activeLayer] ?? [];
      const next: CellType = {
        ...cellType,
        layers: { ...cellType.layers, [activeLayer]: [...(layerList as LayerShape[]), ...shapes] },
      };
      void dispatcher.dispatch({
        kind: "upsertCellType",
        cellType: next,
        prevCellType: cellType,
      });
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

  return { points, width: widthUm, addPoint, commit, cancel };
}
