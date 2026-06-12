/**
 * useLayerPolylineTool.ts — Polyline-drawing helper for Cells-RE.
 *
 * Manages the in-progress polyline (array of world-space points).
 * On Enter: commits each segment as a `LayerLine` on the active layer
 * (resistor_body). Escape or tool change cancels the draft.
 */

import { useCallback, useEffect, useRef } from "react";
import type { LayerShape } from "shared";
import { useCellREStore, type ReToolKind } from "../../state/cellRE";
import { buildUpsertShapeAction } from "../../lib/cellLayers";
import type { ActionDispatcher } from "../../api/actions";
import type { Point } from "../../lib/geometry";

export interface LayerPolylineTool {
  points: Point[];
  addPoint: (p: Point) => void;
  commit: () => void;
  cancel: () => void;
}

export function useLayerPolylineTool(opts: {
  dispatcher: ActionDispatcher;
  activeTool: ReToolKind;
  setActiveTool: (t: ReToolKind) => void;
}): LayerPolylineTool {
  const { dispatcher, activeTool, setActiveTool } = opts;

  const commit = useCallback(() => {
    const draft = useCellREStore.getState().polylineDraft;
    if (draft.length < 2) { useCellREStore.getState().clearPolylineDraft(); return; }
    const layer = useCellREStore.getState().activeLayer;
    const width = useCellREStore.getState().polylineWidth;

    // Create one LayerLine per segment
    const shapes: LayerShape[] = [];
    for (let i = 0; i < draft.length - 1; i++) {
      const a = draft[i], b = draft[i + 1];
      shapes.push({
        id: crypto.randomUUID(),
        kind: "line",
        x1: a.x, y1: a.y, x2: b.x, y2: b.y,
        width,
      });
    }

    const action = buildUpsertShapeAction(layer, shapes);
    void dispatcher.dispatch(action);
    useCellREStore.getState().clearPolylineDraft();
  }, [dispatcher]);

  const addPoint = useCallback((p: Point) => {
    useCellREStore.getState().addPolylinePoint(p);
  }, []);

  const cancel = useCallback(() => {
    useCellREStore.getState().clearPolylineDraft();
  }, []);

  // Discard draft on tool change from polyline
  useEffect(() => {
    if (activeTool !== "polyline" && useCellREStore.getState().polylineDraft.length > 0) {
      useCellREStore.getState().clearPolylineDraft();
    }
  }, [activeTool]);

  return {
    points: useCellREStore((s) => s.polylineDraft),
    addPoint,
    commit,
    cancel,
  };
}
