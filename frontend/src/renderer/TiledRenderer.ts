import type { Rect } from "../lib/geometry";
import type { Layer, RenderFrame, Viewport } from "./types";

const DEFAULT_TILE_SIZE = 256;
const MAX_CACHED_TILES = 256;

type TileKey = string; // "i,j"

interface CachedTile {
  i: number;
  j: number;
  canvas: HTMLCanvasElement;
  /** Zoom level the tile was rendered at — when zoom changes, all tiles must be re-rendered. */
  zoom: number;
  /** Monotonic counter for LRU eviction. */
  lastUsed: number;
}

export interface TiledRendererOptions {
  tileSize?: number;
  /** Canvas background color (drawn before any layer). */
  background?: string;
  /** Called whenever the viewport changes via setViewport (useful for status bar coords). */
  onViewportChange?: (viewport: Viewport) => void;
}

/**
 * Imperative tiled 2D canvas renderer. Owns a single visible <canvas> and a
 * cache of offscreen tile canvases, each TILE_SIZE × dpr pixels. Tiles are
 * anchored to world coordinates: tile (i, j) covers world rect
 * `[i·tw, j·tw]` to `[(i+1)·tw, (j+1)·tw]` where `tw = TILE_SIZE / zoom`.
 *
 * Lifecycle:
 *   const r = new TiledRenderer(canvas, { tileSize: 256 });
 *   r.setLayers(layers);
 *   r.resize();
 *   r.setViewport({ originX, originY, zoom });
 *   // ... user interactions ...
 *   r.destroy();
 */
export class TiledRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly tileSize: number;
  private readonly background: string;
  private readonly onViewportChange?: (v: Viewport) => void;

  private dpr = 1;
  private cssWidth = 0;
  private cssHeight = 0;

  private viewport: Viewport = { originX: 0, originY: 0, zoom: 1 };
  private layers: Layer[] = [];
  private layerUnsubs: Array<() => void> = [];

  private tiles = new Map<TileKey, CachedTile>();
  private dirty = new Set<TileKey>();
  private useCounter = 0;
  private frameCounter = 0;
  private rafId: number | null = null;
  private destroyed = false;

  constructor(canvas: HTMLCanvasElement, options: TiledRendererOptions = {}) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2d canvas context not available");
    this.ctx = ctx;
    this.tileSize = options.tileSize ?? DEFAULT_TILE_SIZE;
    this.background = options.background ?? "transparent";
    this.onViewportChange = options.onViewportChange;
  }

  setLayers(layers: Layer[]) {
    for (const unsub of this.layerUnsubs) unsub();
    this.layerUnsubs = [];
    this.layers = layers;
    for (const layer of layers) {
      if (layer.subscribe) {
        const unsub = layer.subscribe((worldRect) => this.invalidate(worldRect));
        this.layerUnsubs.push(unsub);
      }
    }
    this.invalidate();
  }

  setViewport(v: Viewport) {
    const zoomChanged = v.zoom !== this.viewport.zoom;
    this.viewport = v;
    if (zoomChanged) {
      // Tile→world mapping depends on zoom; all cached tiles are stale.
      this.tiles.clear();
      this.dirty.clear();
    }
    this.onViewportChange?.(v);
    this.requestRender();
  }

  getViewport(): Viewport {
    return this.viewport;
  }

  /** Sync the canvas's backing-store size to its CSS size × dpr. Call on resize. */
  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.dpr = dpr;
    this.cssWidth = rect.width;
    this.cssHeight = rect.height;
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
    this.requestRender();
  }

  /** Mark all (or a world rect's) tiles dirty. Pass nothing to invalidate everything. */
  invalidate(worldRect?: Rect) {
    if (!worldRect) {
      for (const key of this.tiles.keys()) this.dirty.add(key);
      // Also include not-yet-cached tiles in the visible region (handled on render).
      this.requestRender();
      return;
    }
    const tw = this.tileSize / this.viewport.zoom;
    if (!isFinite(tw) || tw <= 0) return;
    const minI = Math.floor(worldRect.x / tw);
    const maxI = Math.floor((worldRect.x + worldRect.width) / tw);
    const minJ = Math.floor(worldRect.y / tw);
    const maxJ = Math.floor((worldRect.y + worldRect.height) / tw);
    for (let i = minI; i <= maxI; i++) {
      for (let j = minJ; j <= maxJ; j++) {
        this.dirty.add(`${i},${j}`);
      }
    }
    this.requestRender();
  }

  /** Convert CSS-pixel canvas coords → world coords. */
  cssToWorld(x: number, y: number): { x: number; y: number } {
    return {
      x: this.viewport.originX + x / this.viewport.zoom,
      y: this.viewport.originY + y / this.viewport.zoom
    };
  }

  /** Convert world coords → CSS-pixel canvas coords. */
  worldToCss(x: number, y: number): { x: number; y: number } {
    return {
      x: (x - this.viewport.originX) * this.viewport.zoom,
      y: (y - this.viewport.originY) * this.viewport.zoom
    };
  }

  destroy() {
    this.destroyed = true;
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    for (const unsub of this.layerUnsubs) unsub();
    this.layerUnsubs = [];
    this.tiles.clear();
    this.dirty.clear();
  }

  private requestRender() {
    if (this.rafId !== null || this.destroyed) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = null;
      this.render();
    });
  }

  private render() {
    if (this.destroyed) return;
    const { tileSize, dpr, viewport: vp, ctx } = this;
    if (vp.zoom <= 0) return;

    const tw = tileSize / vp.zoom;
    const visW = this.cssWidth;
    const visH = this.cssHeight;
    const minI = Math.floor(vp.originX / tw);
    const maxI = Math.floor((vp.originX + visW / vp.zoom) / tw);
    const minJ = Math.floor(vp.originY / tw);
    const maxJ = Math.floor((vp.originY + visH / vp.zoom) / tw);
    const frame: RenderFrame = {
      id: ++this.frameCounter,
      world: {
        x: vp.originX,
        y: vp.originY,
        width: visW / vp.zoom,
        height: visH / vp.zoom
      },
      viewport: vp
    };

    // Give layers the complete current viewport before any individual canvas
    // tile is painted. Image layers use this to prioritise and cancel stale
    // asynchronous work at viewport granularity instead of per canvas tile.
    for (const layer of this.layers) {
      try {
        layer.beginFrame?.(frame);
      } catch (error) {
        console.error(`[renderer] layer "${layer.id}" beginFrame failed`, error);
      }
    }

    // Render any missing or dirty tiles in the visible window.
    for (let i = minI; i <= maxI; i++) {
      for (let j = minJ; j <= maxJ; j++) {
        const key = `${i},${j}`;
        const existing = this.tiles.get(key);
        if (!existing || existing.zoom !== vp.zoom || this.dirty.has(key)) {
          this.renderTile(i, j);
          this.dirty.delete(key);
        }
      }
    }

    // Composite.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (this.background === "transparent") {
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    } else {
      ctx.fillStyle = this.background;
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    }

    for (let i = minI; i <= maxI; i++) {
      for (let j = minJ; j <= maxJ; j++) {
        const t = this.tiles.get(`${i},${j}`);
        if (!t) continue;
        // Tile world origin → CSS pixel coords → device pixel coords for drawImage.
        const cssX = (i * tw - vp.originX) * vp.zoom;
        const cssY = (j * tw - vp.originY) * vp.zoom;
        ctx.drawImage(
          t.canvas,
          Math.round(cssX * dpr),
          Math.round(cssY * dpr),
          tileSize * dpr,
          tileSize * dpr
        );
        t.lastUsed = ++this.useCounter;
      }
    }

    this.evictIfNeeded();
  }

  private renderTile(i: number, j: number) {
    const { tileSize, dpr, viewport: vp } = this;
    const tw = tileSize / vp.zoom;
    const key = `${i},${j}`;
    let entry = this.tiles.get(key);
    const desiredSize = tileSize * dpr;
    if (!entry || entry.canvas.width !== desiredSize) {
      const canvas = document.createElement("canvas");
      canvas.width = desiredSize;
      canvas.height = desiredSize;
      entry = { i, j, canvas, zoom: vp.zoom, lastUsed: ++this.useCounter };
      this.tiles.set(key, entry);
    } else {
      entry.zoom = vp.zoom;
    }
    const tileCtx = entry.canvas.getContext("2d");
    if (!tileCtx) return;

    // Pre-transform: drawing in world coordinates lands in the right tile pixels.
    tileCtx.setTransform(1, 0, 0, 1, 0, 0);
    tileCtx.clearRect(0, 0, entry.canvas.width, entry.canvas.height);
    tileCtx.scale(dpr * vp.zoom, dpr * vp.zoom);
    tileCtx.translate(-i * tw, -j * tw);

    const bounds = {
      size: tileSize,
      i,
      j,
      world: { x: i * tw, y: j * tw, width: tw, height: tw },
      dpr,
      zoom: vp.zoom
    };

    for (const layer of this.layers) {
      tileCtx.save();
      try {
        layer.draw(tileCtx, bounds);
      } catch (error) {
        console.error(`[renderer] layer "${layer.id}" draw failed`, error);
      }
      tileCtx.restore();
    }
  }

  private evictIfNeeded() {
    if (this.tiles.size <= MAX_CACHED_TILES) return;
    const entries = [...this.tiles.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    const dropCount = this.tiles.size - MAX_CACHED_TILES;
    for (let i = 0; i < dropCount; i++) {
      this.tiles.delete(entries[i][0]);
    }
  }
}
