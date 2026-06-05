import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  forwardRef,
  type CSSProperties
} from "react";
import type { Cell, CellType, MLPrediction } from "shared";
import { drawCellLayers } from "../../renderer/annotations/shapes";
import { COLOR_VIA, COLOR_VIA_FILL } from "../../renderer/annotations/style";
import type { TileBounds } from "../../renderer/types";
import { orientOf } from "../../lib/mergeCells";

export interface CellView {
  cell: Cell | null;
  cellType: CellType | null;
  imageUrl: string | null;
  /** ML via predictions for this cell's die bbox. Drawn as small markers
   *  inside the same orientation transform as the image so they stay pinned
   *  to image features (and move with a live drag-align). Null/absent ⇒
   *  no overlay (either disabled or not loaded yet). */
  mlVias?: MLPrediction | null;
}

export interface MergeCanvasHandle {
  /** Re-fit both crops to the viewport. */
  fit: () => void;
  zoomBy: (factor: number) => void;
}

export type MergeMode =
  | "overlay"
  | "sxs"
  | "diff"
  | "specimen"
  | "candidate";

interface Props {
  mode: MergeMode;
  /** Candidate opacity 0..1 (overlay mode only). */
  opacity: number;
  showAnno: boolean;
  /** Master toggle for the ML-via overlay. When false the canvas ignores any
   *  vias passed in via the CellViews (so the page can keep the query alive
   *  and avoid a re-fetch when the user flips the toggle). */
  showMlVias: boolean;
  specimen: CellView | null;
  candidate: CellView | null;
  /** Commit a drag-align: source-pixel delta to apply to the candidate x/y. */
  onAlign: (dxSrc: number, dySrc: number) => void;
}

const GAP = 24; // world-unit gap between the two boxes in side-by-side
/** Matches the die viewer (useCanvasGestures) so trackpad zoom feels the same
 *  — the old 0.0015 was ~7× too slow. */
const WHEEL_ZOOM_FACTOR = 0.01;

interface View {
  ox: number;
  oy: number;
  zoom: number;
}

/** Fit a cell box centred inside a pane of `pw × ph` css px. */
function fitBox(
  b: { w: number; h: number } | null,
  pw: number,
  ph: number
): View {
  const bw = Math.max(b?.w ?? 1, 1);
  const bh = Math.max(b?.h ?? 1, 1);
  const pad = 24;
  const zoom = Math.max(
    1e-3,
    Math.min((pw - pad * 2) / bw, (ph - pad * 2) / bh)
  );
  return { zoom, ox: bw / 2 - pw / 2 / zoom, oy: bh / 2 - ph / 2 / zoom };
}

function boxOf(v: CellView | null): { w: number; h: number } | null {
  if (!v || !v.cellType) return null;
  const { width, height } = v.cellType.cropRect;
  if (width <= 0 || height <= 0) return null;
  return { w: width, h: height };
}

/** Combined content extent (world units) for the current mode. */
function contentExtent(
  mode: MergeMode,
  sp: { w: number; h: number } | null,
  cd: { w: number; h: number } | null
): { w: number; h: number } {
  if (mode === "specimen") {
    return { w: Math.max(sp?.w ?? 0, 1), h: Math.max(sp?.h ?? 0, 1) };
  }
  if (mode === "candidate") {
    return { w: Math.max(cd?.w ?? 0, 1), h: Math.max(cd?.h ?? 0, 1) };
  }
  if (mode !== "sxs") {
    const w = Math.max(sp?.w ?? 0, cd?.w ?? 0, 1);
    const h = Math.max(sp?.h ?? 0, cd?.h ?? 0, 1);
    return { w, h };
  }
  const w = (sp?.w ?? 0) + GAP + (cd?.w ?? 0);
  const h = Math.max(sp?.h ?? 0, cd?.h ?? 0, 1);
  return { w: Math.max(w, 1), h };
}

export const MergeCanvas = forwardRef<MergeCanvasHandle, Props>(function MergeCanvas(
  { mode, opacity, showAnno, showMlVias, specimen, candidate, onAlign },
  ref
) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // One shared view for every mode. In side-by-side both panes render with
  // this same view, so panning / zooming over either pane moves both in
  // lock-step (linked comparison).
  const viewRef = useRef<View>({ ox: 0, oy: 0, zoom: 1 });
  const sizeRef = useRef({ w: 1, h: 1 });
  const dragRef = useRef<{
    kind: "pan" | "align";
    sx: number;
    sy: number;
    startOx: number;
    startOy: number;
    dx: number;
    dy: number;
  } | null>(null);
  const spaceRef = useRef(false);
  const [, force] = useState(0);
  const redraw = useCallback(() => force((n) => n + 1), []);

  // Latest props mirrored into a ref so the canvas callbacks/effects can stay
  // referentially stable (no ResizeObserver churn during a pan/align drag).
  const propsRef = useRef({ mode, opacity, showAnno, showMlVias, specimen, candidate, onAlign });
  propsRef.current = { mode, opacity, showAnno, showMlVias, specimen, candidate, onAlign };

  // ── Image cache ────────────────────────────────────────────────────
  const imgCache = useRef(new Map<string, HTMLImageElement>());
  const getImage = useCallback(
    (url: string | null): HTMLImageElement | null => {
      if (!url) return null;
      const cache = imgCache.current;
      const hit = cache.get(url);
      if (hit) return hit.complete && hit.naturalWidth > 0 ? hit : null;
      const img = new Image();
      img.decoding = "async";
      img.onload = redraw;
      img.onerror = redraw;
      img.src = url;
      cache.set(url, img);
      return null;
    },
    [redraw]
  );

  // Last successfully-loaded image per cell id + a "pending visual offset"
  // (canonical px) accumulated by drag-align commits that haven't yet been
  // mirrored by a fresh crop from the backend. After a release the new
  // `cellCropUrl` changes (the URL embeds `cell.x / cell.y` so the browser
  // cache busts when the bbox moves) and there's a 0.5–2 s gap before the
  // server returns a fresh JPG. Without this we'd paint blank during the
  // gap; with just the image fallback we'd paint the *un-dragged* old
  // image at the original position — misleading. So we stash the canonical
  // drag delta too and translate the fallback image by it: the user sees
  // the cell sitting at the position they dragged it to, then content
  // silently swaps when the new crop arrives (which visually has the same
  // features at the same place, just sourced from the new bbox).
  //
  // Keyed by cell id (not URL): switching to a different candidate gives
  // us no fallback for the new one (correct — we shouldn't show old cell
  // pixels in a new cell's slot). Capped to keep the map bounded over
  // long sessions; Map's insertion-order semantics give us a cheap LRU.
  interface CellImgState {
    img: HTMLImageElement;
    /** Canvas-coord canonical offset to add when drawing this image as a
     *  fallback. Cleared whenever a fresh image for this cell loads. */
    pendingOffset: { dx: number; dy: number };
  }
  const lastImgByCellRef = useRef<Map<string, CellImgState>>(new Map());
  const LAST_IMG_CAP = 32;
  const resolveImg = useCallback(
    (
      view: CellView
    ): { img: HTMLImageElement | null; offset: { dx: number; dy: number } } => {
      const cellId = view.cell?.id ?? null;
      const fresh = getImage(view.imageUrl);
      if (fresh && cellId) {
        const map = lastImgByCellRef.current;
        const existing = map.get(cellId);
        // Only re-stamp the entry (and clear `pendingOffset`) when the
        // *image identity* changes — i.e. a genuinely new crop just loaded.
        // Renders that hit a cached same-URL image must NOT touch the
        // pending offset: drag-release fires a sync re-render *before* the
        // optimistic cellType update lands, so this render still sees the
        // old URL — we'd otherwise wipe the drag delta we just stashed and
        // the cell would snap back to its original position for one frame.
        if (!existing || existing.img !== fresh) {
          if (existing) map.delete(cellId);
          map.set(cellId, { img: fresh, pendingOffset: { dx: 0, dy: 0 } });
          while (map.size > LAST_IMG_CAP) {
            const oldest = map.keys().next().value;
            if (oldest === undefined) break;
            map.delete(oldest);
          }
          return { img: fresh, offset: { dx: 0, dy: 0 } };
        }
        return { img: existing.img, offset: existing.pendingOffset };
      }
      if (cellId) {
        const state = lastImgByCellRef.current.get(cellId);
        if (state) return { img: state.img, offset: state.pendingOffset };
      }
      return { img: null, offset: { dx: 0, dy: 0 } };
    },
    [getImage]
  );

  // CSS-x offset of the pane the cursor is over (0 unless side-by-side and
  // over the right half) — used to anchor cursor-centred zoom correctly.
  const paneOffsetX = useCallback((cssX: number): number => {
    if (propsRef.current.mode !== "sxs") return 0;
    const half = sizeRef.current.w / 2;
    return cssX < half ? 0 : half;
  }, []);

  // ── Fit ────────────────────────────────────────────────────────────
  const fit = useCallback(() => {
    const p = propsRef.current;
    const sp = boxOf(p.specimen);
    const cd = boxOf(p.candidate);
    const { w: cw, h: ch } = sizeRef.current;
    if (p.mode === "sxs") {
      // Linked: one shared view sized so the larger of the two cells fits a
      // half-pane; both panes then render at the same scale/region.
      const box = {
        w: Math.max(sp?.w ?? 0, cd?.w ?? 0, 1),
        h: Math.max(sp?.h ?? 0, cd?.h ?? 0, 1)
      };
      viewRef.current = fitBox(box, cw / 2, ch);
      redraw();
      return;
    }
    const ext = contentExtent(p.mode, sp, cd);
    const pad = 32;
    const zoom = Math.max(
      1e-3,
      Math.min((cw - pad * 2) / ext.w, (ch - pad * 2) / ext.h)
    );
    viewRef.current = {
      zoom,
      ox: ext.w / 2 - cw / 2 / zoom,
      oy: ext.h / 2 - ch / 2 / zoom
    };
    redraw();
  }, [redraw]);

  useImperativeHandle(ref, () => ({
    fit,
    zoomBy: (factor: number) => {
      const v = viewRef.current;
      const { w, h } = sizeRef.current;
      const cx = v.ox + w / 2 / v.zoom;
      const cy = v.oy + h / 2 / v.zoom;
      const zoom = Math.min(64, Math.max(1e-3, v.zoom * factor));
      viewRef.current = {
        zoom,
        ox: cx - w / 2 / zoom,
        oy: cy - h / 2 / zoom
      };
      redraw();
    }
  }));

  // Re-fit when the content identity or mode changes (stable string key).
  const fitKey = `${mode}|${specimen?.cell?.id ?? specimen?.cellType?.id ?? "-"}|${
    candidate?.cell?.id ?? "-"
  }`;
  const fitKeyRef = useRef("");
  useEffect(() => {
    if (fitKey !== fitKeyRef.current) {
      fitKeyRef.current = fitKey;
      fit();
    }
  }, [fitKey, fit]);

  // ── Resize observer (stable: subscribes once) ──────────────────────
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const ro = new ResizeObserver(() => {
      const r = host.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        const first = sizeRef.current.w === 1 && sizeRef.current.h === 1;
        sizeRef.current = { w: r.width, h: r.height };
        if (first) fit();
        else redraw();
      }
    });
    ro.observe(host);
    return () => ro.disconnect();
  }, [fit, redraw]);

  // ── Keyboard (space = pan modifier) ─────────────────────────────────
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === "Space") spaceRef.current = true;
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space") spaceRef.current = false;
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  // ── Draw ───────────────────────────────────────────────────────────
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const { w: cw, h: ch } = sizeRef.current;
    canvas.width = Math.max(1, Math.round(cw * dpr));
    canvas.height = Math.max(1, Math.round(ch * dpr));
    canvas.style.width = `${cw}px`;
    canvas.style.height = `${ch}px`;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const sp = boxOf(specimen);
    const cd = boxOf(candidate);

    const mkBounds = (zoom: number): TileBounds => ({
      size: 0,
      i: 0,
      j: 0,
      world: { x: 0, y: 0, width: 0, height: 0 },
      dpr,
      zoom
    });

    // Place the world transform for a pane offset `pxX` css px from the left.
    const setWorld = (view: View, pxX: number) => {
      ctx.setTransform(
        dpr * view.zoom,
        0,
        0,
        dpr * view.zoom,
        (pxX - view.ox * view.zoom) * dpr,
        -view.oy * view.zoom * dpr
      );
    };

    const drawCell = (
      view: CellView,
      box: { w: number; h: number },
      originX: number,
      originY: number,
      alpha: number,
      live: { dx: number; dy: number },
      zoom: number,
      composite: GlobalCompositeOperation = "source-over"
    ) => {
      const { img, offset: pendingOffset } = resolveImg(view);
      const o = view.cell ? orientOf(view.cell) : { flippedH: false, flippedV: false, rotation: 0 as const };
      // `pendingOffset` is the canonical-canvas delta accumulated by a
      // drag-align commit whose fresh crop hasn't arrived yet. Composed
      // additively with the in-progress `live` offset so the user sees the
      // cell at exactly the position they dragged it to throughout the
      // commit → load → swap cycle.
      const effDx = live.dx + pendingOffset.dx;
      const effDy = live.dy + pendingOffset.dy;
      const cx = originX + effDx + box.w / 2;
      const cy = originY + effDy + box.h / 2;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(cx, cy);
      ctx.rotate((o.rotation * Math.PI) / 180);
      ctx.scale(o.flippedH ? -1 : 1, o.flippedV ? -1 : 1);
      ctx.translate(-box.w / 2, -box.h / 2);
      ctx.globalCompositeOperation = composite;
      if (img) {
        ctx.imageSmoothingEnabled = zoom < 3;
        ctx.drawImage(img, 0, 0, box.w, box.h);
      } else if (composite === "source-over") {
        ctx.fillStyle = "rgba(255,255,255,0.04)";
        ctx.fillRect(0, 0, box.w, box.h);
      }
      // Annotations + outline always composite normally on top of the image.
      ctx.globalCompositeOperation = "source-over";
      if (showAnno) {
        // Merge-cells compares two cell crops side-by-side; outlining each
        // little shape muddies that visual diff. Keep the translucent fills,
        // skip the strokes — the RE page keeps both for individual editing.
        drawCellLayers(ctx, view.cellType?.layers, mkBounds(zoom), {
          outline: false
        });
      }
      // ML via overlay. Drawn in die-coord space (translated so the cell's
      // die origin sits at the local frame's origin) so vias stay pinned to
      // the underlying image features and visibly move with a live drag.
      if (showMlVias && view.mlVias && view.cell) {
        drawMlVias(ctx, view.mlVias, view.cell.x, view.cell.y, zoom);
      }
      // Box outline.
      ctx.globalAlpha = 1;
      ctx.strokeStyle = "rgba(245,214,138,0.5)";
      ctx.lineWidth = 1 / zoom;
      ctx.strokeRect(0, 0, box.w, box.h);
      ctx.restore();
    };

    if (mode === "sxs") {
      // Two independent panes: specimen left, candidate right. Each clipped
      // to its half, each with its own pan/zoom view.
      const half = cw / 2;
      const drawPane = (
        pxX: number,
        pw: number,
        view: View,
        cell: CellView | null,
        box: { w: number; h: number } | null
      ) => {
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.beginPath();
        ctx.rect(
          Math.round(pxX * dpr),
          0,
          Math.round(pw * dpr),
          Math.round(ch * dpr)
        );
        ctx.clip();
        setWorld(view, pxX);
        if (cell && box)
          drawCell(cell, box, 0, 0, 1, { dx: 0, dy: 0 }, view.zoom);
        ctx.restore();
      };
      // Same shared view in both panes → linked pan/zoom.
      // Candidate on the left, target/specimen on the right.
      const v = viewRef.current;
      drawPane(0, half, v, candidate, cd);
      drawPane(half, cw - half, v, specimen, sp);
    } else {
      // Stacked / single layout. overlay+diff draw both (diff with the
      // "difference" blend — black where they agree, bright where they
      // disagree); specimen / candidate draw just one.
      const v = viewRef.current;
      setWorld(v, 0);
      const live =
        dragRef.current && dragRef.current.kind === "align"
          ? {
              dx: dragRef.current.dx / v.zoom,
              dy: dragRef.current.dy / v.zoom
            }
          : { dx: 0, dy: 0 };
      const ext = contentExtent(mode, sp, cd);
      const showSpecimen = mode !== "candidate";
      const showCandidate = mode !== "specimen";
      if (showSpecimen && sp && specimen)
        drawCell(
          specimen,
          sp,
          (ext.w - sp.w) / 2,
          (ext.h - sp.h) / 2,
          1,
          { dx: 0, dy: 0 },
          v.zoom
        );
      if (showCandidate && cd && candidate)
        drawCell(
          candidate,
          cd,
          (ext.w - cd.w) / 2,
          (ext.h - cd.h) / 2,
          mode === "diff" ? 1 : mode === "overlay" ? opacity : 1,
          live,
          v.zoom,
          mode === "diff" ? "difference" : "source-over"
        );
    }
  });

  // ── Pointer interaction ────────────────────────────────────────────
  const onPointerDown = (e: React.PointerEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.setPointerCapture(e.pointerId);
    const v = viewRef.current;
    const panMode = spaceRef.current || e.button === 1 || e.button === 2;
    // Aligning is single-view only (you need the specimen behind the
    // candidate to judge it); side-by-side just pans the shared view.
    const m = propsRef.current.mode;
    const canAlign =
      m !== "sxs" && !!propsRef.current.candidate && m !== "specimen";
    dragRef.current = {
      kind: panMode || !canAlign ? "pan" : "align",
      sx: e.clientX,
      sy: e.clientY,
      startOx: v.ox,
      startOy: v.oy,
      dx: 0,
      dy: 0
    };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const v = viewRef.current;
    if (d.kind === "pan") {
      viewRef.current = {
        ...v,
        ox: d.startOx - (e.clientX - d.sx) / v.zoom,
        oy: d.startOy - (e.clientY - d.sy) / v.zoom
      };
    } else {
      d.dx = e.clientX - d.sx;
      d.dy = e.clientY - d.sy;
    }
    redraw();
  };
  const endDrag = (e: React.PointerEvent) => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d) return;
    canvasRef.current?.releasePointerCapture(e.pointerId);
    if (d.kind === "align" && (d.dx !== 0 || d.dy !== 0)) {
      const v = viewRef.current;
      // Drag vector in screen-aligned world units.
      const wx = d.dx / v.zoom;
      const wy = d.dy / v.zoom;
      // The crop window (cell.x/cell.y) lives in *unrotated source* space,
      // but the displayed image is rotate(θ)∘scale(flip) of that crop. To
      // bake a screen-space drag Δ into the crop origin we apply the inverse
      // orientation: δ = -S · R(-θ) · Δ  (S = flip, its own inverse).
      const o = propsRef.current.candidate?.cell
        ? orientOf(propsRef.current.candidate.cell)
        : { flippedH: false, flippedV: false, rotation: 0 as const };
      const t = (o.rotation * Math.PI) / 180;
      const c = Math.cos(t);
      const s = Math.sin(t);
      // R(-θ) · Δ
      const ax = c * wx + s * wy;
      const ay = -s * wx + c * wy;
      const sx = o.flippedH ? -1 : 1;
      const sy = o.flippedV ? -1 : 1;
      // Stash the canonical drag delta onto the candidate's cached image
      // BEFORE dispatching: the optimistic update fires next, switching the
      // `cellCropUrl` to one whose image isn't loaded yet — `resolveImg`
      // will fall back to this entry and translate by the pending offset
      // so the user sees the cell at exactly the dragged position until
      // the fresh crop arrives. Accumulates across rapid successive drags
      // (e.g. drag → release → drag again before the first crop lands).
      const cellId = propsRef.current.candidate?.cell?.id;
      if (cellId) {
        const state = lastImgByCellRef.current.get(cellId);
        if (state) {
          state.pendingOffset = {
            dx: state.pendingOffset.dx + wx,
            dy: state.pendingOffset.dy + wy
          };
        }
      }
      onAlign(-sx * ax, -sy * ay);
    }
    redraw();
  };
  // Wheel/trackpad: bound natively & non-passively (like the die viewer's
  // useCanvasGestures) so preventDefault actually suppresses the horizontal
  // overscroll back-swipe and the ctrl/⌘-wheel browser page zoom. Safari
  // pinch `gesture*` events are swallowed too.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const cssX = e.clientX - rect.left;
      const cssY = e.clientY - rect.top;
      const v = viewRef.current;
      // Cursor px relative to the pane the pointer is over (so zoom anchors
      // on the same cell-local point in the shared/linked view).
      const px = cssX - paneOffsetX(cssX);
      const py = cssY;
      if (e.ctrlKey || e.metaKey) {
        // Zoom about the cursor — shared view, so both panes follow.
        const wx = v.ox + px / v.zoom;
        const wy = v.oy + py / v.zoom;
        const zoom = Math.min(
          64,
          Math.max(1e-3, v.zoom * Math.exp(-e.deltaY * WHEEL_ZOOM_FACTOR))
        );
        viewRef.current = { zoom, ox: wx - px / zoom, oy: wy - py / zoom };
      } else {
        viewRef.current = {
          ...v,
          ox: v.ox + e.deltaX / v.zoom,
          oy: v.oy + e.deltaY / v.zoom
        };
      }
      redraw();
    };
    const preventGesture = (e: Event) => e.preventDefault();
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("gesturestart", preventGesture, { passive: false });
    canvas.addEventListener("gesturechange", preventGesture, { passive: false });
    canvas.addEventListener("gestureend", preventGesture, { passive: false });
    return () => {
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("gesturestart", preventGesture);
      canvas.removeEventListener("gesturechange", preventGesture);
      canvas.removeEventListener("gestureend", preventGesture);
    };
  }, [redraw, paneOffsetX]);

  const cursor: CSSProperties["cursor"] = spaceRef.current
    ? "grab"
    : mode === "sxs"
      ? "grab"
      : candidate && mode !== "specimen"
        ? "move"
      : "default";

  return (
    <div
      ref={hostRef}
      style={{
        position: "relative",
        flex: "1 1 auto",
        minHeight: 0,
        background: "var(--canvas-bg)",
        overflow: "hidden",
        overscrollBehavior: "none"
      }}
    >
      <canvas
        ref={canvasRef}
        style={{
          display: "block",
          cursor,
          touchAction: "none",
          overscrollBehavior: "none"
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onContextMenu={(e) => e.preventDefault()}
      />
      {mode === "sxs" && (
        <>
          <PaneHeader side="left" tone="accent">
            {candidate?.cell
              ? `Candidate · cell ${candidate.cell.id.slice(0, 6)}`
              : "Candidate · —"}
          </PaneHeader>
          <PaneHeader side="right" tone="ok">
            {specimen?.cellType
              ? `Merge into · ${specimen.cellType.name}`
              : "Merge into · —"}
          </PaneHeader>
          <div
            style={{
              position: "absolute",
              top: 0,
              bottom: 0,
              left: "calc(50% - 1px)",
              width: 2,
              background: "var(--l2)",
              boxShadow: "0 0 0 1px rgba(0,0,0,0.4)",
              pointerEvents: "none"
            }}
          />
        </>
      )}
      {!specimen && (
        <div
          className="m"
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--ink3)",
            fontSize: 11,
            letterSpacing: 0.5,
            pointerEvents: "none"
          }}
        >
          select a cell type to begin
        </div>
      )}
    </div>
  );
});

/** Screen-px sizes for the ML-via markers — kept constant on screen by
 *  dividing by zoom so they stay legible at every magnification. */
const ML_POINT_VIA_PX = 3;
const ML_IRREGULAR_STROKE_PX = 1;
/** Drop point-vias whose score is below this — the server already filters
 *  by `threshold` but at the merge canvas we want only obvious hits. */
const ML_MIN_SCORE = 0.5;

/**
 * Paint ML via predictions inside the current cell-local frame. The caller
 * has already placed the transform such that (0, 0) is the cell's image
 * top-left at die coords (`cell.x, cell.y`); we translate by `(-cellX, -cellY)`
 * inside our own save/restore so the helper can iterate the raw die-coord
 * predictions without modifying caller state.
 */
function drawMlVias(
  ctx: CanvasRenderingContext2D,
  vias: MLPrediction,
  cellX: number,
  cellY: number,
  zoom: number
): void {
  ctx.save();
  ctx.translate(-cellX, -cellY);
  // Point vias: filled green dot with a thin opaque ring for pop against
  // dark imagery. Score gates suppress weak detections.
  const r = ML_POINT_VIA_PX / zoom;
  ctx.fillStyle = COLOR_VIA;
  ctx.strokeStyle = COLOR_VIA;
  ctx.lineWidth = ML_IRREGULAR_STROKE_PX / zoom;
  for (const v of vias.pointVias) {
    if (v.score < ML_MIN_SCORE) continue;
    ctx.beginPath();
    ctx.arc(v.x, v.y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  // Irregular vias: bbox outline + translucent fill.
  ctx.fillStyle = COLOR_VIA_FILL;
  for (const reg of vias.irregularVias) {
    if (reg.score < ML_MIN_SCORE) continue;
    const [x, y, w, h] = reg.bbox;
    ctx.fillRect(x, y, w, h);
    ctx.strokeRect(x, y, w, h);
  }
  ctx.restore();
}

/** Floating label at the top of one side-by-side pane. */
function PaneHeader({
  side,
  tone,
  children
}: {
  side: "left" | "right";
  tone: "ok" | "accent";
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        position: "absolute",
        top: 8,
        left: side === "left" ? 0 : "50%",
        width: "50%",
        display: "flex",
        justifyContent: "center",
        pointerEvents: "none"
      }}
    >
      <span
        className="m"
        style={{
          fontSize: 10.5,
          fontWeight: 600,
          color: tone === "ok" ? "var(--ok)" : "var(--accent)",
          background: "rgba(20,20,18,0.78)",
          border: "1px solid var(--l2)",
          borderRadius: 4,
          padding: "3px 8px",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          maxWidth: "92%"
        }}
      >
        {children}
      </span>
    </div>
  );
}
