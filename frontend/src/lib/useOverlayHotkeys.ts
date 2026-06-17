/**
 * useOverlayHotkeys — Shared keyboard shortcuts for overlay layer control.
 *
 * Works across Die Viewer, Merge Cells, and RE Cell.
 *
 *   Ctrl+Shift+B    — toggle base image visibility
 *   ]               — show only the NEXT overlay layer (N+1), hide others
 *   [               — show only the PREVIOUS overlay layer (N-1), hide others
 *   Ctrl+Shift+1..8 — show only overlay layer #1..#8, hide others
 */

import { useEffect } from "react";
import { useOverlayLayers } from "../state/overlayLayers";

export function useOverlayHotkeys(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Don't fire when the user is typing in an input.
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      const layers = useOverlayLayers.getState().layers;
      const ctrl = e.ctrlKey || e.metaKey;
      const shift = e.shiftKey;

      // Ctrl+Shift+B → toggle base image
      if (ctrl && shift && e.key.toLowerCase() === "b") {
        e.preventDefault();
        useOverlayLayers.getState().toggleBaseImage();
        return;
      }

      // Ctrl+Shift+1..8 → show only layer N, hide all others
      if (ctrl && shift && e.code >= "Digit1" && e.code <= "Digit8") {
        e.preventDefault();
        const digits = ["Digit1","Digit2","Digit3","Digit4","Digit5","Digit6","Digit7","Digit8"];
        const idx = digits.indexOf(e.code);
        const { layers } = useOverlayLayers.getState();
        for (let i = 0; i < layers.length; i++) {
          const hidden = i !== idx;
          if (layers[i].hidden !== hidden) {
            useOverlayLayers.getState().setLayerHidden(layers[i].id, hidden);
          }
        }
        return;
      }

      // ] → show only the next overlay (N+1), hide all others
      if (e.key === "]" && !ctrl && !shift && !e.altKey) {
        e.preventDefault();
        const { layers } = useOverlayLayers.getState();
        if (layers.length === 0) return;
        // Find current visible layer index
        const currentIdx = layers.findIndex((l) => !l.hidden);
        const nextIdx = currentIdx < 0
          ? 0                          // none visible → show first
          : (currentIdx + 1) % layers.length;  // next, wrapping
        for (let i = 0; i < layers.length; i++) {
          const hidden = i !== nextIdx;
          if (layers[i].hidden !== hidden) {
            useOverlayLayers.getState().setLayerHidden(layers[i].id, hidden);
          }
        }
        return;
      }

      // [ → show only the previous overlay (N-1), hide all others
      if (e.key === "[" && !ctrl && !shift && !e.altKey) {
        e.preventDefault();
        const { layers } = useOverlayLayers.getState();
        if (layers.length === 0) return;
        const currentIdx = layers.findIndex((l) => !l.hidden);
        const prevIdx = currentIdx <= 0
          ? layers.length - 1          // none or first → show last
          : currentIdx - 1;            // previous
        for (let i = 0; i < layers.length; i++) {
          const hidden = i !== prevIdx;
          if (layers[i].hidden !== hidden) {
            useOverlayLayers.getState().setLayerHidden(layers[i].id, hidden);
          }
        }
        return;
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
