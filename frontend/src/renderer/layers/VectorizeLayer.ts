import type { DieMetadata, MLTracePolyline, VectorizeParams } from "shared";
import { rectsIntersect, type Point, type Rect } from "../../lib/geometry";
import { fetchVectorBlocks, vectorizeRegion } from "../../api/ml";
import type { Layer, RenderFrame, TileBounds } from "../types";

/**
 * Classical (no-model) metal vectorization overlay. Unlike `MLViasLayer`
 * (tile-block fetches of server-cached predictions), vectorize runs live on
 * the *viewport*: `beginFrame` sees the full visible world rect and schedules
 * ONE debounced region request per (viewport, params) change — scheduling in
 * `draw` doesn't work, because draw only sees per-tile rects (and canvas
 * tiles outside the die produce degenerate bboxes). The backend keeps its
 * own small LRU, and this layer keeps recently decoded regions so panning
 * back is instant.
 *
 * Drawing: amber mask outlines (what the threshold captured — the tuning
 * feedback) + solid centreline traces whose endpoints snap to device
 * contacts / terminals / pins exactly like ML traces. Materialization feeds
 * `collectTraces()` into the same traces→nets path the ML overlay uses.
 */

// Amber — reads as "classical CV, not the model" next to the ML cyan.
const VECT_TRACE_STROKE = "rgba(253, 224, 71, 0.95)";
const VECT_TRACE_SNAP_STROKE = "rgba(253, 224, 71, 0.7)";
const VECT_OUTLINE_FILL = "rgba(253, 224, 71, 0.10)";
const VECT_OUTLINE_STROKE = "rgba(253, 224, 71, 0.45)";

const FETCH_DEBOUNCE_MS = 300;
/** Below the backend's 6 Mpx cap (it rejects bigger). Beyond this the view
 *  is so zoomed out that live decoding would pin the sidecar anyway. */
const MAX_AREA_PX = 5_000_000;
/** Recently decoded regions kept for instant redraw on pan-back. */
const MAX_REGIONS = 32;

export interface VectorizeDisplay {
  /** True → don't paint and don't fetch. */
  getHidden?: () => boolean;
  /** Live vectorize params (preferences). Absent ⇒ layer idle. */
  getParams?: () => VectorizeParams;
  /** Visible overlay image to vectorize instead of the base image. */
  getOverlaySource?: () => string | undefined;
  /** Trace-endpoint snap targets (same closure the ML layer gets). */
  findSnapTarget?: (world: Point, tolWorld: number) => { x: number; y: number; label: string } | null;
  /** Endpoint snap tolerance (world px). Absent ⇒ 12. */
  getSnapTol?: () => number;
  /** Minimum score (0..1) for a trace to draw — the vectorize score is a
   *  brightness margin, so this filters weak-threshold noise. */
  getTraceConfidenceThreshold?: () => number;
  /** Pipette samples to mark on the canvas (world coords + sampled rgb). */
  getSamples?: () => VectorPipetteSample[];
  /** Status for the inspector: loading flag, last error, region trace count,
   *  and the last decode's width-filter drop stats. */
  onStatusChange?: (status: {
    loading: boolean;
    error: string | null;
    traces: number;
    droppedWidth?: number;
  }) => void;
}

/** One pipette measurement: the sampled 7×7 mean colour + where it was
 *  taken (markers stay on the canvas while tuning). */
export interface VectorPipetteSample {
  rgb: [number, number, number];
  x: number;
  y: number;
}

interface CachedRegion {
  bbox: [number, number, number, number];
  paramsKey: string;
  traces: MLTracePolyline[];
  outlines: [number, number][][];
  /** Per-trace bbox, precomputed once — draw() runs per renderer tile and
   *  a whole-die payload holds thousands of polylines: without culling
   *  every tile would walk (and stroke-path) all of them. */
  traceBoxes: { box: Rect; index: number }[];
  outlineBoxes: { box: Rect; index: number }[];
  /** Width-filter drop stats of the decode that filled this region. */
  stats?: { kept: number; droppedWidth: number; droppedShort?: number; merged?: number };
}

function pointsBox(points: [number, number][]): Rect {
  let minx = Infinity;
  let miny = Infinity;
  let maxx = -Infinity;
  let maxy = -Infinity;
  for (const [x, y] of points) {
    if (x < minx) minx = x;
    if (y < miny) miny = y;
    if (x > maxx) maxx = x;
    if (y > maxy) maxy = y;
  }
  // Half-px inflation: horizontal/vertical runs produce zero-height/width
  // boxes that strict-intersect would drop when aligned with a tile edge.
  return { x: minx - 0.5, y: miny - 0.5, width: maxx - minx + 1, height: maxy - miny + 1 };
}

export class VectorizeLayer implements Layer {
  readonly id = "vectorize";
  private readonly dieId: string;
  private readonly metadata: DieMetadata;
  private readonly display: VectorizeDisplay;
  private readonly cache = new Map<string, CachedRegion>();
  /** Memoized endpoint snap lookups (`"x:y"` → target or null) — the lookup
   *  is an O(targets) scan per endpoint per frame otherwise. */
  private readonly snapCache = new Map<string, { x: number; y: number } | null>();
  private invalidateCb: ((rect?: Rect) => void) | null = null;
  private destroyed = false;
  /** Keys the debounce timer currently targets (bbox|params) → timer id. */
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingKey: string | null = null;
  private inflightKey: string | null = null;
  private abort: AbortController | null = null;
  /** Set while a request is in flight and the target changed since — the
   *  completion handler immediately refetches the newer target (coalescing:
   *  slider drags never pile up requests). */
  private queuedFetch: { bbox: [number, number, number, number]; params: VectorizeParams; key: string } | null = null;
  /** Viewport hint state, so the "zoom in" notice fires on change only. */
  private lastSkipHint: boolean = false;
  /** Whole-die sweep block coverage: keys where the disk cache answered
   *  incompletely → those fall back to live viewport decode until the sweep
   *  finishes (cleared on clearCache, e.g. when a sweep completes). */
  private readonly blockMiss = new Set<string>();
  /** Keys with a blocks lookup in flight (don't re-ask every frame). */
  private readonly blocksInflight = new Set<string>();

  constructor(dieId: string, metadata: DieMetadata, display: VectorizeDisplay = {}) {
    this.dieId = dieId;
    this.metadata = metadata;
    this.display = display;
  }

  destroy(): void {
    this.destroyed = true;
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    this.pendingTimer = null;
    this.abort?.abort();
    this.abort = null;
    this.cache.clear();
    this.snapCache.clear();
    this.inflightKey = null;
    this.queuedFetch = null;
  }

  subscribe(invalidate: (worldRect?: Rect) => void): () => void {
    this.destroyed = false;
    this.invalidateCb = invalidate;
    return () => {
      this.invalidateCb = null;
    };
  }

  /** Drop everything (params semantics changed / die switched). */
  clearCache(): void {
    this.cache.clear();
    this.snapCache.clear();
    this.blockMiss.clear();
    this.invalidateCb?.();
  }

  /** Latest error string (panel display), cleared on a successful fetch. */
  private lastError: string | null = null;
  /** Drop stats of the latest decode (panel diagnostics). */
  private lastStats: {
    kept: number;
    droppedWidth: number;
    droppedShort?: number;
    merged?: number;
  } | null = null;

  private notifyStatus(loading: boolean): void {
    this.display.onStatusChange?.({
      loading,
      error: this.lastError,
      traces: this.collectTraces().length,
      ...(this.lastStats ? { droppedWidth: this.lastStats.droppedWidth } : {})
    });
  }

  /** Every decoded trace across cached regions, deduplicated by point
   *  sequence — a trace straddling two fetched regions appears in both. */
  collectTraces(): MLTracePolyline[] {
    const seen = new Set<string>();
    const out: MLTracePolyline[] = [];
    for (const region of this.cache.values()) {
      for (const t of region.traces) {
        const key = t.points.map((p) => `${Math.round(p[0])},${Math.round(p[1])}`).join(";");
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(t);
      }
    }
    return out;
  }

  /**
   * One per frame, before any tile draw: schedule a viewport-sized region
   * fetch. `frame.world` is the FULL visible world rect (draw() below only
   * sees per-tile rects — scheduling there produced per-tile requests, and
   * canvas tiles outside the die produced degenerate bboxes the backend
   * rightly rejected). Clamped to the die, guarded against degenerate /
   * oversized viewports.
   */
  beginFrame(frame: RenderFrame): void {
    const params = this.display.getParams?.();
    if (!params || (this.display.getHidden?.() ?? false)) return;

    const w = frame.world;
    const x0 = Math.max(0, Math.floor(w.x));
    const y0 = Math.max(0, Math.floor(w.y));
    const x1 = Math.min(this.metadata.width, Math.ceil(w.x + w.width));
    const y1 = Math.min(this.metadata.height, Math.ceil(w.y + w.height));
    // The viewport (or the part of it over the die) can be empty — never
    // fetch then, and drop any stale "zoom in" hint.
    if (!(x1 > x0 && y1 > y0) || !Number.isFinite(x0 + y0 + x1 + y1)) {
      if (this.lastSkipHint) {
        this.lastSkipHint = false;
        this.notifyStatus(false);
      }
      return;
    }
    const bbox: [number, number, number, number] = [x0, y0, x1, y1];
    const area = (x1 - x0) * (y1 - y0);
    if (area > MAX_AREA_PX) {
      // Too zoomed out for live decoding — hint once, don't hammer.
      if (!this.lastSkipHint) {
        this.lastSkipHint = true;
        this.lastError = "viewport too large — zoom in to vectorize (≤ 5 Mpx)";
        this.notifyStatus(false);
      }
      return;
    }
    if (this.lastSkipHint) {
      this.lastSkipHint = false;
      this.lastError = null;
      this.notifyStatus(false);
    }

    const overlaySource = this.display.getOverlaySource?.() ?? undefined;
    const key = `${bbox.join(",")}|${overlaySource ?? ""}|${JSON.stringify(params)}`;
    // Already decoded (or decoded at these exact params) → nothing to do.
    if (this.cache.has(key) || key === this.inflightKey || key === this.pendingKey) return;

    // Whole-die sweep cache first: if every block intersecting the viewport
    // is decoded for THESE params, draw from disk — no sidecar round-trip.
    // Any missing block (sweep not run / params changed mid-sweep) → mark
    // the key and fall back to the live viewport decode. An EMPTY payload
    // (0 traces + 0 outlines) is treated as a miss too: an empty cached
    // decode would otherwise stick and silently blank the overlay.
    if (!this.blockMiss.has(key) && !this.blocksInflight.has(key)) {
      this.blocksInflight.add(key);
      fetchVectorBlocks(this.dieId, bbox, params, overlaySource)
        .then((resp) => {
          this.blocksInflight.delete(key);
          if (this.destroyed) return;
          const counts = resp.blocks.reduce(
            (n, b) => n + b.traces.length + b.outlines.length,
            0
          );
          if (resp.blocks.length > 0 && resp.missing === 0 && counts > 0) {
            this.lastError = null;
            const traces = resp.blocks.flatMap((b) => b.traces);
            const outlines = resp.blocks.flatMap((b) => b.outlines);
            this.cache.set(key, {
              bbox,
              paramsKey: "",
              traces,
              outlines,
              traceBoxes: traces.map((t, i) => ({ box: pointsBox(t.points), index: i })),
              outlineBoxes: outlines.map((o, i) => ({ box: pointsBox(o), index: i }))
            });
            while (this.cache.size > MAX_REGIONS) {
              const oldest = this.cache.keys().next().value;
              if (oldest === undefined) break;
              this.cache.delete(oldest);
            }
            this.notifyStatus(false);
            this.invalidateCb?.({
              x: bbox[0],
              y: bbox[1],
              width: bbox[2] - bbox[0],
              height: bbox[3] - bbox[1]
            });
          } else {
            this.blockMiss.add(key);
            this.scheduleLiveFetch(bbox, params, key, overlaySource);
          }
        })
        .catch(() => {
          this.blocksInflight.delete(key);
          if (this.destroyed) return;
          this.blockMiss.add(key);
          this.scheduleLiveFetch(bbox, params, key, overlaySource);
        });
      return;
    }
    if (this.blockMiss.has(key)) {
      this.scheduleLiveFetch(bbox, params, key, overlaySource);
    }
  }

  /** Debounced + coalesced live viewport decode (the tuning path). */
  private scheduleLiveFetch(
    bbox: [number, number, number, number],
    params: VectorizeParams,
    key: string,
    overlaySource: string | undefined
  ): void {
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    this.pendingKey = key;
    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = null;
      this.pendingKey = null;
      const target = { bbox, params, key };
      if (this.inflightKey) {
        this.queuedFetch = target; // finish current, then fetch this
      } else {
        void this.fetch(target);
      }
    }, FETCH_DEBOUNCE_MS);
  }

  draw(ctx: CanvasRenderingContext2D, bounds: TileBounds): void {
    const { zoom } = bounds;

    // Pipette markers: one amber cross per accumulated sample — drawn even
    // while the overlay itself is hidden, so sampling stays visible.
    const samples = this.display.getSamples?.() ?? [];
    if (samples.length > 0) {
      const r = Math.max(4 / zoom, 3);
      ctx.strokeStyle = "rgba(253, 224, 71, 0.9)";
      ctx.lineWidth = Math.max(1 / zoom, 1.2 / zoom);
      for (const s of samples) {
        ctx.beginPath();
        ctx.moveTo(s.x - r, s.y);
        ctx.lineTo(s.x + r, s.y);
        ctx.moveTo(s.x, s.y - r);
        ctx.lineTo(s.x, s.y + r);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(s.x, s.y, r * 0.4, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    const params = this.display.getParams?.();
    const hidden = this.display.getHidden?.() ?? false;
    if (!params || hidden) return;
    const world = bounds.world;

    // ── Paint every cached region overlapping the view ───────────────
    const strokeW = 1 / zoom;
    const minScore = this.display.getTraceConfidenceThreshold?.() ?? 0;
    const snapTol = this.display.getSnapTol?.() ?? 12;
    for (const region of this.cache.values()) {
      const [rx0, ry0, rx1, ry1] = region.bbox;
      const regionRect: Rect = { x: rx0, y: ry0, width: rx1 - rx0, height: ry1 - ry0 };
      if (!rectsIntersect(regionRect, world)) continue;

      // Outlines first — the light "what did my threshold capture" fill.
      // Per-shape bbox culling: a whole-die payload holds thousands of
      // polylines and draw() runs per renderer tile.
      ctx.lineWidth = strokeW;
      for (const { box, index } of region.outlineBoxes) {
        if (!rectsIntersect(box, world)) continue;
        const pts = region.outlines[index];
        if (pts.length < 3) continue;
        ctx.beginPath();
        ctx.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
        ctx.closePath();
        ctx.fillStyle = VECT_OUTLINE_FILL;
        ctx.fill();
        ctx.strokeStyle = VECT_OUTLINE_STROKE;
        ctx.stroke();
      }

      // Centreline traces + endpoint snaps.
      for (const { box, index } of region.traceBoxes) {
        if (!rectsIntersect(box, world)) continue;
        const t = region.traces[index];
        if ((t.score ?? 1) < minScore) continue;
        const pts = t.points;
        if (pts.length < 2) continue;
        ctx.beginPath();
        ctx.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
        ctx.strokeStyle = VECT_TRACE_STROKE;
        ctx.lineWidth = Math.max(strokeW, 1.5 / zoom);
        ctx.stroke();
        for (const end of [pts[0], pts[pts.length - 1]]) {
          const skey = `${end[0]}:${end[1]}:${snapTol}`;
          let target = this.snapCache.get(skey);
          if (target === undefined) {
            target = this.display.findSnapTarget?.({ x: end[0], y: end[1] }, snapTol) ?? null;
            this.snapCache.set(skey, target);
          }
          if (!target) continue;
          ctx.beginPath();
          ctx.moveTo(end[0], end[1]);
          ctx.lineTo(target.x, target.y);
          ctx.strokeStyle = VECT_TRACE_SNAP_STROKE;
          ctx.lineWidth = strokeW;
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(target.x, target.y, Math.max(3 / zoom, 2.5), 0, Math.PI * 2);
          ctx.stroke();
        }
      }
    }
  }

  /** One region request. While in flight, newer targets go to `queuedFetch`
   *  and run on completion — slider drags never pile up parallel requests. */
  private async fetch(target: {
    bbox: [number, number, number, number];
    params: VectorizeParams;
    key: string;
  }): Promise<void> {
    this.inflightKey = target.key;
    this.abort = new AbortController();
    this.notifyStatus(true);
    try {
      const resp = await vectorizeRegion(
        this.dieId,
        target.bbox,
        target.params,
        this.display.getOverlaySource?.() ?? undefined,
        this.abort.signal
      );
      if (this.destroyed) return;
      this.lastError = null;
      this.lastStats = resp.stats ?? null;
      this.cache.set(target.key, {
        bbox: target.bbox,
        paramsKey: target.key.slice(target.bbox.join(",").length + 1),
        traces: resp.traces,
        outlines: resp.outlines,
        traceBoxes: resp.traces.map((t, i) => ({ box: pointsBox(t.points), index: i })),
        outlineBoxes: resp.outlines.map((o, i) => ({ box: pointsBox(o), index: i })),
        stats: resp.stats
      });
      // Evict the oldest region beyond the cap (Map = insertion order).
      while (this.cache.size > MAX_REGIONS) {
        const oldest = this.cache.keys().next().value;
        if (oldest === undefined) break;
        this.cache.delete(oldest);
      }
      this.notifyStatus(false);
      this.invalidateCb?.({
        x: target.bbox[0],
        y: target.bbox[1],
        width: target.bbox[2] - target.bbox[0],
        height: target.bbox[3] - target.bbox[1]
      });
    } catch (e) {
      if (this.destroyed) return;
      if ((e as Error)?.name === "AbortError") return;
      this.lastError = e instanceof Error ? e.message : "vectorize failed";
      this.notifyStatus(false);
      // NB: no invalidate here — a persistent error (sidecar down, bad
      // params) would otherwise reschedule itself every frame. The user's
      // next interaction redraws and retries naturally.
    } finally {
      this.inflightKey = null;
      this.abort = null;
      const next = this.queuedFetch;
      this.queuedFetch = null;
      if (next && !this.destroyed) void this.fetch(next);
    }
  }
}
