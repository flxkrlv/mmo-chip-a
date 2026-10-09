import { useCallback, useEffect, useRef, type RefObject } from "react";
import type {
  DragEventData,
  DragHandler,
  Interaction,
  PointerEventData,
  PointerModifiers
} from "./interaction";
import type { Viewport } from "./types";

const WHEEL_ZOOM_FACTOR = 0.01;
const CLICK_MOVE_THRESHOLD_PX = 4;
/** Auto-pan starts when the pointer is this close to (or past) an edge. */
const AUTO_PAN_EDGE_PX = 32;
/** Pan speed (CSS px per 60 Hz frame) at the edge; grows past it up to 2×. */
const AUTO_PAN_SPEED_PX = 14;

type GestureMode = "pan" | "ignore" | { kind: "custom"; handler: DragHandler };

interface GestureState {
  pointerId: number;
  button: number;
  startScreenX: number;
  startScreenY: number;
  startWorldX: number;
  startWorldY: number;
  lastScreenX: number;
  lastScreenY: number;
  lastModifiers: PointerModifiers;
  moved: boolean;
  mode: GestureMode;
}

export interface CanvasGestureOptions {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  /** Live viewport (mutated by setViewport). */
  viewportRef: RefObject<Viewport>;
  /** Clamped viewport setter owned by the canvas. */
  setViewport: (v: Viewport) => void;
  /** Latest parent `onPointerDown` (decides the interaction per gesture). */
  onPointerDownRef: RefObject<((e: PointerEventData) => Interaction) | undefined>;
  /** Latest parent `onCanvasClick` (fired on a no-drag left click in pan mode). */
  onCanvasClickRef: RefObject<((p: { x: number; y: number }) => void) | undefined>;
  minZoom: number;
  maxZoom: number;
}

/**
 * Owns the pointer/wheel gesture machinery for the tiled canvas: pointer
 * capture, world conversion, the click-vs-drag threshold, built-in pan/zoom,
 * and dispatch to a parent-supplied `DragHandler`. Returns the React pointer
 * handlers to spread onto the `<canvas>`; the non-passive wheel listener is
 * managed internally.
 */
export function useCanvasGestures({
  canvasRef,
  viewportRef,
  setViewport,
  onPointerDownRef,
  onCanvasClickRef,
  minZoom,
  maxZoom
}: CanvasGestureOptions) {
  const gestureRef = useRef<GestureState | null>(null);
  const autoPanFrameRef = useRef<number | null>(null);

  const screenToWorld = useCallback(
    (sx: number, sy: number): { x: number; y: number } => {
      const vp = viewportRef.current;
      return { x: vp.originX + sx / vp.zoom, y: vp.originY + sy / vp.zoom };
    },
    [viewportRef]
  );

  const screenPointFromEvent = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const rect = canvasRef.current!.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    },
    [canvasRef]
  );

  const modifiersFrom = (
    event: React.PointerEvent<HTMLCanvasElement> | PointerEvent
  ): PointerModifiers => ({
    shift: event.shiftKey,
    alt: event.altKey,
    meta: event.metaKey,
    ctrl: event.ctrlKey
  });

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      // Only handle primary (left) and middle buttons.
      if (event.button !== 0 && event.button !== 1) return;
      event.currentTarget.setPointerCapture(event.pointerId);

      const screen = screenPointFromEvent(event);
      const world = screenToWorld(screen.x, screen.y);

      // Middle button always pans; left button defers to the parent.
      let mode: GestureMode = "pan";
      if (event.button === 0 && onPointerDownRef.current) {
        const result = onPointerDownRef.current({
          worldPoint: world,
          screenPoint: screen,
          button: event.button,
          modifiers: modifiersFrom(event)
        });
        if (result === "pan") mode = "pan";
        else if (result === "ignore") mode = "ignore";
        else mode = { kind: "custom", handler: result };
      }

      gestureRef.current = {
        pointerId: event.pointerId,
        button: event.button,
        startScreenX: event.clientX,
        startScreenY: event.clientY,
        startWorldX: world.x,
        startWorldY: world.y,
        lastScreenX: event.clientX,
        lastScreenY: event.clientY,
        lastModifiers: modifiersFrom(event),
        moved: false,
        mode
      };
    },
    [screenPointFromEvent, screenToWorld, onPointerDownRef]
  );

  /** Re-fire the active drag's `onDragMove` at the last pointer position —
   *  the pointer is still, but the world under it changed (wheel scroll /
   *  zoom, keyboard zoom, auto-pan). */
  const viewportChanged = useCallback(() => {
    const g = gestureRef.current;
    const canvas = canvasRef.current;
    if (!g || !g.moved || g.mode === "pan" || g.mode === "ignore" || !canvas) return;
    const rect = canvas.getBoundingClientRect();
    const screen = { x: g.lastScreenX - rect.left, y: g.lastScreenY - rect.top };
    g.mode.handler.onDragMove?.({
      worldPoint: screenToWorld(screen.x, screen.y),
      startWorld: { x: g.startWorldX, y: g.startWorldY },
      screenPoint: screen,
      modifiers: g.lastModifiers
    });
  }, [canvasRef, screenToWorld]);

  const stopAutoPan = useCallback(() => {
    if (autoPanFrameRef.current !== null) {
      cancelAnimationFrame(autoPanFrameRef.current);
      autoPanFrameRef.current = null;
    }
  }, []);

  /** Pan velocity (CSS px / 60 Hz frame) for a pointer at client (x, y):
   *  zero inside the edge band, rising to AUTO_PAN_SPEED_PX at the edge and
   *  up to twice that further out. */
  const autoPanVelocity = useCallback(
    (clientX: number, clientY: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return { vx: 0, vy: 0 };
      const r = canvas.getBoundingClientRect();
      const axis = (p: number, lo: number, hi: number) => {
        const depth = (d: number) =>
          Math.min(2, Math.max(0, (AUTO_PAN_EDGE_PX - d) / AUTO_PAN_EDGE_PX)) * AUTO_PAN_SPEED_PX;
        if (p - lo < AUTO_PAN_EDGE_PX) return -depth(p - lo);
        if (hi - p < AUTO_PAN_EDGE_PX) return depth(hi - p);
        return 0;
      };
      return { vx: axis(clientX, r.left, r.right), vy: axis(clientY, r.top, r.bottom) };
    },
    [canvasRef]
  );

  /** Start the auto-pan loop if the active drag wants it and the pointer is
   *  in the edge band; the loop stops itself once it leaves. */
  const maybeAutoPan = useCallback(() => {
    if (autoPanFrameRef.current !== null) return;
    let last = performance.now();
    const step = (now: number) => {
      const g = gestureRef.current;
      if (!g || !g.moved || g.mode === "pan" || g.mode === "ignore" || !g.mode.handler.autoPan) {
        autoPanFrameRef.current = null;
        return;
      }
      const { vx, vy } = autoPanVelocity(g.lastScreenX, g.lastScreenY);
      if (vx === 0 && vy === 0) {
        autoPanFrameRef.current = null;
        return;
      }
      const frames = Math.min(4, Math.max(0, (now - last) / (1000 / 60)));
      last = now;
      const vp = viewportRef.current;
      setViewport({
        originX: vp.originX + (vx * frames) / vp.zoom,
        originY: vp.originY + (vy * frames) / vp.zoom,
        zoom: vp.zoom
      });
      autoPanFrameRef.current = requestAnimationFrame(step);
    };
    autoPanFrameRef.current = requestAnimationFrame(step);
  }, [autoPanVelocity, setViewport, viewportRef]);

  useEffect(() => stopAutoPan, [stopAutoPan]);

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const g = gestureRef.current;
      if (!g || g.pointerId !== event.pointerId) return;

      const wasMoved = g.moved;
      if (!g.moved) {
        const totalDx = event.clientX - g.startScreenX;
        const totalDy = event.clientY - g.startScreenY;
        if (Math.hypot(totalDx, totalDy) > CLICK_MOVE_THRESHOLD_PX) g.moved = true;
      }

      g.lastModifiers = modifiersFrom(event);
      if (g.mode === "ignore") {
        g.lastScreenX = event.clientX;
        g.lastScreenY = event.clientY;
        return;
      }

      if (g.mode === "pan") {
        if (g.moved) {
          const dx = event.clientX - g.lastScreenX;
          const dy = event.clientY - g.lastScreenY;
          const vp = viewportRef.current;
          setViewport({
            originX: vp.originX - dx / vp.zoom,
            originY: vp.originY - dy / vp.zoom,
            zoom: vp.zoom
          });
        }
      } else {
        const screen = screenPointFromEvent(event);
        const world = screenToWorld(screen.x, screen.y);
        const e: DragEventData = {
          worldPoint: world,
          startWorld: { x: g.startWorldX, y: g.startWorldY },
          screenPoint: screen,
          modifiers: modifiersFrom(event)
        };
        if (!wasMoved && g.moved) g.mode.handler.onDragStart?.(e);
        if (g.moved) g.mode.handler.onDragMove?.(e);
      }

      g.lastScreenX = event.clientX;
      g.lastScreenY = event.clientY;
      if (g.moved && g.mode !== "pan" && g.mode.handler.autoPan) maybeAutoPan();
    },
    [setViewport, screenPointFromEvent, screenToWorld, viewportRef, maybeAutoPan]
  );

  const onPointerUp = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const g = gestureRef.current;
      if (!g || g.pointerId !== event.pointerId) return;
      event.currentTarget.releasePointerCapture(event.pointerId);
      gestureRef.current = null;
      stopAutoPan();

      if (g.mode === "ignore") return;

      const screen = screenPointFromEvent(event);
      const world = screenToWorld(screen.x, screen.y);

      if (g.mode === "pan") {
        if (!g.moved && g.button === 0 && onCanvasClickRef.current) {
          onCanvasClickRef.current(world);
        }
      } else {
        g.mode.handler.onPointerUp({
          worldPoint: world,
          startWorld: { x: g.startWorldX, y: g.startWorldY },
          screenPoint: screen,
          modifiers: modifiersFrom(event),
          dragged: g.moved
        });
      }
    },
    [screenPointFromEvent, screenToWorld, onCanvasClickRef, stopAutoPan]
  );

  const onPointerCancel = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const g = gestureRef.current;
      if (!g || g.pointerId !== event.pointerId) return;
      gestureRef.current = null;
      stopAutoPan();
      if (g.mode !== "pan" && g.mode !== "ignore") g.mode.handler.onCancel?.();
    },
    [stopAutoPan]
  );

  // Native wheel handler bound non-passively so we can preventDefault.
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const cssX = e.clientX - rect.left;
      const cssY = e.clientY - rect.top;
      const vp = viewportRef.current;
      if (e.ctrlKey || e.metaKey) {
        const factor = Math.exp(-e.deltaY * WHEEL_ZOOM_FACTOR);
        const newZoom = vp.zoom * factor;
        const worldX = vp.originX + cssX / vp.zoom;
        const worldY = vp.originY + cssY / vp.zoom;
        const clamped = Math.max(minZoom, Math.min(maxZoom, newZoom));
        setViewport({
          originX: worldX - cssX / clamped,
          originY: worldY - cssY / clamped,
          zoom: clamped
        });
      } else {
        setViewport({
          originX: vp.originX + e.deltaX / vp.zoom,
          originY: vp.originY + e.deltaY / vp.zoom,
          zoom: vp.zoom
        });
      }
    };
    const preventGesture = (e: Event) => e.preventDefault();
    el.addEventListener("wheel", handler, { passive: false });
    el.addEventListener("gesturestart", preventGesture, { passive: false });
    el.addEventListener("gesturechange", preventGesture, { passive: false });
    el.addEventListener("gestureend", preventGesture, { passive: false });
    return () => {
      el.removeEventListener("wheel", handler);
      el.removeEventListener("gesturestart", preventGesture);
      el.removeEventListener("gesturechange", preventGesture);
      el.removeEventListener("gestureend", preventGesture);
    };
  }, [canvasRef, viewportRef, minZoom, maxZoom, setViewport]);

  return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, viewportChanged };
}
