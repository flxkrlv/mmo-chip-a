/**
 * NetGraphView.tsx — Force-directed device graph with device symbols,
 * IO pins, and VDD/GND rail nodes.
 */

import { useEffect, useMemo, useRef } from "react";
import cytoscape, { type Core, type ElementDefinition } from "cytoscape";
import type { DieAnnotations } from "shared";
import { collectDieWideAnalogDevices } from "../../api/dieWideAnalog";
import { useNavigate } from "react-router-dom";
import { useSession } from "../../state/session";

// ═════════════════════════════════════════════════════════════════
// SVG symbols as data URIs
// ═════════════════════════════════════════════════════════════════

function svgUri(svg: string): string {
  return `data:image/svg+xml,${encodeURIComponent(svg.replace(/\s+/g, " ").trim())}`;
}

/** NPN BJT symbol: circle with emitter arrow. */
const BJT_SVG = svgUri(`<svg viewBox="0 0 28 28" xmlns="http://www.w3.org/2000/svg">
  <circle cx="14" cy="14" r="10" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <line x1="14" y1="24" x2="14" y2="4" stroke="currentColor" stroke-width="1.2"/>
  <line x1="4" y1="14" x2="14" y2="14" stroke="currentColor" stroke-width="1.2"/>
  <line x1="17" y1="17" x2="20" y2="20" stroke="currentColor" stroke-width="1.2"/>
  <line x1="17" y1="20" x2="20" y2="20" stroke="currentColor" stroke-width="1.2"/>
  <line x1="20" y1="17" x2="20" y2="20" stroke="currentColor" stroke-width="1.2"/>
</svg>`);

/** MOS symbol: simple channel + gate. */
const MOS_SVG = svgUri(`<svg viewBox="0 0 28 28" xmlns="http://www.w3.org/2000/svg">
  <line x1="14" y1="4" x2="14" y2="10" stroke="currentColor" stroke-width="1.5"/>
  <line x1="14" y1="14" x2="14" y2="24" stroke="currentColor" stroke-width="1.5"/>
  <line x1="14" y1="12" x2="14" y2="14" stroke="currentColor" stroke-width="3"/>
  <line x1="4" y1="14" x2="14" y2="14" stroke="currentColor" stroke-width="1.2"/>
  <line x1="17" y1="17" x2="20" y2="20" stroke="currentColor" stroke-width="1.2"/>
  <line x1="17" y1="20" x2="20" y2="20" stroke="currentColor" stroke-width="1.2"/>
  <line x1="20" y1="17" x2="20" y2="20" stroke="currentColor" stroke-width="1.2"/>
</svg>`);

/** Resistor symbol: zigzag. */
const RES_SVG = svgUri(`<svg viewBox="0 0 28 28" xmlns="http://www.w3.org/2000/svg">
  <polyline points="2,14 6,14 8,6 12,22 16,6 20,22 22,14 26,14"
    fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
</svg>`);

/** Capacitor symbol: two parallel plates. */
const CAP_SVG = svgUri(`<svg viewBox="0 0 28 28" xmlns="http://www.w3.org/2000/svg">
  <line x1="10" y1="4" x2="10" y2="24" stroke="currentColor" stroke-width="1.5"/>
  <line x1="18" y1="4" x2="18" y2="24" stroke="currentColor" stroke-width="1.5"/>
  <line x1="14" y1="5" x2="14" y2="10" stroke="currentColor" stroke-width="1.5"/>
  <line x1="14" y1="18" x2="14" y2="23" stroke="currentColor" stroke-width="1.5"/>
</svg>`);

/** Diode symbol: triangle + line. */
const DIODE_SVG = svgUri(`<svg viewBox="0 0 28 28" xmlns="http://www.w3.org/2000/svg">
  <polygon points="16,4 16,24 4,14" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <line x1="16" y1="4" x2="22" y2="4" stroke="currentColor" stroke-width="1.5"/>
  <line x1="16" y1="24" x2="22" y2="24" stroke="currentColor" stroke-width="1.5"/>
  <line x1="22" y1="4" x2="22" y2="24" stroke="currentColor" stroke-width="1.2"/>
</svg>`);

/** Inductor: loop. */
const IND_SVG = svgUri(`<svg viewBox="0 0 28 28" xmlns="http://www.w3.org/2000/svg">
  <path d="M4,14 Q8,4 12,14 Q16,4 20,14 Q24,4 26,14"
    fill="none" stroke="currentColor" stroke-width="1.5"/>
</svg>`);

function symbolSvg(kind: string): string {
  switch (kind) {
    case "mos": return MOS_SVG;
    case "bjt_npn": case "bjt_pnp": return BJT_SVG;
    case "jfet_n": case "jfet_p": return BJT_SVG;
    case "resistor": return RES_SVG;
    case "capacitor": return CAP_SVG;
    case "diode": case "zener": case "schottky": return DIODE_SVG;
    case "inductor": return IND_SVG;
    default: return "";
  }
}

// ═════════════════════════════════════════════════════════════════
// Colour palette
// ═════════════════════════════════════════════════════════════════

const KIND_COLOR: Record<string, string> = {
  mos: "#4488ff", bjt_npn: "#44ff66", bjt_pnp: "#66ff88",
  jfet_n: "#88ffaa", jfet_p: "#44ffaa",
  resistor: "#ffaa44", capacitor: "#44ddff",
  diode: "#ff6666", zener: "#ff6666", schottky: "#ff6666",
  inductor: "#6aadc8", unknown: "#888888",
};

const RAIL_COLOR = { vdd: "#ff4466", gnd: "#aa8855" };

// ═════════════════════════════════════════════════════════════════
// Wire matching helper (exported from dieWideAnalog, duplicated for
// simplicity — ~15 lines)
// ═════════════════════════════════════════════════════════════════

function matchWireToPoint(
  nets: import("shared").AnnotationNet[],
  px: number, py: number, tol: number,
): number | null {
  const tol2 = tol * tol;
  for (const net of nets) {
    for (const edge of net.edges) {
      const a = net.nodes.find(n => n.id === edge.from);
      const b = net.nodes.find(n => n.id === edge.to);
      if (!a || !b) continue;
      const dx = b.x - a.x, dy = b.y - a.y;
      const len2 = dx * dx + dy * dy;
      let t = len2 === 0 ? 0 : ((px - a.x) * dx + (py - a.y) * dy) / len2;
      t = Math.max(0, Math.min(1, t));
      const cx = a.x + t * dx, cy = a.y + t * dy;
      if ((cx - px) * (cx - px) + (cy - py) * (cy - py) <= tol2) return net.id as any;
    }
  }
  return null;
}

// ═════════════════════════════════════════════════════════════════
// Device naming
// ═════════════════════════════════════════════════════════════════

type NamedDevice = ReturnType<typeof collectDieWideAnalogDevices>["devices"][number] & {
  instanceName: string;
};

function nameDevices(raw: ReturnType<typeof collectDieWideAnalogDevices>["devices"]): NamedDevice[] {
  const c: Record<string, number> = {};
  const pre: Record<string, string> = {
    mos: "M", bjt_npn: "Q", bjt_pnp: "Q", jfet_n: "J", jfet_p: "J",
    resistor: "R", capacitor: "C", diode: "D", zener: "DZ", schottky: "DS",
    inductor: "L", unknown: "X",
  };
  return raw.map(d => {
    const p = pre[d.kind] ?? "X";
    c[p] = (c[p] ?? 0) + 1;
    return { ...d, instanceName: `${p}${c[p]}` };
  });
}

// ═════════════════════════════════════════════════════════════════
// Props
// ═════════════════════════════════════════════════════════════════

interface Props {
  annotations: DieAnnotations | undefined;
  onDeviceClick?: (name: string, cellId: string) => void;
}

// ═════════════════════════════════════════════════════════════════
// Build elements
// ═════════════════════════════════════════════════════════════════

function buildElements(
  devs: NamedDevice[],
  annotations: DieAnnotations,
): ElementDefinition[] {
  const nets = annotations.nets ?? [];
  const pins = annotations.pins ?? [];

  // ── Detect VDD / GND nets ──────────────────────────────────
  // We scan all device terminals: if a net's name matches VDD/GND
  // patterns, we route it to a rail node instead of creating
  // device-to-device edges.
  const allNetIdNames = new Map<number, string>();
  for (const d of devs) {
    for (const t of d.terminals) {
      if (t.netId >= 0 && !allNetIdNames.has(t.netId)) {
        // Try to find a human-readable name
        const an = nets.find(n => n.nodes.some(node => (node as any).netId === t.netId));
        allNetIdNames.set(t.netId, an?.name ?? `net${t.netId}`);
      }
    }
  }
  const vddIds = new Set<number>();
  const gndIds = new Set<number>();
  for (const [id, name] of allNetIdNames) {
    const lo = name.toLowerCase();
    if (/vdd|vcc|vbat|vddio/.test(lo)) vddIds.add(id);
    else if (/gnd|vss|v0|ground/.test(lo)) gndIds.add(id);
  }

  // ── Collect terminals by net ────────────────────────────────
  // Skips VDD/GND nets — those go to rail nodes.
  const netMap = new Map<number, Array<{ dev: string; term: string; cellId: string }>>();
  for (const d of devs) {
    for (const t of d.terminals) {
      if (vddIds.has(t.netId) || gndIds.has(t.netId)) continue;
      if (!netMap.has(t.netId)) netMap.set(t.netId, []);
      netMap.get(t.netId)!.push({
        dev: d.instanceName,
        term: t.name,
        cellId: (d as any)._cellId ?? "",
      });
    }
  }

  const result: ElementDefinition[] = [];
  const edgeSet = new Set<string>();

  // ── VDD / GND rail nodes ───────────────────────────────────
  const hasVdd = devs.some(d => d.terminals.some(t => vddIds.has(t.netId)));
  const hasGnd = devs.some(d => d.terminals.some(t => gndIds.has(t.netId)));

  if (hasVdd) {
    result.push({
      group: "nodes",
      data: { id: "VDD", label: "VDD", nodeType: "rail", rail: "vdd" },
      style: {
        "background-color": RAIL_COLOR.vdd + "22",
        "border-color": RAIL_COLOR.vdd,
        width: 60, height: 32, shape: "roundrectangle",
        "font-size": 11, "font-weight": "bold",
      },
    });
    for (const d of devs) {
      const vddTerms = d.terminals.filter(t => vddIds.has(t.netId));
      if (vddTerms.length === 0) continue;
      result.push({
        group: "edges",
        data: {
          id: `e:VDD:${d.instanceName}`,
          source: "VDD",
          target: d.instanceName,
          label: vddTerms.map(t => t.name).join("/"),
        },
      });
    }
  }

  if (hasGnd) {
    result.push({
      group: "nodes",
      data: { id: "GND", label: "GND", nodeType: "rail", rail: "gnd" },
      style: {
        "background-color": RAIL_COLOR.gnd + "22",
        "border-color": RAIL_COLOR.gnd,
        width: 60, height: 32, shape: "roundrectangle",
        "font-size": 11, "font-weight": "bold",
      },
    });
    for (const d of devs) {
      const gndTerms = d.terminals.filter(t => gndIds.has(t.netId));
      if (gndTerms.length === 0) continue;
      result.push({
        group: "edges",
        data: {
          id: `e:GND:${d.instanceName}`,
          source: "GND",
          target: d.instanceName,
          label: gndTerms.map(t => t.name).join("/"),
        },
      });
    }
  }

  // ── Device nodes ───────────────────────────────────────────
  for (const d of devs) {
    const c = KIND_COLOR[d.kind] ?? "#888";
    const sym = symbolSvg(d.kind);
    result.push({
      group: "nodes",
      data: { id: d.instanceName, label: d.instanceName, kind: d.kind, cellId: (d as any)._cellId ?? "" },
      style: {
        "background-color": c + "22",
        "border-color": c,
        shape: "ellipse",
        width: 52,
        height: 52,
        "background-image": sym || undefined,
        "background-width": "60%",
        "background-height": "60%",
        "background-fit": "contain",
        "background-position-x": "50%",
        "background-position-y": "60%",
        "padding": "4px",
        "text-valign": "top",
        "text-margin-y": -2,
        "font-size": 8,
        "min-zoomed-font-size": 5,
      },
    });
  }

  // ── D2D edges (non-VDD/GND nets) ────────────────────────────
  for (const [, list] of netMap) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const key = [list[i].dev, list[j].dev].sort().join("<>");
        if (edgeSet.has(key)) continue;
        edgeSet.add(key);
        const terms = [...new Set(list.map(e => e.term))];
        result.push({
          group: "edges",
          data: {
            id: `e:${key}`,
            source: list[i].dev,
            target: list[j].dev,
            label: terms.join("/"),
          },
        });
      }
    }
  }

  // ── IO pins ────────────────────────────────────────────────
  // Match each pin to a net, then connect it to the devices on that net.
  if (pins.length > 0) {
    const netByDev = new Map<string, Set<number>>();
    for (const d of devs) {
      const s = new Set<number>();
      for (const t of d.terminals) s.add(t.netId);
      netByDev.set(d.instanceName, s);
    }

    for (const pin of pins) {
      const matchedNet = matchWireToPoint(nets, pin.x, pin.y, 10);
      if (matchedNet == null) continue;
      const pinId = `pin:${pin.name}`;
      result.push({
        group: "nodes",
        data: { id: pinId, label: pin.name, nodeType: "io", netId: matchedNet },
        style: {
          "background-color": "#e8d44d22",
          "border-color": "#e8d44d",
          width: 32,
          height: 32,
          shape: "diamond",
          "font-size": 7.5,
        },
      });
      // Connect pin to all devices on this net
      const connected = new Set<string>();
      for (const d of devs) {
        if (connected.has(d.instanceName)) continue;
        if (d.terminals.some(t => t.netId === matchedNet)) {
          connected.add(d.instanceName);
          const key = `e:${pinId}:${d.instanceName}`;
          result.push({
            group: "edges",
            data: { id: key, source: pinId, target: d.instanceName, label: "" },
          });
        }
      }
    }
  }

  return result;
}

// ═════════════════════════════════════════════════════════════════
// Stylesheet
// ═════════════════════════════════════════════════════════════════

const STYLE: cytoscape.Stylesheet[] = [
  { selector: "node", style: {
    "font-family": "monospace", color: "#e8e8e8",
    "text-valign": "center", "text-halign": "center",
    "min-zoomed-font-size": 5, "border-width": 3,
    "background-color": "#1a1a1a",
    label: "data(label)",
  }},
  { selector: "edge", style: {
    width: 1.5, "line-color": "#444", "curve-style": "bezier",
    "font-size": 8, "font-family": "monospace",
    color: "#e8e8e8",
    "text-background-color": "#333",
    "text-background-opacity": 0.85,
    "text-background-padding": 2,
    "text-border-color": "#555",
    "text-border-width": 0.5,
    label: "data(label)",
    "text-valign": "center", "text-halign": "center",
    "min-zoomed-font-size": 4,
  }},
  { selector: "node:active", style: { "border-opacity": 0.7 }},
];

// ═════════════════════════════════════════════════════════════════
// Component
// ═════════════════════════════════════════════════════════════════

export function NetGraphView({ annotations, onDeviceClick }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  const navigate = useNavigate();
  const dieId = useSession((s) => s.dieId);
  const cbRef = useRef(onDeviceClick);
  cbRef.current = onDeviceClick;

  const elements = useMemo<ElementDefinition[]>(() => {
    if (!annotations) return [];
    const { devices } = collectDieWideAnalogDevices(annotations);
    return buildElements(nameDevices(devices), annotations);
  }, [annotations]);

  useEffect(() => {
    if (!containerRef.current || elements.length === 0) return;
    const cy = cytoscape({
      container: containerRef.current,
      elements,
      style: STYLE,
      layout: {
        name: "cose",
        animate: false,
        nodeRepulsion: n => n.data("nodeType") === "rail" ? 500 : 6000,
        idealEdgeLength: e => e.data("source") === "VDD" || e.data("source") === "GND" ? 80 : 100,
        gravity: 0.25,
        numIter: 300,
      },
      minZoom: 0.15,
      maxZoom: 5,
      wheelSensitivity: 0.3,
    });

    cy.on("tap", "node", (evt) => {
      const n = evt.target;
      if (n.data("nodeType") === "rail" || n.data("nodeType") === "io") return;
      const cellId = n.data("cellId");
      if (!cellId) return;
      const name = n.data("label");
      const cb = cbRef.current;
      if (cb) cb(name, cellId);
      else if (dieId)
        navigate(`/die/${encodeURIComponent(dieId)}?focusCell=${encodeURIComponent(cellId)}&focusDevice=${encodeURIComponent(name)}`);
    });

    cy.on("mouseover", "node", (evt) => {
      const n = evt.target;
      n.style({ "border-width": 5 });
      n.connectedEdges().style({ width: 3, "line-color": "#fff" });
    });
    cy.on("mouseout", "node", (evt) => {
      const n = evt.target;
      n.style({ "border-width": 3 });
      n.connectedEdges().style({ width: 1.5, "line-color": "#444" });
    });

    cyRef.current = cy;
    return () => { cy.destroy(); cyRef.current = null; };
  }, [elements, dieId, navigate]);

  if (elements.length === 0) {
    return (
      <div style={{ flex: "1 1 auto", display: "flex", alignItems: "center", justifyContent: "center", color: "#888", fontSize: 11 }}>
        no devices to display
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      style={{ flex: "1 1 auto", minHeight: 0, background: "var(--card)", position: "relative" }}
    />
  );
}
