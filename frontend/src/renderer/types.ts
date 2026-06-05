import type { Rect } from "../lib/geometry";

/**
 * Viewport state. World coordinates are in "world units" (for the die viewer,
 * one world unit = one source-image pixel). `originX`/`originY` is the world
 * coordinate that maps to the canvas top-left corner. `zoom` is CSS pixels per
 * world unit (e.g. `zoom: 0.5` → world is shown at half size on screen).
 */
export interface Viewport {
  originX: number;
  originY: number;
  zoom: number;
}

/** Per-tile context passed to a `Layer.draw` call. */
export interface TileBounds {
  /** Tile pixel size in CSS pixels (zoom-independent). */
  size: number;
  /** Tile grid indices. */
  i: number;
  j: number;
  /** World rect this tile covers. */
  world: Rect;
  /** Device pixel ratio at render time. */
  dpr: number;
  /** Current zoom factor (CSS px per world unit). */
  zoom: number;
}

/**
 * Drawable layer. `draw` receives a 2D context already transformed so that
 * **drawing in world coordinates is the default** — i.e., calling
 * `ctx.fillRect(worldX, worldY, worldW, worldH)` will render to the right
 * pixels of the tile, at the right resolution for the current zoom and dpr.
 *
 * If a layer's content changes, call the `invalidate(worldRect?)` callback
 * supplied by `subscribe`; the renderer will mark all overlapping tiles dirty.
 */
export interface Layer {
  id: string;
  draw(ctx: CanvasRenderingContext2D, bounds: TileBounds): void;
  subscribe?(invalidate: (worldRect?: Rect) => void): () => void;
}
