/**
 * useAnalogDrawTool.ts — Draw analog layer shapes on the die viewer canvas.
 *
 * When analogRect/analogPoly tool is active, this hook:
 * 1. Tracks mouse drag to create a rectangle shape
 * 2. On Enter (or mouse up), commits the shape to analogLayers
 * 3. Persists via the backend API
 *
 * No action system — writes directly to annotations cache + backend.
 */

import { useCallback, useEffect, useRef } from "react";
import type { CellLayers, DieAnnotations, LayerShape, LayerType } from "shared";
import { useQueryClient } from "@tanstack/react-query";
import { annotationKeys } from "../../api/annotations";
import { apiPut } from "../../api/client";
import { makeRect } from "../../lib/cellLayers";
import { normalizeRect, type Rect } from "../../lib/geometry";
import type { LiveValue } from "../../lib/liveValue";
import { isTypingTarget } from "../../lib/keyboard";
import { useDieViewerStore, type ToolKind } from "../../state/dieViewer";

export interface AnalogDrawTool {
  commitShape: () => void;
  cancel: () => void;
}

/** Which analog tools we handle. */
const ANALOG_TOOLS: ReadonlyArray<ToolKind> = ["analogRect", "analogPoly"];

export function useAnalogDrawTool(opts: {
  dieId: string;
  annotations: DieAnnotations | undefined;
  activeTool: ToolKind;
  setActiveTool: (tool: ToolKind) => void;
  /** Live rect while the user is dragging. Passed in from the page. */
  draftRect: LiveValue<Rect | null>;
}): AnalogDrawTool {
  const { dieId, annotations, activeTool, setActiveTool, draftRect } = opts;
  const queryClient = useQueryClient();

  const commitShape = useCallback(() => {
    const rect = draftRect.get();
    if (!rect) return;
    const n = normalizeRect(rect);
    if (n.width < 1 || n.height < 1) { draftRect.set(null); return; }

    const activeLayer = useDieViewerStore.getState().activeAnalogLayer;
    const shape = makeRect(n);

    // Build new analogLayers
    const prev = annotations?.analogLayers ?? {};
    const layerKey = activeLayer as string;
    const prevShapes: LayerShape[] = ((prev as Record<string, LayerShape[]>)[layerKey] ?? []);
    const next: CellLayers = {
      ...prev,
      [layerKey]: [...prevShapes, shape],
    };

    // Update React Query cache immediately (optimistic)
    queryClient.setQueryData(annotationKeys.detail(dieId), (old: DieAnnotations | undefined) => {
      if (!old) return old;
      return { ...old, analogLayers: next };
    });

    // Persist to backend
    void apiPut(`/api/dies/${dieId}/analog-layers`, next).catch((e) =>
      console.error("Failed to save analog layer:", e),
    );

    draftRect.set(null);
  }, [annotations, dieId, draftRect, queryClient]);

  const cancel = useCallback(() => {
    if (draftRect.get()) {
      draftRect.set(null);
    } else {
      setActiveTool("select");
    }
  }, [draftRect, setActiveTool]);

  // Leave tool → clear draft
  useEffect(() => {
    if (!ANALOG_TOOLS.includes(activeTool) && draftRect.get()) draftRect.set(null);
  }, [activeTool, draftRect]);

  // Keyboard handling
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tool = useDieViewerStore.getState().activeTool;
      if (!ANALOG_TOOLS.includes(tool)) return;
      if (isTypingTarget(e.target)) return;
      if (e.key === "Enter") {
        if (!draftRect.get()) return;
        e.preventDefault();
        commitShape();
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [commitShape, cancel, draftRect]);

  return { commitShape, cancel };
}
