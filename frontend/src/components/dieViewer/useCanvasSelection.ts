import { useCallback, useRef } from "react";
import type { AnnotationHit } from "../../renderer/layers/AnnotationLayer";
import { useDieViewerStore } from "../../state/dieViewer";

/** Two clicks on the same element within this window count as a double-click. */
const DOUBLE_CLICK_MS = 300;

/**
 * Selection gestures against the dieViewer store. `selectFromHit` promotes a
 * sub-part selection (a wire segment / vertex) to the whole element on a quick
 * second click; the marquee/empty-click helpers round out the set.
 */
export function useCanvasSelection() {
  // Previous click, for the sub-part → whole-element double-click promotion.
  const lastClickRef = useRef<{ time: number; wholeId: string } | null>(null);

  const selectFromHit = useCallback((hit: AnnotationHit, shift: boolean) => {
    const { select } = useDieViewerStore.getState();
    const now = performance.now();
    const prev = lastClickRef.current;
    const isDouble =
      prev !== null &&
      now - prev.time < DOUBLE_CLICK_MS &&
      prev.wholeId === hit.annotation.id;

    if (isDouble) {
      // Double-click → select the whole element (e.g. the entire net).
      select([hit.annotation.id], shift ? "toggle" : "replace");
      lastClickRef.current = null; // don't let a 3rd click re-trigger
      return;
    }
    // Single click → select just the part that was hit (segment/vertex for
    // nets; the whole annotation for simple kinds where partId === id).
    select([hit.partId], shift ? "toggle" : "replace");
    lastClickRef.current = { time: now, wholeId: hit.annotation.id };
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
