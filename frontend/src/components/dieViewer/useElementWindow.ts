import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import type { DieAnnotations } from "shared";
import type { LiveValue } from "../../lib/liveValue";
import { useLiveValue } from "../../lib/liveValue";
import {
  anchorForDrop,
  anchorPointsFor,
  reanchor,
  resolveAnchorPoint,
  type AnchorPoint,
  type WindowElementKind
} from "../../lib/windowAnchor";
import type { Viewport } from "../../renderer/types";
import { usePreferences } from "../../state/preferences";

/** Pointer-downs on these start no drag (they keep their own behavior). */
const NO_DRAG = "input, textarea, select, button, a, label, [data-no-drag]";
const MARGIN = 8;

/**
 * Placement + dragging for an element window (net / cell / floorplan /
 * comment), rendered `position: absolute` inside the canvas container.
 *
 * The window sits at its stored anchor (see lib/windowAnchor) — a point of the
 * element plus a screen offset — or, until first dragged, at `fallback`.
 * Dragging from any non-interactive spot moves it; on drop it re-anchors to
 * the element point closest to the window and remembers that per user.
 * Spread `windowProps` onto the window's root element.
 */
export function useElementWindow({
  anchorKey,
  points,
  sig,
  fallback,
  viewportStore
}: {
  /** windowAnchorKey(dieId, kind, id). */
  anchorKey: string;
  /** The element's current anchor points (world). */
  points: AnchorPoint[];
  sig?: string;
  /** Placement before the first drag: world point + CSS px offset. */
  fallback: { x: number; y: number; dx: number; dy: number };
  viewportStore: LiveValue<Viewport | null>;
}) {
  const viewport = useLiveValue(viewportStore);
  const stored = usePreferences((s) => s.windowAnchors[anchorKey]);
  const setWindowAnchor = usePreferences((s) => s.setWindowAnchor);
  const ref = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<{ left: number; top: number } | null>(null);
  const dragStart = useRef<{ cx: number; cy: number; left: number; top: number; id: number } | null>(null);

  // Container (offsetParent) and window sizes, for keeping it on screen.
  const [size, setSize] = useState({ cw: window.innerWidth, ch: window.innerHeight, w: 260, h: 160 });
  useLayoutEffect(() => {
    const el = ref.current;
    const parent = el?.offsetParent as HTMLElement | null;
    if (!el || !parent) return;
    const next = { cw: parent.clientWidth, ch: parent.clientHeight, w: el.offsetWidth, h: el.offsetHeight };
    setSize((s) => (s.cw === next.cw && s.ch === next.ch && s.w === next.w && s.h === next.h ? s : next));
  });

  const toScreen = useCallback(
    (p: { x: number; y: number }) =>
      viewport
        ? { x: (p.x - viewport.originX) * viewport.zoom, y: (p.y - viewport.originY) * viewport.zoom }
        : { x: 0, y: 0 },
    [viewport]
  );

  const clamp = (left: number, top: number) => ({
    left: Math.max(MARGIN, Math.min(left, size.cw - size.w - MARGIN)),
    top: Math.max(MARGIN, Math.min(top, size.ch - size.h - MARGIN))
  });

  let pos: { left: number; top: number };
  if (drag) {
    pos = drag;
  } else {
    const anchorPoint = stored ? resolveAnchorPoint(points, sig, stored) : null;
    const base = anchorPoint && stored
      ? { ...toScreen(anchorPoint), dx: stored.dx, dy: stored.dy }
      : { ...toScreen(fallback), dx: fallback.dx, dy: fallback.dy };
    pos = clamp(base.x + base.dx, base.y + base.dy);
  }

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || (e.target as Element).closest(NO_DRAG)) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragStart.current = { cx: e.clientX, cy: e.clientY, left: pos.left, top: pos.top, id: e.pointerId };
    setDrag({ left: pos.left, top: pos.top });
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragStart.current;
    if (!d || d.id !== e.pointerId) return;
    setDrag(clamp(d.left + e.clientX - d.cx, d.top + e.clientY - d.cy));
  };
  const endDrag = (e: React.PointerEvent<HTMLDivElement>, commit: boolean) => {
    const d = dragStart.current;
    if (!d || d.id !== e.pointerId) return;
    dragStart.current = null;
    const final = clamp(d.left + e.clientX - d.cx, d.top + e.clientY - d.cy);
    setDrag(null);
    if (!commit || (final.left === d.left && final.top === d.top) || !viewport) return;
    const anchor = anchorForDrop(points, sig, { ...final, width: size.w, height: size.h }, toScreen);
    if (anchor) setWindowAnchor(anchorKey, anchor);
  };

  const style: CSSProperties = {
    position: "absolute",
    left: pos.left,
    top: pos.top,
    visibility: viewport ? "visible" : "hidden",
    cursor: drag ? "grabbing" : undefined
  };

  return {
    windowProps: {
      ref,
      style,
      onPointerDown,
      onPointerMove,
      onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => endDrag(e, true),
      onPointerCancel: (e: React.PointerEvent<HTMLDivElement>) => endDrag(e, false),
      // The canvas container handles these (cell window, die context menu);
      // inside a window they belong to its inputs.
      onDoubleClick: (e: React.MouseEvent) => e.stopPropagation(),
      onContextMenu: (e: React.MouseEvent) => e.stopPropagation()
    }
  };
}

/**
 * Keeps this die's stored window anchors attached as geometry changes: after
 * every annotations change, an anchor whose point was deleted moves to the
 * point nearest where it was (and a moved anchor point's position is
 * refreshed), while its last known position is still current. Windows that
 * are closed at the time therefore reopen beside the deleted point's
 * neighbour. Elements that no longer exist keep their entry (undo may bring
 * them back).
 */
export function useWindowAnchorMaintenance(dieId: string, annotations: DieAnnotations | undefined) {
  useEffect(() => {
    if (!annotations) return;
    const { windowAnchors, setWindowAnchor } = usePreferences.getState();
    const prefix = `${dieId}:`;
    for (const [key, stored] of Object.entries(windowAnchors)) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      const sep = rest.indexOf(":");
      if (sep < 0) continue;
      const kind = rest.slice(0, sep) as WindowElementKind;
      const found = anchorPointsFor(annotations, kind, rest.slice(sep + 1));
      if (!found) continue;
      const next = reanchor(found.points, found.sig, stored);
      if (next !== stored) setWindowAnchor(key, next);
    }
  }, [dieId, annotations]);
}

