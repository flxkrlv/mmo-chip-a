import { useCallback, useEffect, useImperativeHandle, useRef, type Ref } from "react";
import { TiledRenderer } from "./TiledRenderer";
import { useCanvasGestures } from "./useCanvasGestures";
import type { Layer, Viewport } from "./types";
import type {
  Interaction,
  PointerEventData
} from "./interaction";

// Re-exported so existing import sites (`from "../renderer/TiledCanvas"`)
// keep working; the contract itself lives in ./interaction.
export type {
  DragEventData,
  DragHandler,
  Interaction,
  PointerEventData,
  PointerModifiers
} from "./interaction";

/** Imperative handle exposed via `ref` so the parent can drive pan/zoom programmatically. */
export interface TiledCanvasHandle {
  setViewport: (v: Viewport) => void;
  getViewport: () => Viewport;
  invalidate: () => void;
  /** Re-renders all visible tiles immediately on the next frame. */
  refresh: () => void;
  /** Center the view on a world point at the given zoom. */
  centerOn: (worldX: number, worldY: number, zoom?: number) => void;
}

export interface TiledCanvasProps {
  layers: Layer[];
  initialViewport: Viewport;
  tileSize?: number;
  background?: string;
  onViewportChange?: (viewport: Viewport) => void;
  /**
   * Called on left-button pointer-down. Return value decides what the canvas
   * does with this gesture. If omitted, defaults to `"pan"` (current behavior).
   * Middle-button always pans regardless of this prop.
   */
  onPointerDown?: (e: PointerEventData) => Interaction;
  /** Fires on a left-button click in `"pan"` mode that didn't cross the click
   *  threshold. Not called when `onPointerDown` returns a DragHandler. */
  onCanvasClick?: (worldPoint: { x: number; y: number }) => void;
  /** Min/max zoom guards. */
  minZoom?: number;
  maxZoom?: number;
  /** CSS cursor for the canvas (default: "default"). */
  cursor?: string;
  handleRef?: Ref<TiledCanvasHandle>;
}

export function TiledCanvas({
  layers,
  initialViewport,
  tileSize,
  background = "#0c0c08",
  onViewportChange,
  onPointerDown,
  onCanvasClick,
  minZoom = 0.01,
  maxZoom = 32,
  cursor = "default",
  handleRef
}: TiledCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<TiledRenderer | null>(null);
  const viewportRef = useRef<Viewport>(initialViewport);
  const onViewportChangeRef = useRef(onViewportChange);
  onViewportChangeRef.current = onViewportChange;
  const onPointerDownRef = useRef(onPointerDown);
  onPointerDownRef.current = onPointerDown;
  const onCanvasClickRef = useRef(onCanvasClick);
  onCanvasClickRef.current = onCanvasClick;

  const setViewport = useCallback(
    (v: Viewport) => {
      const clamped: Viewport = {
        originX: v.originX,
        originY: v.originY,
        zoom: Math.max(minZoom, Math.min(maxZoom, v.zoom))
      };
      viewportRef.current = clamped;
      rendererRef.current?.setViewport(clamped);
      onViewportChangeRef.current?.(clamped);
    },
    [minZoom, maxZoom]
  );

  useImperativeHandle(
    handleRef,
    () => ({
      setViewport,
      getViewport: () => viewportRef.current,
      invalidate: () => rendererRef.current?.invalidate(),
      refresh: () => rendererRef.current?.invalidate(),
      centerOn: (worldX, worldY, zoom) => {
        const cur = viewportRef.current;
        const z = zoom ?? cur.zoom;
        const canvas = canvasRef.current;
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        setViewport({
          originX: worldX - rect.width / 2 / z,
          originY: worldY - rect.height / 2 / z,
          zoom: z
        });
      }
    }),
    [setViewport]
  );

  // Mount the renderer.
  useEffect(() => {
    if (!canvasRef.current) return;
    const r = new TiledRenderer(canvasRef.current, { tileSize, background });
    rendererRef.current = r;
    r.resize();
    r.setViewport(viewportRef.current);

    const ro = new ResizeObserver(() => r.resize());
    ro.observe(canvasRef.current);

    return () => {
      ro.disconnect();
      r.destroy();
      rendererRef.current = null;
    };
    // We don't include tileSize/background in deps — they're set-and-forget.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Push layer updates to the renderer.
  useEffect(() => {
    rendererRef.current?.setLayers(layers);
  }, [layers]);

  const gestures = useCanvasGestures({
    canvasRef,
    viewportRef,
    setViewport,
    onPointerDownRef,
    onCanvasClickRef,
    minZoom,
    maxZoom
  });

  return (
    <canvas
      ref={canvasRef}
      onPointerDown={gestures.onPointerDown}
      onPointerMove={gestures.onPointerMove}
      onPointerUp={gestures.onPointerUp}
      onPointerCancel={gestures.onPointerCancel}
      style={{
        width: "100%",
        height: "100%",
        display: "block",
        touchAction: "none",
        cursor
      }}
    />
  );
}

/**
 * Fit an arbitrary world rect into the canvas, centered, with `marginPx`
 * breathing room on every side. Zoom is capped at `maxZoom` so framing a tiny
 * item (a pin / via point) doesn't slam to absurd magnification. Degenerate
 * (zero-extent) rects are treated as a small box around their center.
 */
export function fitRectViewport(
  rect: { x: number; y: number; width: number; height: number },
  cssWidth: number,
  cssHeight: number,
  marginPx = 48,
  maxZoom = Infinity
): Viewport {
  const w = Math.max(rect.width, 1e-6);
  const h = Math.max(rect.height, 1e-6);
  const availW = Math.max(1, cssWidth - marginPx * 2);
  const availH = Math.max(1, cssHeight - marginPx * 2);
  const zoom = Math.min(maxZoom, availW / w, availH / h);
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  return {
    originX: cx - cssWidth / 2 / zoom,
    originY: cy - cssHeight / 2 / zoom,
    zoom
  };
}

/** Helper: fit a world rect to the canvas, returning a viewport. */
export function fitViewport(
  worldWidth: number,
  worldHeight: number,
  cssWidth: number,
  cssHeight: number,
  padding = 0
): Viewport {
  const zoomX = (cssWidth - padding * 2) / worldWidth;
  const zoomY = (cssHeight - padding * 2) / worldHeight;
  const zoom = Math.min(zoomX, zoomY);
  return {
    originX: worldWidth / 2 - cssWidth / 2 / zoom,
    originY: worldHeight / 2 - cssHeight / 2 / zoom,
    zoom
  };
}
