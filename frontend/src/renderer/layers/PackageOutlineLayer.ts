import type { Layer, TileBounds } from "../types";
import type { PackageGeom } from "../../lib/ic-package/footprinter";

/** Live inputs read fresh each draw so store changes show without rebuild. */
export interface PackageLayerInputs {
  getGeom: () => PackageGeom | null;
  /** Pixels per millimetre — drives how big the package renders on the die. */
  getPxPerMm: () => number;
  /** Pin number of the user-selected package pin (for highlight), or null. */
  getSelectedPin: () => number | null;
  /** Pin number under the cursor (hover), or null. */
  getHoveredPin: () => number | null;
}

/** Where in the die's source-pixel space to place the package's origin.
 *  Default: (0, 0) — top-left corner. The caller can offset this via
 *  `getOriginPx` if they want to center the package on the die. */
export interface PackageLayerOptions {
  getOriginPx?: () => { x: number; y: number };
}

export class PackageOutlineLayer implements Layer {
  readonly id = "ic-package-outline";
  private readonly inputs: PackageLayerInputs;
  private readonly opts: PackageLayerOptions;

  constructor(inputs: PackageLayerInputs, opts: PackageLayerOptions = {}) {
    this.inputs = inputs;
    this.opts = opts;
  }

  draw(ctx: CanvasRenderingContext2D, _bounds: TileBounds): void {
    const geom = this.inputs.getGeom();
    if (!geom) return;
    const px = this.inputs.getPxPerMm();
    const origin = this.opts.getOriginPx?.() ?? { x: 0, y: 0 };
    const sel = this.inputs.getSelectedPin();
    const hov = this.inputs.getHoveredPin();

    // Body outline — light grey rectangle around the pin extents.
    const { minX, minY, maxX, maxY } = geom.body;
    const bodyScale = ctx.getTransform().a || 1;
    ctx.save();
    ctx.fillStyle = "rgba(200, 200, 200, 0.06)";
    ctx.strokeStyle = "rgba(160, 160, 160, 0.7)";
    ctx.lineWidth = 2 / bodyScale;
    ctx.beginPath();
    ctx.rect(
      origin.x + minX * px,
      origin.y + minY * px,
      (maxX - minX) * px,
      (maxY - minY) * px
    );
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    // Pin pads + labels.
    const scale = ctx.getTransform().a || 1;
    const labelFontPx = Math.max(8, Math.min(14, scale * 1.5));
    for (const pin of geom.pins) {
      const cx = origin.x + pin.x * px;
      const cy = origin.y + pin.y * px;
      const w = pin.w * px;
      const h = pin.h * px;
      const isSel = pin.number === sel;
      const isHov = pin.number === hov;

      ctx.save();
      ctx.fillStyle = isSel
        ? "rgba(0, 200, 100, 0.6)"
        : isHov
          ? "rgba(255, 220, 80, 0.6)"
          : "rgba(160, 130, 60, 0.5)";
      ctx.strokeStyle = isSel
        ? "rgba(0, 200, 100, 1)"
        : isHov
          ? "rgba(255, 220, 80, 1)"
          : "rgba(120, 100, 50, 1)";
      ctx.lineWidth = 1.5 / scale;
      ctx.fillRect(cx - w / 2, cy - h / 2, w, h);
      ctx.strokeRect(cx - w / 2, cy - h / 2, w, h);
      ctx.restore();

      // Pin number + name label. Place to the outside of the package body
      // (away from die center) when possible.
      const tx = origin.x + pin.x * px + (w / 2 + 6 / scale);
      const ty = origin.y + pin.y * px + labelFontPx * 0.35;
      ctx.save();
      ctx.font = `${labelFontPx}px ui-monospace, monospace`;
      ctx.fillStyle = "rgba(0, 0, 0, 0.85)";
      ctx.strokeStyle = "rgba(255, 255, 255, 0.85)";
      ctx.lineWidth = 3 / scale;
      const label = pin.name ? `${pin.number}:${pin.name}` : `${pin.number}`;
      ctx.strokeText(label, tx, ty);
      ctx.fillText(label, tx, ty);
      ctx.restore();
    }
  }
}
