import type { Rect } from "../../lib/geometry";
import type { Layer, TileBounds } from "../types";

/**
 * Per-layer live display options — read fresh each draw so that pref changes
 * take effect on the next invalidate without rebuilding the layer.
 */
export interface OverlayImageDisplay {
  /** The HTMLImageElement to render. */
  getImage: () => HTMLImageElement | null;
  /** True → skip painting this layer entirely. */
  getHidden: () => boolean;
  /** 0..1 opacity multiplier. */
  getOpacity: () => number;
  /** World-coordinate offset (px) — where the top-left of the image sits. */
  getOffsetX: () => number;
  getOffsetY: () => number;
}

/**
 * A Layer that renders a single full image (non-tiled) on the die canvas.
 * The image is drawn at world coordinates (offsetX, offsetY) with its
 * natural pixel dimensions (1 source px = 1 world unit).
 *
 * Clips the source rect to the visible tile bounds so we don't draw the
 * whole multi-megabyte image for every tile.
 *
 * Designed to be lightweight: one instance per overlay image, subscribable
 * to a zustand store for invalidation.
 */
export class OverlayImageLayer implements Layer {
  readonly id: string;
  private readonly display: OverlayImageDisplay;
  private invalidateCb: ((rect?: Rect) => void) | null = null;

  /** Reused scratch canvas for opacity compositing (tiles render serially,
   *  so one is safe). Lazily created / resized. */
  private scratch: HTMLCanvasElement | null = null;

  constructor(id: string, display: OverlayImageDisplay) {
    this.id = id;
    this.display = display;
  }

  subscribe(invalidate: (worldRect?: Rect) => void): () => void {
    this.invalidateCb = invalidate;
    return () => {
      this.invalidateCb = null;
    };
  }

  /** The full world rect of this image (used for targeted invalidations). */
  worldRect(): Rect | null {
    const img = this.display.getImage();
    if (!img) return null;
    return {
      x: this.display.getOffsetX(),
      y: this.display.getOffsetY(),
      width: img.naturalWidth,
      height: img.naturalHeight
    };
  }

  draw(ctx: CanvasRenderingContext2D, bounds: TileBounds): void {
    const img = this.display.getImage();
    if (!img || this.display.getHidden()) return;

    const opacity = this.display.getOpacity();
    if (opacity <= 0) return;

    const offsetX = this.display.getOffsetX();
    const offsetY = this.display.getOffsetY();

    const imgW = img.naturalWidth;
    const imgH = img.naturalHeight;
    if (imgW === 0 || imgH === 0) return;

    // World rect of the visible part of this image within the tile.
    const clipLeft = Math.max(bounds.world.x, offsetX);
    const clipTop = Math.max(bounds.world.y, offsetY);
    const clipRight = Math.min(
      bounds.world.x + bounds.world.width,
      offsetX + imgW
    );
    const clipBottom = Math.min(
      bounds.world.y + bounds.world.height,
      offsetY + imgH
    );

    if (clipLeft >= clipRight || clipTop >= clipBottom) return; // off-screen

    // Source rect within the image (1:1 mapping to world coords).
    const srcX = clipLeft - offsetX;
    const srcY = clipTop - offsetY;
    const srcW = clipRight - clipLeft;
    const srcH = clipBottom - clipTop;

    if (opacity >= 1) {
      ctx.drawImage(img, srcX, srcY, srcW, srcH, clipLeft, clipTop, srcW, srcH);
      return;
    }

    // Partial opacity: composite the clipped portion into a scratch canvas
    // and blit with globalAlpha so we don't compound over the tile's
    // existing content.
    const px = Math.max(1, Math.round(bounds.size * bounds.dpr));
    let scratch = this.scratch;
    if (!scratch) scratch = this.scratch = document.createElement("canvas");
    if (scratch.width !== px || scratch.height !== px) {
      scratch.width = px;
      scratch.height = px;
    }
    const sctx = scratch.getContext("2d");
    if (!sctx) {
      // Fallback: let the compositor handle it (slightly off but visible).
      ctx.save();
      ctx.globalAlpha = opacity;
      ctx.drawImage(img, srcX, srcY, srcW, srcH, clipLeft, clipTop, srcW, srcH);
      ctx.restore();
      return;
    }

    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.clearRect(0, 0, px, px);
    sctx.scale(bounds.dpr * bounds.zoom, bounds.dpr * bounds.zoom);
    sctx.translate(-bounds.world.x, -bounds.world.y);
    sctx.drawImage(img, srcX, srcY, srcW, srcH, clipLeft, clipTop, srcW, srcH);

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = opacity;
    ctx.drawImage(scratch, 0, 0);
    ctx.restore();
  }
}
