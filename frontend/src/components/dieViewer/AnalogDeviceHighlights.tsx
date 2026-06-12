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

import { useEffect, useRef, useCallback } from "react";
import type { AnalogDevice } from "shared";
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
  /** Current viewport (world-to-screen transform). */
  viewport: Viewport | null;
  /** Called when the user clicks on a device. */
  onDeviceClick?: (device: AnalogDevice) => void;
}

/** Minimum device bbox area (world px²) to bother drawing the label. */
const MIN_LABEL_AREA = 200;

export function AnalogDeviceHighlights({
  devices,
  viewport,
  onDeviceClick,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const toScreen = useCallback(
    (wx: number, wy: number) => {
      if (!viewport) return { x: 0, y: 0 };
      return {
        x: (wx - viewport.originX) * viewport.zoom,
        y: (wy - viewport.originY) * viewport.zoom,
      };
    },
    [viewport]
  );

  // Draw
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !viewport) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

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

      const sx = toScreen(bbox.x, bbox.y);
      const sw = bbox.width * viewport.zoom;
      const sh = bbox.height * viewport.zoom;

      // Skip off-screen devices
      if (sx.x + sw < -50 || sx.x > rect.width + 50) continue;
      if (sx.y + sh < -50 || sx.y > rect.height + 50) continue;

      const color = DEVICE_COLORS[dev.kind] ?? DEVICE_COLORS.unknown;
      const fill = DEVICE_FILL[dev.kind] ?? DEVICE_FILL.unknown;

      // Bounding box
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.fillStyle = fill;
      ctx.strokeRect(sx.x, sx.y, sw, sh);
      ctx.fillRect(sx.x, sx.y, sw, sh);

      // Label
      const area = sw * sh;
      if (area >= MIN_LABEL_AREA) {
        const label = dev.instanceName ?? dev.id;

        // Background label box
        ctx.font = `600 ${Math.max(10, Math.min(14, sw * 0.18))}px monospace`;
        const textMetrics = ctx.measureText(label);
        const labelW = textMetrics.width + 6;
        const labelH = 18;
        const labelX = sx.x + 2;
        const labelY = sx.y + 2;

        ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
        ctx.fillRect(labelX, labelY, labelW, labelH);

        // Device name text
        ctx.fillStyle = color;
        ctx.textBaseline = "middle";
        ctx.fillText(label, labelX + 3, labelY + labelH / 2);

        // Parameter hint (e.g. W/L for MOS, AE for BJT)
        const paramStr = paramHint(dev);
        if (paramStr && sw > 120) {
          ctx.font = `400 ${Math.max(8, Math.min(11, sw * 0.13))}px monospace`;
          ctx.fillStyle = "rgba(255, 255, 255, 0.6)";
          ctx.textBaseline = "top";
          ctx.fillText(paramStr, labelX + 3, labelY + labelH + 2);
        }
      }
    }
  }, [devices, viewport, toScreen]);

  // Click hit-test
  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!onDeviceClick || !viewport) return;
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      const clickX = (e.clientX - rect.left) / viewport.zoom + viewport.originX;
      const clickY = (e.clientY - rect.top) / viewport.zoom + viewport.originY;

      // Find the smallest-area device containing the click (most specific)
      let best: AnalogDevice | null = null;
      let bestArea = Infinity;
      for (const dev of devices) {
        const b = dev.bbox;
        if (!b) continue;
        if (
          clickX >= b.x &&
          clickX <= b.x + b.width &&
          clickY >= b.y &&
          clickY <= b.y + b.height
        ) {
          const area = b.width * b.height;
          if (area < bestArea) {
            bestArea = area;
            best = dev;
          }
        }
      }
      if (best) onDeviceClick(best);
    },
    [devices, viewport, onDeviceClick]
  );

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        pointerEvents: onDeviceClick ? "auto" : "none",
        cursor: onDeviceClick ? "pointer" : "default",
      }}
      onClick={handleClick}
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
        if (rg.resistance_ohms) return `${rg.resistance_ohms.toFixed(0)}Ω`;
        return `${rg.squares.toFixed(1)}sq`;
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
