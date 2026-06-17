/**
 * useOverlayHotkeys — Shared keyboard shortcuts for overlay layer control.
 *
 * Works across Die Viewer, Merge Cells, and RE Cell.
 *
 *   Ctrl+Shift+B    — toggle base image visibility
 *   ]               — cycle / toggle next overlay
 *   [               — cycle / toggle previous overlay
 *   Ctrl+Shift+1..8 — toggle overlay layer #1..#8 directly
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

      // Ctrl+Shift+1..8 → toggle overlay layer #N directly
      if (ctrl && shift && e.key >= "1" && e.key <= "8") {
        e.preventDefault();
        const idx = parseInt(e.key, 10) - 1;
        if (idx < layers.length) {
          const layer = layers[idx];
          useOverlayLayers.getState().setLayerHidden(layer.id, !layer.hidden);
        }
        return;
      }

      // ] → cycle to next overlay: make the next hidden layer visible,
      //     or if all are visible, hide the first visible one (toggle off).
      if (e.key === "]" && !ctrl && !shift && !e.altKey) {
        e.preventDefault();
        const { layers } = useOverlayLayers.getState();
        if (layers.length === 0) return;
        // Find the first hidden layer and make it visible.
        const nextHiddenIdx = layers.findIndex((l) => l.hidden);
        if (nextHiddenIdx >= 0) {
          useOverlayLayers.getState().setLayerHidden(
            layers[nextHiddenIdx].id,
            false
          );
        } else {
          // All visible → hide the last one (toggle off the current layer).
          useOverlayLayers.getState().setLayerHidden(
            layers[layers.length - 1].id,
            true
          );
        }
        return;
      }

      // [ → cycle to previous overlay: make the first visible layer hidden,
      //     or if all are hidden, make the last one visible (toggle on).
      if (e.key === "[" && !ctrl && !shift && !e.altKey) {
        e.preventDefault();
        const { layers } = useOverlayLayers.getState();
        if (layers.length === 0) return;
        const firstVisibleIdx = layers.findIndex((l) => !l.hidden);
        if (firstVisibleIdx >= 0) {
          // Hide the first open layer (toggle off).
          useOverlayLayers.getState().setLayerHidden(
            layers[firstVisibleIdx].id,
            true
          );
        } else {
          // All hidden → show the last one.
          useOverlayLayers.getState().setLayerHidden(
            layers[layers.length - 1].id,
            false
          );
        }
        return;
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
