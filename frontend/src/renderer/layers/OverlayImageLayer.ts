import type { Rect } from "../../lib/geometry";
import type { OverlayImageSource } from "../../api/overlayImages";
import type { Layer, TileBounds } from "../types";

const MAX_IMAGE_TILES_CACHED = 256;

interface CachedImageTile {
  z: number;
  x: number;
  y: number;
  image: HTMLImageElement;
  loaded: boolean;
  failed: boolean;
  lastUsed: number;
}

export interface OverlayViewportStats {
  /** Number of target pyramid tiles intersecting the visible viewport. */
  total: number;
  /** Target tiles decoded and available to paint. */
  loaded: number;
  /** Target tiles still missing or decoding. */
  pending: number;
  /** A coarse level is visible while sharper target tiles arrive. */
  preview: boolean;
  /** Elapsed time for the current viewport wave, frozen once it is complete. */
  lastRenderMs: number | null;
}
export interface OverlayImageDisplay {
  getImage: () => HTMLImageElement | null;
  getSource?: () => OverlayImageSource | null;
  getHidden: () => boolean;
  getOpacity: () => number;
  getOffsetX: () => number;
  getOffsetY: () => number;
}

/**
 * Draws a legacy static image or a manifest-backed tile pyramid.
 *
 * A tiled source is rendered progressively: cached coarse levels fill the
 * viewport first; target-level tiles replace that preview when decoded.  This
 * prevents a zoom from exposing an empty/black canvas while a cold high-detail
 * level is being generated on the server.
 */
export class OverlayImageLayer implements Layer {
  private invalidateCb: ((worldRect?: Rect) => void) | null = null;
  private readonly cache = new Map<string, CachedImageTile>();
  private useCounter = 0;
  private scratch: HTMLCanvasElement | null = null;
  private viewportEpoch = 0;
  private viewportEpochAt = 0;
  private viewportStatsKey: string | null = null;
  private viewportStatsStartedAt = 0;
  private viewportStatsCompletedMs: number | null = null;

  constructor(
    public readonly id: string,
    private readonly dieId: string,
    private readonly display: OverlayImageDisplay
  ) {}

  subscribe(invalidate: (worldRect?: Rect) => void): () => void {
    this.invalidateCb = invalidate;
    return () => { this.invalidateCb = null; };
  }

  worldRect(): Rect | null {
    const source = this.display.getSource?.();
    if (source) {
      return {
        x: this.display.getOffsetX(),
        y: this.display.getOffsetY(),
        width: source.width,
        height: source.height
      };
    }
    const image = this.display.getImage();
    return image
      ? {
          x: this.display.getOffsetX(),
          y: this.display.getOffsetY(),
          width: image.naturalWidth,
          height: image.naturalHeight
        }
      : null;
  }

  /**
   * Returns the state of target tiles that intersect the currently visible
   * world rect. This is deliberately side-effect free: it observes the same
   * cache that drawTiled uses and never starts network requests.
   */
  getViewportStats(world: Rect, zoom: number): OverlayViewportStats | null {
    if (this.display.getHidden() || this.display.getOpacity() <= 0) return null;
    const source = this.display.getSource?.();
    if (!source?.ready) return null;

    const targetLevel = this.pickLevel(source, zoom);
    const level = source.levels[targetLevel];
    if (!level) return null;

    const offsetX = this.display.getOffsetX();
    const offsetY = this.display.getOffsetY();
    const tileWorldSize = source.tileSize * level.scale;
    const minX = Math.max(0, Math.floor((world.x - offsetX) / tileWorldSize));
    const maxX = Math.min(
      level.columns - 1,
      Math.floor((world.x + world.width - offsetX - 1e-6) / tileWorldSize)
    );
    const minY = Math.max(0, Math.floor((world.y - offsetY) / tileWorldSize));
    const maxY = Math.min(
      level.rows - 1,
      Math.floor((world.y + world.height - offsetY - 1e-6) / tileWorldSize)
    );
    if (minX > maxX || minY > maxY) return null;

    let total = 0;
    let loaded = 0;
    for (let x = minX; x <= maxX; x += 1) {
      for (let y = minY; y <= maxY; y += 1) {
        total += 1;
        const tile = this.cache.get(`${source.id}/${targetLevel}/${x}/${y}`);
        if (tile?.loaded && !tile.failed) loaded += 1;
      }
    }
    const pending = total - loaded;
    const key = `${source.id}/${targetLevel}/${minX}/${maxX}/${minY}/${maxY}`;
    const now = performance.now();
    if (this.viewportStatsKey !== key) {
      this.viewportStatsKey = key;
      this.viewportStatsStartedAt = now;
      this.viewportStatsCompletedMs = null;
    }
    if (pending === 0 && this.viewportStatsCompletedMs == null) {
      this.viewportStatsCompletedMs = now - this.viewportStatsStartedAt;
    }

    return {
      total,
      loaded,
      pending,
      preview: targetLevel > 0 && pending > 0,
      lastRenderMs:
        this.viewportStatsCompletedMs ?? Math.max(0, now - this.viewportStatsStartedAt)
    };
  }
  draw(ctx: CanvasRenderingContext2D, bounds: TileBounds): void {
    if (this.display.getHidden()) return;
    const opacity = this.display.getOpacity();
    if (opacity <= 0) return;

    const source = this.display.getSource?.();
    if (source?.ready) {
      this.drawTiled(ctx, bounds, source, opacity);
      return;
    }
    this.drawStatic(ctx, bounds, opacity);
  }

  private drawStatic(
    ctx: CanvasRenderingContext2D,
    bounds: TileBounds,
    opacity: number
  ): void {
    const image = this.display.getImage();
    if (!image) return;
    const x = this.display.getOffsetX();
    const y = this.display.getOffsetY();
    const left = Math.max(bounds.world.x, x);
    const top = Math.max(bounds.world.y, y);
    const right = Math.min(bounds.world.x + bounds.world.width, x + image.naturalWidth);
    const bottom = Math.min(bounds.world.y + bounds.world.height, y + image.naturalHeight);
    if (left >= right || top >= bottom) return;

    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.drawImage(
      image,
      left - x,
      top - y,
      right - left,
      bottom - top,
      left,
      top,
      right - left,
      bottom - top
    );
    ctx.restore();
  }

  private drawTiled(
    ctx: CanvasRenderingContext2D,
    bounds: TileBounds,
    source: OverlayImageSource,
    opacity: number
  ): void {
    const targetLevel = this.pickLevel(source, bounds.zoom);

    // Progressive enhancement: draw every coarser level whose tiles we already
    // have in cache, then overdraw the target level.  This means there's always
    // some content visible while finer tiles are still loading — no black flash
    // when zooming in.  We only fire network requests for the target level, so
    // coarser levels are pure-cache reads.
    const scratch = this.getScratch(bounds);
    const scratchCtx = scratch.getContext("2d");
    if (!scratchCtx) return;
    this.prepareScratchContext(scratchCtx, bounds);

    for (let z = 0; z < targetLevel; z += 1) {
      this.drawLevel(scratchCtx, source, z, bounds.world, false);
    }
    this.drawLevel(scratchCtx, source, targetLevel, bounds.world, true);
    this.blitScratch(ctx, scratch, opacity);
  }

  private getScratch(bounds: TileBounds): HTMLCanvasElement {
    const desired = Math.max(1, Math.round(bounds.size * bounds.dpr));
    if (!this.scratch) this.scratch = document.createElement("canvas");
    if (this.scratch.width !== desired || this.scratch.height !== desired) {
      this.scratch.width = desired;
      this.scratch.height = desired;
    }
    return this.scratch;
  }

  private prepareScratchContext(
    scratchCtx: CanvasRenderingContext2D,
    bounds: TileBounds
  ): void {
    const scale = bounds.dpr * bounds.zoom;
    scratchCtx.setTransform(1, 0, 0, 1, 0, 0);
    scratchCtx.clearRect(0, 0, this.scratch?.width ?? 0, this.scratch?.height ?? 0);
    scratchCtx.setTransform(scale, 0, 0, scale, -bounds.world.x * scale, -bounds.world.y * scale);
  }

  private blitScratch(
    ctx: CanvasRenderingContext2D,
    scratch: HTMLCanvasElement,
    opacity: number
  ): void {
    ctx.save();
    ctx.globalAlpha = opacity;
    // TiledRenderer has a world-to-canvas transform active. Scratch is already
    // in device pixels, so reset before blitting it.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(scratch, 0, 0);
    ctx.restore();
  }

  private pickLevel(source: OverlayImageSource, zoom: number): number {
    const levels = source.levels;
    const maxScale = 1 / Math.max(zoom, 1e-6);
    for (let z = 0; z < levels.length; z++) {
      if (levels[z].scale <= maxScale) return z;
    }
    return levels.length - 1;
  }


  private drawLevel(
    ctx: CanvasRenderingContext2D,
    source: OverlayImageSource,
    z: number,
    world: Rect,
    fetchMissing: boolean
  ): void {
    const level = source.levels[z];
    if (!level) return;
    const offsetX = this.display.getOffsetX();
    const offsetY = this.display.getOffsetY();
    const tileWorldSize = source.tileSize * level.scale;
    const minX = Math.max(0, Math.floor((world.x - offsetX) / tileWorldSize));
    const maxX = Math.min(
      level.columns - 1,
      Math.floor((world.x + world.width - offsetX - 1e-6) / tileWorldSize)
    );
    const minY = Math.max(0, Math.floor((world.y - offsetY) / tileWorldSize));
    const maxY = Math.min(
      level.rows - 1,
      Math.floor((world.y + world.height - offsetY - 1e-6) / tileWorldSize)
    );
    if (minX > maxX || minY > maxY) return;

    const centerX = (world.x + world.width / 2 - offsetX) / tileWorldSize;
    const centerY = (world.y + world.height / 2 - offsetY) / tileWorldSize;
    const coordinates: Array<{ x: number; y: number; distance: number }> = [];
    for (let x = minX; x <= maxX; x += 1) {
      for (let y = minY; y <= maxY; y += 1) {
        coordinates.push({
          x,
          y,
          distance: (x - centerX) ** 2 + (y - centerY) ** 2
        });
      }
    }
    // Assign image.src in center-first order. Browser connection slots are
    // therefore consumed by tiles where the user is looking before edge tiles.
    coordinates.sort((a, b) => a.distance - b.distance);
    for (const { x, y, distance } of coordinates) {
      const key = `${source.id}/${z}/${x}/${y}`;
      let tile = this.cache.get(key);
      if (!tile && fetchMissing) {
        // Distance is in tile cells. Keep a bounded integer priority suitable
        // for the server scheduler; viewport-center tiles are requested first.
        // Epoch dominates stale queued viewport work on the server; distance
        // ranks tiles within the current viewport batch (center before edges).
        const priority = this.getViewportEpoch() * 1_000 - Math.round(distance * 100);
        tile = this.getOrLoadTile(source, z, x, y, priority);
      }
      if (!tile?.loaded || tile.failed) continue;
      ctx.drawImage(
        tile.image,
        offsetX + x * tileWorldSize,
        offsetY + y * tileWorldSize,
        tile.image.naturalWidth * level.scale,
        tile.image.naturalHeight * level.scale
      );
      tile.lastUsed = ++this.useCounter;
    }
  }

  /**
   * Repaint only the world-space area affected by one source tile.  This mirrors
   * DieImageLayer and avoids invalidating every visible canvas tile whenever a
   * sharp overlay tile arrives.
   */
  private invalidateTileRect(
    source: OverlayImageSource,
    z: number,
    x: number,
    y: number,
    image?: HTMLImageElement
  ): void {
    const level = source.levels[z];
    if (!level) return;
    const tileWorldSize = source.tileSize * level.scale;
    const width = image?.naturalWidth
      ? image.naturalWidth * level.scale
      : tileWorldSize;
    const height = image?.naturalHeight
      ? image.naturalHeight * level.scale
      : tileWorldSize;
    this.invalidateCb?.({
      x: this.display.getOffsetX() + x * tileWorldSize,
      y: this.display.getOffsetY() + y * tileWorldSize,
      width,
      height
    });
  }

  private getOrLoadTile(
    source: OverlayImageSource,
    z: number,
    x: number,
    y: number,
    priority: number
  ): CachedImageTile {
    const key = `${source.id}/${z}/${x}/${y}`;
    const existing = this.cache.get(key);
    if (existing) return existing;

    const image = new Image();
    image.decoding = "async";
    const tile: CachedImageTile = {
      z,
      x,
      y,
      image,
      loaded: false,
      failed: false,
      lastUsed: ++this.useCounter
    };
    this.cache.set(key, tile);
    const requestedAt = performance.now();
    image.onload = () => {
      tile.loaded = true;
      this.recordTileMetric("load", requestedAt);
      this.invalidateTileRect(source, z, x, y, image);
    };
    image.onerror = () => {
      tile.failed = true;
      this.recordTileMetric("error", requestedAt);
      this.invalidateTileRect(source, z, x, y);
    };
    image.src = `/api/dies/${encodeURIComponent(this.dieId)}/overlay-images/${encodeURIComponent(source.id)}/tiles/${z}/${x}/${y}?p=${priority}`;
    this.evictIfNeeded();
    return tile;
  }

  private getViewportEpoch(): number {
    const now = Date.now();
    // A render wave within 40 ms belongs to one viewport; a later pan/zoom gets
    // a newer epoch and therefore overtakes stale jobs still waiting on server.
    if (now - this.viewportEpochAt >= 40 || this.viewportEpoch === 0) {
      this.viewportEpoch = now;
      this.viewportEpochAt = now;
    }
    return this.viewportEpoch;
  }

  /**
   * Browser-visible tile timings. Inspect in DevTools console with
   * performance.getEntriesByName("mmo:tiled-overlay:load").
   */
  private recordTileMetric(kind: "load" | "error", requestedAt: number): void {
    if (typeof performance === "undefined") return;
    const name = `mmo:tiled-overlay:${kind}`;
    if (performance.getEntriesByName(name).length >= 250) {
      performance.clearMeasures(name);
    }
    performance.measure(name, { start: requestedAt, end: performance.now() });
  }

  private evictIfNeeded(): void {
    if (this.cache.size <= MAX_IMAGE_TILES_CACHED) return;
    const entries = [...this.cache.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    const drop = this.cache.size - MAX_IMAGE_TILES_CACHED;
    for (let i = 0; i < drop; i++) this.cache.delete(entries[i][0]);
  }

  dispose(): void {
    this.invalidateCb = null;
    this.cache.clear();
    this.scratch?.remove();
    this.scratch = null;
  }
}
