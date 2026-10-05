import { useCallback, useRef } from "react";
import type { AnnotationHit } from "../../renderer/layers/AnnotationLayer";
import { useDieViewerStore } from "../../state/dieViewer";

/** Two clicks on the same element within this window count as a double-click. */
const DOUBLE_CLICK_MS = 300;

/**
 * Selection gestures against the dieViewer store. `selectFromHit` promotes a
 * sub-part selection to the whole element on a quick second click — except
 * for nets, where the double-click calls `onNetDoubleClick` (rename) and the
 * clicked segment / vertex stays selected, and for vias, where a double-click
 * on a via that was part of a larger selection keeps that selection (the
 * via color window then recolors all of them). The marquee/empty-click
 * helpers round out the set.
 */
export function useCanvasSelection(opts?: {
  /** Double-click on a net; receives the net id (without the `net:` prefix). */
  onNetDoubleClick?: (netId: string) => void;
}) {
  const onNetDoubleClickRef = useRef(opts?.onNetDoubleClick);
  onNetDoubleClickRef.current = opts?.onNetDoubleClick;
  // Previous click, for the sub-part → whole-element double-click promotion.
  // `before` = the selection before that click (restored by a via double-click).
  const lastClickRef = useRef<{ time: number; wholeId: string; before: ReadonlySet<string> } | null>(null);

  const selectFromHit = useCallback((hit: AnnotationHit, shift: boolean) => {
    const { select, selectedIds } = useDieViewerStore.getState();
    const now = performance.now();
    const prev = lastClickRef.current;
    const isDouble =
      prev !== null &&
      now - prev.time < DOUBLE_CLICK_MS &&
      prev.wholeId === hit.annotation.id;

    if (isDouble && hit.annotation.kind === "net" && onNetDoubleClickRef.current) {
      lastClickRef.current = null; // don't let a 3rd click re-trigger
      onNetDoubleClickRef.current(hit.annotation.id.replace(/^net:/, ""));
      return;
    }
    if (isDouble && prev && hit.annotation.kind === "via" && !shift && prev.before.has(hit.annotation.id) && prev.before.size > 1) {
      // The 1st click narrowed the selection to this via; put it back.
      select(prev.before, "replace");
      lastClickRef.current = null;
      return;
    }
    if (isDouble) {
      // Double-click → select the whole element.
      select([hit.annotation.id], shift ? "toggle" : "replace");
      lastClickRef.current = null; // don't let a 3rd click re-trigger
      return;
    }
    // Single click → select just the part that was hit (segment/vertex for
    // nets; the whole annotation for simple kinds where partId === id).
    select([hit.partId], shift ? "toggle" : "replace");
    lastClickRef.current = { time: now, wholeId: hit.annotation.id, before: selectedIds };
  }, []);

  const clearSelectionFromEmpty = useCallback((shift: boolean) => {
    lastClickRef.current = null;
    if (!shift) useDieViewerStore.getState().clearSelection();
  }, []);

  const selectFromMarquee = useCallback((ids: string[], shift: boolean) => {
    useDieViewerStore.getState().select(ids, shift ? "add" : "replace");
  }, []);

  return { selectFromHit, clearSelectionFromEmpty, selectFromMarquee };
}
