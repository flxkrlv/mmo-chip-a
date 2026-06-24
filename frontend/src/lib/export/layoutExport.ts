/**
 * layoutExport.ts — Layout-oriented device coordinate export.
 *
 * Generates a device placement list (CSV-like) that can be consumed by
 * a Cadence SKILL script to place instances on a layout.
 *
 * Format:
 *   <instance>,<x_um>,<y_um>,<rotation>,<cellType>
 *
 * Where:
 *   x, y = lower-left corner of device bbox in die coordinates [μm]
 *   rotation = "R0" | "R90" | "R180" | "R270" (inferred from bbox aspect)
 */

import type { DieAnnotations } from "shared";
import { collectDieWideAnalogDevices } from "../../api/dieWideAnalog";

// ── Orientation helper ───────────────────────────────────────────

function orientation(w: number, h: number): string {
  // If width > height → horizontal (R0), else vertical (R90)
  return w >= h ? "R0" : "R90";
}

// ── Export ───────────────────────────────────────────────────────

export interface LayoutEntry {
  instanceName: string;
  x_um: number;
  y_um: number;
  rotation: string;
  cellType: string;
  kind: string;
  params: string;
}

export function exportLayout(
  annotations: DieAnnotations,
  umPerPx: number = 1.0,
): LayoutEntry[] {
  const { devices } = collectDieWideAnalogDevices(annotations, umPerPx);

  // Assign instance names matching the die-wide collection
  const counters: Record<string, number> = {};
  const pre: Record<string, string> = {
    mos: "M", bjt_npn: "Q", bjt_pnp: "Q", jfet_n: "J", jfet_p: "J",
    resistor: "R", capacitor: "C", diode: "D", zener: "DZ", schottky: "DS",
    inductor: "L", unknown: "X",
  };

  return devices.map((d) => {
    const prefix = pre[d.kind] ?? "X";
    counters[prefix] = (counters[prefix] ?? 0) + 1;
    const name = `${prefix}${counters[prefix]}`;
    const bbox = d.bbox;
    const x_um = bbox?.x != null ? bbox.x * umPerPx : 0;
    const y_um = bbox?.y != null ? bbox.y * umPerPx : 0;

    // Parameter string for the SKILL script
    const g = d.geometry as unknown as Record<string, unknown>;
    let params = "";
    switch (d.kind) {
      case "mos":
        params = `W=${(g.W_um as number)?.toFixed(2)}u L=${(g.L_um as number)?.toFixed(3)}u`;
        break;
      case "bjt_npn":
      case "bjt_pnp":
        params = `AE=${(g.AE_um2 as number)?.toExponential(2)}`;
        break;
      case "resistor":
        params = `S=${(g.squares as number)?.toFixed(1)} W=${(g.W_um as number)?.toFixed(1)}u`;
        break;
    }

    const cellType = `${d.kind}_${(d as any)._cellTypeId ?? "gen"}`;

    return {
      instanceName: name,
      x_um: Math.round(x_um * 100) / 100,
      y_um: Math.round(y_um * 100) / 100,
      rotation: bbox ? orientation(bbox.width, bbox.height) : "R0",
      cellType,
      kind: d.kind,
      params,
    };
  });
}

// ── Text format ──────────────────────────────────────────────────

export function renderLayoutCsv(entries: LayoutEntry[]): string {
  const lines: string[] = [
    `// Layout placement export — mmo-chip analog RE`,
    `// umPerPx is embedded in coordinates.`,
    `// Format: instance,x_um,y_um,rotation,kind,params`,
    ``,
  ];
  for (const e of entries) {
    lines.push(
      `${e.instanceName},${e.x_um},${e.y_um},${e.rotation},${e.kind},${e.params}`,
    );
  }
  return lines.join("\n");
}
