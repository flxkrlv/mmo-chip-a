import type { Rect } from "../../lib/geometry";
import type { OverlayImageSource } from "../../api/overlayImages";
import type { Layer, RenderFrame, TileBounds } from "../types";
import { overlayTileQueue, type OverlayTileRequest } from "./overlayTileQueue";
import { overlayDebug } from "./overlayDiagnostics";

const MAX_IMAGE_TILES_CACHED = 256;

type TileState = "queued" | "loading" | "loaded" | "failed" | "cancelled";

interface CachedImageTile {
  z: number;
  x: number;
  y: number;
  image: HTMLImageElement | null;
  state: TileState;
  lastUsed: number;
  generation: number;
  request?: OverlayTileRequest;
  finishRequest?: () => void;
  startedAt?: number;
  url?: string;
}

type TileCoordinate = { x: number; y: number; distance: number };

export interface OverlayViewportStats {
  /** Number of target pyramid tiles intersecting the visible viewport. */
  total: number;
  /** Target tiles decoded and available to paint. */
  loaded: number;
  /** Target tiles still missing or decoding. */
  pending: number;
  /** Target requests waiting for one of the shared browser slots. */
  queued: number;
  /** Target requests currently downloading or decoding. */
  loading: number;
  /** Recently decoded target tiles, expressed as tiles per second. */
  tilesPerSecond: number;
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
  private lastFrameId = -1;
  private viewportGeneration = 0;
  private desiredTileKeys = new Set<string>();
  private recentLoads: number[] = [];
  private viewportStatsKey: string | null = null;
  private viewportStatsStartedAt = 0;
  private viewportStatsCompletedMs: number | null = null;
  private debugWaveStartedAt = 0;
  private debugCompletedGeneration = -1;
  private lastDebugCameraKey: string | null = null;

  constructor(
    public readonly id: string,
    private readonly dieId: string,
    private readonly display: OverlayImageDisplay
  ) {}

  subscribe(invalidate: (worldRect?: Rect) => void): () => void {
    this.invalidateCb = invalidate;
    return () => { this.invalidateCb = null; };
  }

  beginFrame(frame: RenderFrame): void {
    if (frame.id === this.lastFrameId) return;
    this.lastFrameId = frame.id;

    const source = this.display.getSource?.();
    if (
      this.display.getHidden() ||
      this.display.getOpacity() <= 0 ||
      !source?.ready
    ) {
      this.setDesiredTiles(new Set());
      return;
    }

    const level = this.pickLevel(source, frame.viewport.zoom);
    const coordinates = this.visibleCoordinates(source, level, frame.world);
    const desired = new Set(
      coordinates.map(({ x, y }) => this.tileKey(source, level, x, y))
    );
    const cameraKey = `${source.id}/${frame.viewport.originX.toFixed(1)}/${frame.viewport.originY.toFixed(1)}/${frame.viewport.zoom.toFixed(4)}`;
    if (cameraKey !== this.lastDebugCameraKey) {
      this.lastDebugCameraKey = cameraKey;
      overlayDebug("camera", {
        layerId: this.id,
        sourceId: source.id,
        details: {
          frameId: frame.id,
          originX: frame.viewport.originX,
          originY: frame.viewport.originY,
          zoom: frame.viewport.zoom,
          targetLevel: level,
          visibleTiles: coordinates.length
        }
      });
    }

    const previousGeneration = this.viewportGeneration;
    this.setDesiredTiles(desired);
    if (this.viewportGeneration !== previousGeneration) {
      this.debugWaveStartedAt = performance.now();
      this.debugCompletedGeneration = -1;
      overlayDebug("wave-start", {
        layerId: this.id,
        sourceId: source.id,
        viewportGeneration: this.viewportGeneration,
        details: { targetLevel: level, tileCount: coordinates.length }
      });
    }

    const epoch = this.viewportGeneration;
    for (const { x, y, distance } of coordinates) {
      this.scheduleTile(source, level, x, y, distance, epoch);
    }
    this.maybeLogWaveComplete(source, epoch);
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
    let queued = 0;
    let loading = 0;
    for (let x = minX; x <= maxX; x += 1) {
      for (let y = minY; y <= maxY; y += 1) {
        total += 1;
        const tile = this.cache.get(this.tileKey(source, targetLevel, x, y));
        if (tile?.state === "loaded") loaded += 1;
        else if (tile?.state === "queued") queued += 1;
        else if (tile?.state === "loading") loading += 1;
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

    const throughputWindowMs = 3_000;
    this.recentLoads = this.recentLoads.filter((loadedAt) => now - loadedAt <= throughputWindowMs);

    return {
      total,
      loaded,
      pending,
      queued,
      loading,
      tilesPerSecond: this.recentLoads.length / (throughputWindowMs / 1_000),
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
      this.drawLevel(scratchCtx, source, z, bounds.world);
    }
    this.drawLevel(scratchCtx, source, targetLevel, bounds.world);
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
    world: Rect
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

    for (let x = minX; x <= maxX; x += 1) {
      for (let y = minY; y <= maxY; y += 1) {
        const tile = this.cache.get(this.tileKey(source, z, x, y));
        if (tile?.state !== "loaded" || !tile.image) continue;
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

  private tileKey(source: OverlayImageSource, z: number, x: number, y: number): string {
    return `${source.id}/${z}/${x}/${y}`;
  }

  private visibleCoordinates(
    source: OverlayImageSource,
    z: number,
    world: Rect
  ): TileCoordinate[] {
    const level = source.levels[z];
    if (!level) return [];
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
    if (minX > maxX || minY > maxY) return [];

    const centerX = (world.x + world.width / 2 - offsetX) / tileWorldSize;
    const centerY = (world.y + world.height / 2 - offsetY) / tileWorldSize;
    const coordinates: TileCoordinate[] = [];
    for (let x = minX; x <= maxX; x += 1) {
      for (let y = minY; y <= maxY; y += 1) {
        coordinates.push({ x, y, distance: (x - centerX) ** 2 + (y - centerY) ** 2 });
      }
    }
    return coordinates.sort((left, right) => left.distance - right.distance);
  }

  private setDesiredTiles(next: Set<string>): void {
    if (setsEqual(this.desiredTileKeys, next)) return;
    this.viewportGeneration += 1;
    this.desiredTileKeys = next;
    for (const [key, tile] of this.cache) {
      if ((tile.state === "queued" || tile.state === "loading") && !next.has(key)) {
        this.cancelTile(key, tile);
      }
    }
  }

  private scheduleTile(
    source: OverlayImageSource,
    z: number,
    x: number,
    y: number,
    distance: number,
    viewportGeneration: number
  ): void {
    const key = this.tileKey(source, z, x, y);
    const existing = this.cache.get(key);
    if (
      existing?.state === "loaded" ||
      existing?.state === "queued" ||
      existing?.state === "loading" ||
      existing?.state === "failed"
    ) {
      return;
    }
    if (existing) this.cache.delete(key);

    const image = new Image();
    image.decoding = "async";
    const tile: CachedImageTile = {
      z,
      x,
      y,
      image,
      state: "queued",
      lastUsed: ++this.useCounter,
      generation: 0
    };
    const requestedAt = performance.now();
    const priority = viewportGeneration * 1_000 - Math.round(distance * 100);
    const request: OverlayTileRequest = {
      priority,
      cancelled: false,
      started: false,
      run: (finish) => {
        if (!this.isCurrentTile(key, viewportGeneration) || request.cancelled) {
          tile.state = "cancelled";
          overlayDebug("tile-cancelled", {
            layerId: this.id,
            sourceId: source.id,
            viewportGeneration,
            tile: { z, x, y },
            details: { reason: "stale-before-start", queuedMs: performance.now() - requestedAt }
          });
          if (this.cache.get(key) === tile) this.cache.delete(key);
          finish();
          return;
        }
        tile.state = "loading";
        tile.startedAt = performance.now();
        overlayDebug("tile-start", {
          layerId: this.id,
          sourceId: source.id,
          viewportGeneration,
          tile: { z, x, y },
          details: { queuedMs: tile.startedAt - requestedAt, priority }
        });
        tile.finishRequest = finish;
        const tileGeneration = tile.generation;
        image.onload = () =>
          this.completeTileLoad(
            key,
            tile,
            source,
            requestedAt,
            tileGeneration,
            viewportGeneration
          );
        image.onerror = () =>
          this.completeTileError(
            key,
            tile,
            source,
            requestedAt,
            tileGeneration,
            viewportGeneration
          );
        tile.url = `/api/dies/${encodeURIComponent(this.dieId)}/overlay-images/${encodeURIComponent(source.id)}/tiles/${z}/${x}/${y}?p=${priority}`;
        image.src = tile.url;
      }
    };
    tile.request = request;
    this.cache.set(key, tile);
    overlayDebug("tile-queued", {
      layerId: this.id,
      sourceId: source.id,
      viewportGeneration,
      tile: { z, x, y },
      details: { distance, priority }
    });
    overlayTileQueue.enqueue(request);
    this.evictIfNeeded();
  }

  private isCurrentTile(key: string, generation: number): boolean {
    return this.viewportGeneration === generation && this.desiredTileKeys.has(key);
  }

  private completeTileLoad(
    key: string,
    tile: CachedImageTile,
    source: OverlayImageSource,
    requestedAt: number,
    tileGeneration: number,
    viewportGeneration: number
  ): void {
    this.finishTileRequest(tile);
    if (
      tile.generation !== tileGeneration ||
      !this.isCurrentTile(key, viewportGeneration)
    ) {
      tile.state = "cancelled";
      if (this.cache.get(key) === tile) this.cache.delete(key);
      return;
    }
    tile.state = "loaded";
    this.recentLoads.push(performance.now());
    this.recordTileMetric("load", requestedAt);
    overlayDebug("tile-loaded", {
      layerId: this.id,
      sourceId: source.id,
      viewportGeneration,
      tile: { z: tile.z, x: tile.x, y: tile.y },
      details: this.tileTimingDetails(tile, requestedAt)
    });
    this.invalidateTileRect(source, tile.z, tile.x, tile.y, tile.image ?? undefined);
    this.maybeLogWaveComplete(source, viewportGeneration);
  }

  private completeTileError(
    key: string,
    tile: CachedImageTile,
    source: OverlayImageSource,
    requestedAt: number,
    tileGeneration: number,
    viewportGeneration: number
  ): void {
    this.finishTileRequest(tile);
    if (
      tile.generation !== tileGeneration ||
      !this.isCurrentTile(key, viewportGeneration)
    ) {
      tile.state = "cancelled";
      if (this.cache.get(key) === tile) this.cache.delete(key);
      return;
    }
    tile.state = "failed";
    this.recordTileMetric("error", requestedAt);
    overlayDebug("tile-error", {
      layerId: this.id,
      sourceId: source.id,
      viewportGeneration,
      tile: { z: tile.z, x: tile.x, y: tile.y },
      details: this.tileTimingDetails(tile, requestedAt)
    });
    this.invalidateTileRect(source, tile.z, tile.x, tile.y);
    this.maybeLogWaveComplete(source, viewportGeneration);
  }

  private tileTimingDetails(
    tile: CachedImageTile,
    requestedAt: number
  ): Record<string, number> {
    const now = performance.now();
    const startedAt = tile.startedAt ?? requestedAt;
    const details: Record<string, number> = {
      elapsedMs: now - requestedAt,
      queuedMs: startedAt - requestedAt,
      transferAndDecodeMs: now - startedAt
    };
    if (tile.url) {
      const entries = performance.getEntriesByName(tile.url, "resource");
      const resource = entries[entries.length - 1] as PerformanceResourceTiming | undefined;
      if (resource) {
        details.timeToFirstByteMs = Math.max(0, resource.responseStart - resource.requestStart);
        details.responseBodyMs = Math.max(0, resource.responseEnd - resource.responseStart);
        details.transferBytes = resource.transferSize;
        details.decodedBodyBytes = resource.decodedBodySize;
      }
    }
    return details;
  }

  private maybeLogWaveComplete(
    source: OverlayImageSource,
    viewportGeneration: number
  ): void {
    if (
      viewportGeneration !== this.viewportGeneration ||
      this.debugCompletedGeneration === viewportGeneration ||
      this.desiredTileKeys.size === 0
    ) {
      return;
    }

    let loaded = 0;
    let failed = 0;
    let pending = 0;
    for (const key of this.desiredTileKeys) {
      const tile = this.cache.get(key);
      if (tile?.state === "loaded") loaded += 1;
      else if (tile?.state === "failed") failed += 1;
      else pending += 1;
    }
    if (pending > 0) return;

    this.debugCompletedGeneration = viewportGeneration;
    overlayDebug("wave-complete", {
      layerId: this.id,
      sourceId: source.id,
      viewportGeneration,
      details: {
        total: this.desiredTileKeys.size,
        loaded,
        failed,
        durationMs: performance.now() - this.debugWaveStartedAt
      }
    });
  }

  private cancelTile(key: string, tile: CachedImageTile): void {
    const source = this.display.getSource?.();
    overlayDebug("tile-cancelled", {
      layerId: this.id,
      sourceId: source?.id,
      tile: { z: tile.z, x: tile.x, y: tile.y },
      details: { reason: tile.state, key }
    });
    tile.generation += 1;
    if (tile.request) overlayTileQueue.cancel(tile.request);
    tile.request = undefined;
    if (tile.image) {
      tile.image.onload = null;
      tile.image.onerror = null;
      tile.image.removeAttribute("src");
    }
    this.finishTileRequest(tile);
    tile.state = "cancelled";
    if (this.cache.get(key) === tile) this.cache.delete(key);
  }

  private finishTileRequest(tile: CachedImageTile): void {
    const finish = tile.finishRequest;
    tile.finishRequest = undefined;
    tile.request = undefined;
    finish?.();
  }

  /**
   * Browser-visible timing samples. The status bar uses these as a moving
   * throughput value while the current viewport resolves.
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
    for (let i = 0; i < drop; i++) {
      const [key, tile] = entries[i];
      if (tile.state === "queued" || tile.state === "loading") this.cancelTile(key, tile);
      else this.cache.delete(key);
    }
  }

  dispose(): void {
    this.invalidateCb = null;
    this.desiredTileKeys.clear();
    for (const [key, tile] of this.cache) {
      if (tile.state === "queued" || tile.state === "loading") this.cancelTile(key, tile);
    }
    this.cache.clear();
    this.scratch?.remove();
    this.scratch = null;
  }
}

function setsEqual(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false;
  for (const key of left) if (!right.has(key)) return false;
  return true;
}
