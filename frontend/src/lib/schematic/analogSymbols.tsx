/**
 * analogSymbols.tsx — SVG symbols for analog devices.
 *
 * Renders analog device symbols suitable for the schematic canvas:
 *   - MOS transistor (enhancement-mode symbol)
 *   - BJT (NPN / PNP)
 *   - JFET (N-channel / P-channel)
 *   - Resistor (zigzag)
 *   - Capacitor (parallel plates)
 *   - Diode (triangle + bar)
 *
 * All symbols are rendered in a 32×32 viewBox with the device centered.
 * Terminal positions are:
 *   MOS:  G (top-left), D (top-right), S (bottom), B (bottom-left)
 *   BJT:  C (top), B (left), E (bottom-right)
 *   Resistor: PLUS (left), MINUS (right)
 *   Capacitor: PLUS (left), MINUS (right)
 *   Diode: PLUS (left), MINUS (right)
 */

import type { ReactNode } from "react";
import type { AnalogDevice, DeviceKind } from "shared";

interface TerminalPos {
  name: string;
  x: number;
  y: number;
}

interface SymbolDef {
  width: number;
  height: number;
  terminals: TerminalPos[];
  svg: ReactNode;
}

// ── MOS Transistor ───────────────────────────────────────────────
// Enhancement-mode MOSFET: gate plate (left), channel body, S/D arrows.
// pmos: circle on gate
// nmos: no circle

function mosSymbol(device: AnalogDevice): SymbolDef {
  const isPmos = device.kind === "mos" && (device.geometry as any)?.mosType === "pmos";
  const isNmos = device.kind === "mos" && (device.geometry as any)?.mosType === "nmos";

  const w = 40, h = 40;
  const cy = 20, cxGate = 10, cxBody = 24, cxD = 34, cxS = 10;

  return {
    width: w, height: h,
    terminals: [
      { name: "D", x: w - 4, y: 8 },
      { name: "G", x: 2, y: cy },
      { name: "S", x: w - 4, y: h - 8 },
      { name: "B", x: cxBody, y: h - 2 },
    ],
    svg: (
      <g>
        {/* Channel body */}
        <line x1={cxBody} y1={6} x2={cxBody} y2={h - 6}
          stroke="currentColor" strokeWidth={1.5} />
        {/* Gate plate (vertical line) */}
        <line x1={cxGate} y1={4} x2={cxGate} y2={h - 4}
          stroke="currentColor" strokeWidth={1.8} />
        {/* PMOS: circle on gate */}
        {isPmos && (
          <circle cx={cxGate} cy={cy} r={5}
            fill="none" stroke="currentColor" strokeWidth={1.2} />
        )}
        {/* NMOS: no circle, just gate connection */}
        {/* Drain connection */}
        <line x1={cxBody} y1={6} x2={cxD} y2={6}
          stroke="currentColor" strokeWidth={1.2} />
        {/* Source connection */}
        <line x1={cxBody} y1={h - 6} x2={cxS} y2={h - 6}
          stroke="currentColor" strokeWidth={1.2} />
        {/* Substrate arrow (body effect) */}
        <line x1={cxBody - 4} y1={h - 10} x2={cxBody + 4} y2={h - 10}
          stroke="currentColor" strokeWidth={1} />
        <polygon points={`${cxBody},${h-14} ${cxBody-3},${h-12} ${cxBody+3},${h-12}`}
          fill="currentColor" />
      </g>
    ),
  };
}

// ── BJT ──────────────────────────────────────────────────────────
// NPN: arrow out of emitter (pointing away from base)
// PNP: arrow into emitter (pointing toward base)

function bjtSymbol(device: AnalogDevice): SymbolDef {
  const isNpn = device.kind === "bjt_npn";
  const w = 40, h = 40;

  return {
    width: w, height: h,
    terminals: [
      { name: "C", x: w / 2, y: 2 },
      { name: "B", x: 2, y: h / 2 },
      { name: "E", x: w - 2, y: h - 2 },
    ],
    svg: (
      <g>
        {/* Base line */}
        <line x1={8} y1={h / 2} x2={w - 8} y2={h / 2}
          stroke="currentColor" strokeWidth={1.5} />
        {/* Collector (top) going to base line */}
        <line x1={w / 2} y1={4} x2={w / 2} y2={h / 2}
          stroke="currentColor" strokeWidth={1.5} />
        {/* Emitter (slanted arrow) */}
        <line x1={w - 8} y1={h / 2} x2={w / 2 + 4} y2={h - 4}
          stroke="currentColor" strokeWidth={1.5} />
        {/* Emitter arrow (NPN: outward, PNP: inward) */}
        {isNpn ? (
          <polygon points={`${w/2+4},${h-4} ${w/2+1},${h-8} ${w/2+7},${h-8}`}
            fill="currentColor" />
        ) : (
          <polygon points={`${w/2+4},${h-4} ${w/2-2},${h-8} ${w/2+6},${h-8}`}
            fill="currentColor" transform={`translate(${3},${0})`} />
        )}
      </g>
    ),
  };
}

// ── Resistor ─────────────────────────────────────────────────────
// Zigzag pattern between two terminals

function resistorSymbol(): SymbolDef {
  const w = 48, h = 24;

  return {
    width: w, height: h,
    terminals: [
      { name: "PLUS", x: 2, y: h / 2 },
      { name: "MINUS", x: w - 2, y: h / 2 },
    ],
    svg: (
      <polyline
        points={`
          2,${h/2} 8,${h/2}
          10,${4} 14,${h-4} 18,${4} 22,${h-4} 26,${4}
          30,${h-4} 34,${4} 38,${h-4} 40,${h/2}
          ${w-2},${h/2}
        `}
        fill="none" stroke="currentColor" strokeWidth={1.5}
        strokeLinejoin="round" strokeLinecap="round"
      />
    ),
  };
}

// ── Capacitor ────────────────────────────────────────────────────
// Two parallel plates

function capacitorSymbol(): SymbolDef {
  const w = 32, h = 24;

  return {
    width: w, height: h,
    terminals: [
      { name: "PLUS", x: 2, y: h / 2 },
      { name: "MINUS", x: w - 2, y: h / 2 },
    ],
    svg: (
      <g>
        <line x1={2} y1={h/2} x2={12} y2={h/2}
          stroke="currentColor" strokeWidth={1.5} />
        <line x1={12} y1={6} x2={12} y2={h-6}
          stroke="currentColor" strokeWidth={2} />
        <line x1={20} y1={6} x2={20} y2={h-6}
          stroke="currentColor" strokeWidth={2} />
        <line x1={20} y1={h/2} x2={w-2} y2={h/2}
          stroke="currentColor" strokeWidth={1.5} />
      </g>
    ),
  };
}

// ── Diode ─────────────────────────────────────────────────────────
// Triangle + bar

function diodeSymbol(): SymbolDef {
  const w = 36, h = 28;

  return {
    width: w, height: h,
    terminals: [
      { name: "PLUS", x: 2, y: h / 2 },
      { name: "MINUS", x: w - 2, y: h / 2 },
    ],
    svg: (
      <g>
        <line x1={2} y1={h/2} x2={8} y2={h/2}
          stroke="currentColor" strokeWidth={1.5} />
        {/* Triangle */}
        <polygon points={`8,${h/2} ${w-10},${4} ${w-10},${h-4}`}
          fill="none" stroke="currentColor" strokeWidth={1.5} />
        {/* Bar */}
        <line x1={w-8} y1={4} x2={w-8} y2={h-4}
          stroke="currentColor" strokeWidth={2} />
        <line x1={w-8} y1={h/2} x2={w-2} y2={h/2}
          stroke="currentColor" strokeWidth={1.5} />
      </g>
    ),
  };
}

// ── Unknown ──────────────────────────────────────────────────────

function unknownSymbol(): SymbolDef {
  return {
    width: 32, height: 24,
    terminals: [
      { name: "P1", x: 2, y: 12 },
      { name: "P2", x: 30, y: 12 },
    ],
    svg: (
      <text x={16} y={16} textAnchor="middle" fill="currentColor"
        fontSize={14} style={{ fontFamily: "monospace" }}>
        ?
      </text>
    ),
  };
}

// ── Dispatcher ───────────────────────────────────────────────────

export function analogSymbol(device: AnalogDevice): SymbolDef {
  switch (device.kind) {
    case "mos": return mosSymbol(device);
    case "bjt_npn": case "bjt_pnp": return bjtSymbol(device);
    case "jfet_n": case "jfet_p": return bjtSymbol(device); // simplified: use BJT-like symbol
    case "resistor": return resistorSymbol();
    case "capacitor": return capacitorSymbol();
    case "diode": case "zener": case "schottky": return diodeSymbol();
    default: return unknownSymbol();
  }
}

/** Render a single analog symbol as an SVG element at the given position.
 *  `color` is the device-specific colour from the layer palette. */
export function renderAnalogSymbol(
  device: AnalogDevice,
  x: number,
  y: number,
  color: string,
  size?: number,
): ReactNode {
  const sym = analogSymbol(device);
  const scale = (size ?? 1) / Math.max(sym.width, sym.height);
  const svg = (
    <g
      transform={`translate(${x - sym.width * scale / 2}, ${y - sym.height * scale / 2}) scale(${scale})`}
      color={color}
    >
      {sym.svg}
    </g>
  );
  return svg;
}
