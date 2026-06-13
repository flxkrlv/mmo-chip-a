/**
 * AnalogDeviceHighlightsLayer.ts — Device highlighting overlay on die viewer.
 *
 * Renders detected analog devices (NPNS, MOS, resistors, capacitors, diodes)
 * as coloured bounding boxes with instance names (Q1, M1, R1…) over the die
 * image. Supports click-to-inspect via onDeviceClick callback.
 *
 * Architecture:
 *   - Takes the list of devices from collectDieWideAnalogDevices()
 *   - Renders as a lightweight canvas overlay (not full AnnotationLayer)
 *   - Each device gets a colour by kind + label
 *   - Click resolves which device was hit and fires onDeviceClick
 */

import { useEffect, useRef } from "react";
import type { AnalogDevice } from "shared";
import type { LiveValue } from "../../lib/liveValue";
import { useLiveValue } from "../../lib/liveValue";
import type { Viewport } from "../../renderer/types";

// ── Colour palette per device kind ───────────────────────────────

const DEVICE_COLORS: Record<string, string> = {
  bjt_npn: "#44ff66",   // green — NPN
  bjt_pnp: "#66ff88",   // lighter green — PNP
  mos: "#4488ff",       // blue — MOS
  resistor: "#ffaa44",  // orange — resistor
  capacitor: "#44ddff", // cyan — capacitor
  diode: "#ff6666",     // red — diode
  jfet_n: "#88ffaa",    // light green — N-JFET
  jfet_p: "#44ffaa",    // seafoam — P-JFET
  unknown: "#888888",   // grey
};

const DEVICE_FILL: Record<string, string> = {
  bjt_npn: "rgba(68, 255, 102, 0.12)",
  bjt_pnp: "rgba(102, 255, 136, 0.12)",
  mos: "rgba(68, 136, 255, 0.12)",
  resistor: "rgba(255, 170, 68, 0.12)",
  capacitor: "rgba(68, 221, 255, 0.12)",
  diode: "rgba(255, 102, 102, 0.12)",
  jfet_n: "rgba(136, 255, 170, 0.12)",
  jfet_p: "rgba(68, 255, 170, 0.12)",
  unknown: "rgba(136, 136, 136, 0.10)",
};

// ── Component ─────────────────────────────────────────────────────

interface Props {
  /** All analog devices to highlight, in die-world coordinates. */
  devices: AnalogDevice[];
  /** Live viewport — the component subscribes internally so it only
   *  re-renders when the viewport actually changes, not on every parent
   *  render. */
  viewportStore: LiveValue<Viewport | null>;
  /** Called when the user clicks on a device. */
  onDeviceClick?: (device: AnalogDevice) => void;
}

/** Minimum device bbox area (world px²) to bother drawing the label. */
const MIN_LABEL_AREA = 200;

export function AnalogDeviceHighlights({
  devices,
  viewportStore,
  onDeviceClick,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewport = useLiveValue(viewportStore);

  // Drawing: the viewport is read inside the effect via a ref, so the effect
  // doesn't need to re-bind on every viewport change — the ResizeObserver +
  // viewport subscription drives the rAF loop.
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;

  // Draw
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;

    const draw = () => {
      raf = 0;
      const vp = viewportRef.current;
      if (!vp) return;

      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      const w = Math.max(1, Math.round(rect.width * dpr));
      const h = Math.max(1, Math.round(rect.height * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, rect.width, rect.height);

      for (const dev of devices) {
        const bbox = dev.bbox;
        if (!bbox) continue;

        const sx = (bbox.x - vp.originX) * vp.zoom;
        const sy = (bbox.y - vp.originY) * vp.zoom;
        const sw = bbox.width * vp.zoom;
        const sh = bbox.height * vp.zoom;

        // Skip off-screen
        if (sx + sw < -50 || sx > rect.width + 50) continue;
        if (sy + sh < -50 || sy > rect.height + 50) continue;

        const color = DEVICE_COLORS[dev.kind] ?? DEVICE_COLORS.unknown;
        const fill = DEVICE_FILL[dev.kind] ?? DEVICE_FILL.unknown;

        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.fillStyle = fill;
        ctx.strokeRect(sx, sy, sw, sh);
        ctx.fillRect(sx, sy, sw, sh);

        // Label
        const area = sw * sh;
        if (area >= MIN_LABEL_AREA) {
          const label = dev.instanceName ?? dev.id;
          ctx.font = `600 ${Math.max(10, Math.min(14, sw * 0.18))}px monospace`;
          const textMetrics = ctx.measureText(label);
          const labelW = textMetrics.width + 6;
          const labelH = 18;
          const labelBX = sx + 2;
          const labelBY = sy + 2;

          ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
          ctx.fillRect(labelBX, labelBY, labelW, labelH);
          ctx.fillStyle = color;
          ctx.textBaseline = "middle";
          ctx.fillText(label, labelBX + 3, labelBY + labelH / 2);

          const paramStr = paramHint(dev);
          if (paramStr && sw > 120) {
            ctx.font = `400 ${Math.max(8, Math.min(11, sw * 0.13))}px monospace`;
            ctx.fillStyle = "rgba(255, 255, 255, 0.6)";
            ctx.textBaseline = "top";
            ctx.fillText(paramStr, labelBX + 3, labelBY + labelH + 2);
          }
        }

        // Terminal labels at actual layer positions (independent of bbox area)
        drawTerminalLabels(ctx, dev, vp);
      }
    };

    const schedule = () => {
      if (raf === 0) raf = requestAnimationFrame(draw);
    };

    draw();
    const ro = new ResizeObserver(schedule);
    ro.observe(canvas);
    const unsubVp = viewportStore.subscribe(schedule);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      unsubVp();
    };
  }, [devices, viewportStore]);

  // Click hit-test
  // Click hit-test: reads viewport from ref so the handler stays stable.
  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!onDeviceClick) return;
    const vp = viewportRef.current;
    if (!vp) return;
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const clickX = (e.clientX - rect.left) / vp.zoom + vp.originX;
    const clickY = (e.clientY - rect.top) / vp.zoom + vp.originY;

    let best: AnalogDevice | null = null;
    let bestArea = Infinity;
    for (const dev of devices) {
      const b = dev.bbox;
      if (!b) continue;
      if (clickX >= b.x && clickX <= b.x + b.width &&
          clickY >= b.y && clickY <= b.y + b.height) {
        const area = b.width * b.height;
        if (area < bestArea) {
          bestArea = area;
          best = dev;
        }
      }
    }
    if (best) onDeviceClick(best);
  };

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        pointerEvents: "none",
      }}
    />
  );
}

// ── Parameter hint helpers ───────────────────────────────────────

function paramHint(dev: AnalogDevice): string {
  const g = dev.geometry;
  switch (dev.kind) {
    case "mos": {
      if ("L_um" in g && "W_um" in g) {
        const mg = g as { L_um: number; W_um: number; fingers?: number; multiplier?: number };
        const m = mg.multiplier && mg.multiplier > 1 ? `×${mg.multiplier}` : "";
        const f = mg.fingers && mg.fingers > 1 ? `f${mg.fingers}` : "";
        return `W=${mg.W_um.toFixed(1)}u L=${mg.L_um.toFixed(2)}u${f}${m}`;
      }
      return "";
    }
    case "bjt_npn":
    case "bjt_pnp": {
      if ("PE_um" in g && dev.kind === "bjt_pnp") {
        const bg = g as { PE_um: number; multiplier?: number };
        const pe = bg.PE_um;
        if (pe > 0) return `PE=${pe.toFixed(1)}µm`;
      }
      if ("AE_um2" in g) {
        const bg = g as { AE_um2: number; multiplier?: number };
        const ae = bg.AE_um2;
        const m = bg.multiplier && bg.multiplier > 1 ? `×${bg.multiplier}` : "";
        return `AE=${ae.toFixed(2)}µm²${m}`;
      }
      return "";
    }
    case "resistor": {
      if ("squares" in g) {
        const rg = g as { squares: number; resistance_ohms?: number };
        return `□${rg.squares.toFixed(1)}`;
      }
      return "";
    }
    case "capacitor": {
      if ("capacitance_fF" in g) {
        const cg = g as { capacitance_fF?: number };
        if (cg.capacitance_fF) return `${cg.capacitance_fF.toFixed(2)}fF`;
      }
      return "";
    }
    default:
      return "";
  }
}

// ── Terminal label rendering ─────────────────────────────────────

/** Draw terminal labels at actual layer-shape positions. One label per
 *  shape — so a BJT with two base contacts gets two "B" labels.
 *  All same-name labels share one net (handled by the extractor). */
function drawTerminalLabels(
  ctx: CanvasRenderingContext2D,
  dev: AnalogDevice & { _termPoints?: Array<{x:number;y:number;name:string}> },
  vp: { originX: number; originY: number; zoom: number }
): void {
  const points = (dev as any)._termPoints as Array<{x:number;y:number;name:string}> | undefined;
  if (!points || points.length === 0) return;

  const color = DEVICE_COLORS[dev.kind] ?? DEVICE_COLORS.unknown;
  const fontSize = 9;
  ctx.font = `600 ${fontSize}px monospace`;
  ctx.textBaseline = "middle";

  for (const pt of points) {
    const sx = (pt.x - vp.originX) * vp.zoom;
    const sy = (pt.y - vp.originY) * vp.zoom;
    const shortName = pt.name;
    const tm = ctx.measureText(shortName);
    const tw = tm.width + 4;
    const th = fontSize + 4;

    ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
    ctx.fillRect(sx + 4, sy - th / 2, tw, th);
    ctx.fillStyle = color;
    ctx.fillText(shortName, sx + 6, sy);
  }
}
