import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { fitViewport } from "../../renderer/TiledCanvas";
import type { Viewport } from "../../renderer/types";
import type { LiveValue } from "../../lib/liveValue";
import { usePreferences } from "../../state/preferences";

const VIEWPORT_PERSIST_DEBOUNCE_MS = 500;

/**
 * Owns the per-die viewport lifecycle:
 *  - initial framing: a previously-saved viewport for this die, else
 *    fit-to-screen once the container has a measurable size;
 *  - debounced persistence to localStorage (one write per ~500ms idle),
 *    flushed on unmount so the last frame isn't lost.
 *
 * Returns the `initialViewport` for `<TiledCanvas>` and the `onViewportChange`
 * to wire to it.
 */
export function usePersistedViewport(opts: {
  dieId: string;
  die: { width: number; height: number } | undefined;
  viewportLive: LiveValue<Viewport | null>;
  containerRef: RefObject<HTMLDivElement | null>;
}) {
  const { dieId, die, viewportLive, containerRef } = opts;

  const [initialViewport, setInitialViewport] = useState<Viewport | null>(null);
  const initializedRef = useRef(false);

  useEffect(() => {
    if (!die || initializedRef.current) return;

    const saved = usePreferences.getState().savedViewports[dieId];
    if (saved) {
      initializedRef.current = true;
      setInitialViewport(saved);
      viewportLive.set(saved);
      return;
    }

    const el = containerRef.current;
    if (!el) return;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return false;
      const v = fitViewport(die.width, die.height, rect.width, rect.height, 24);
      initializedRef.current = true;
      setInitialViewport(v);
      viewportLive.set(v);
      return true;
    };
    if (measure()) return;
    const ro = new ResizeObserver(() => {
      if (measure()) ro.disconnect();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [die, dieId, viewportLive, containerRef]);

  const saveTimerRef = useRef<number | null>(null);
  const pendingViewportRef = useRef<Viewport | null>(null);

  const persistViewport = useCallback(
    (v: Viewport) => {
      pendingViewportRef.current = v;
      if (saveTimerRef.current !== null) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = window.setTimeout(() => {
        saveTimerRef.current = null;
        const final = pendingViewportRef.current;
        if (final) usePreferences.getState().saveViewport(dieId, final);
      }, VIEWPORT_PERSIST_DEBOUNCE_MS);
    },
    [dieId]
  );

  useEffect(() => {
    return () => {
      if (saveTimerRef.current !== null) {
        clearTimeout(saveTimerRef.current);
        const final = pendingViewportRef.current;
        if (final) usePreferences.getState().saveViewport(dieId, final);
      }
    };
  }, [dieId]);

  const onViewportChange = useCallback(
    (v: Viewport) => {
      viewportLive.set(v);
      persistViewport(v);
    },
    [viewportLive, persistViewport]
  );

  return { initialViewport, onViewportChange };
}
