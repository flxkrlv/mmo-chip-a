/**
 * NetGraphView.tsx — Device graph with IO pins, VDD/GND rails.
 * Shows device type info in labels (M1·NMOS, Q1·NPN, R1·RES…).
 */

import { useEffect, useMemo, useRef } from "react";
import cytoscape, { type Core, type ElementDefinition } from "cytoscape";
import type { DieAnnotations } from "shared";
import { collectDieWideAnalogDevices } from "../../api/dieWideAnalog";
import { useNavigate } from "react-router-dom";
import { useSession } from "../../state/session";

// ── Palette ──────────────────────────────────────────────────────

const KIND_COLOR: Record<string, string> = {
  mos: "#4488ff", bjt_npn: "#44ff66", bjt_pnp: "#66ff88",
  jfet_n: "#88ffaa", jfet_p: "#44ffaa",
  resistor: "#ffaa44", capacitor: "#44ddff",
  diode: "#ff6666", zener: "#ff6666", schottky: "#ff6666",
  inductor: "#6aadc8", unknown: "#888888",
};

const KIND_LABEL: Record<string, string> = {
  mos: "MOS", bjt_npn: "NPN", bjt_pnp: "PNP",
  jfet_n: "NJF", jfet_p: "PJF",
  resistor: "RES", capacitor: "CAP",
  diode: "DIODE", zener: "ZENER", schottky: "SCHOTTKY",
  inductor: "IND", unknown: "?",
};

/** Categorise net names to detect power / ground rails. */
function railKind(name: string): "vdd" | "gnd" | null {
  const lo = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (/^v(dd|cc|bat|ddio)$/.test(lo)) return "vdd";
  if (/^g(nd|round)$/.test(lo) || /^vss?$/.test(lo)) return "gnd";
  return null;
}

// ── Wire → point matching ───────────────────────────────────────

function netAtPoint(
  nets: DieAnnotations["nets"],
  px: number, py: number, tol = 10,
): (DieAnnotations["nets"][number]) | null {
  const tol2 = tol * tol;
  for (const net of nets) {
    for (const edge of net.edges) {
      const a = net.nodes.find(n => n.id === edge.from);
      const b = net.nodes.find(n => n.id === edge.to);
      if (!a || !b) continue;
      const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
      let t = len2 === 0 ? 0 : ((px - a.x) * dx + (py - a.y) * dy) / len2;
      t = Math.max(0, Math.min(1, t));
      if (((a.x + t * dx - px) ** 2 + (a.y + t * dy - py) ** 2) <= tol2) return net;
    }
  }
  return null;
}

// ── Device naming ────────────────────────────────────────────────

type NamedDevice = ReturnType<typeof collectDieWideAnalogDevices>["devices"][number] & {
  instanceName: string;
  kindLabel: string;
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
    // Build a short type tag: mos → NMOS/PMOS, bjt_npn → NPN, etc.
    let kl = KIND_LABEL[d.kind] ?? "?";
    if (d.kind === "mos" && d.geometry && "mosType" in d.geometry) {
      kl = (d.geometry as any).mosType === "pmos" ? "PMOS" : "NMOS";
    }
    return { ...d, instanceName: `${p}${c[p]}`, kindLabel: kl };
  });
}

// ═════════════════════════════════════════════════════════════════
// Build elements
// ═════════════════════════════════════════════════════════════════

interface BuildCtx {
  annotations: DieAnnotations;
  devs: NamedDevice[];
  namedNets: Map<number, string>;
  netIdMap: Map<string, number>;
}

function buildElements(ctx: BuildCtx): ElementDefinition[] {
  const { annotations, devs, namedNets, netIdMap } = ctx;
  const nets = annotations.nets ?? [];
  const pins = annotations.pins ?? [];

  // ── Detect VDD / GND by net name (use real namedNets from collector) ──
  const railForNet = new Map<number, "vdd" | "gnd">();
  for (const [nid, name] of namedNets) {
    const r = railKind(name);
    if (r) railForNet.set(nid, r);
  }

  // ── Classify device terminals ───────────────────────────────────
  const byNet = new Map<number, Array<{ dev: string; term: string }>>();
  const vddDevs = new Set<string>();
  const gndDevs = new Set<string>();

  function addTerm(dev: string, term: string, netId: number) {
    const r = railForNet.get(netId);
    if (r === "vdd") { vddDevs.add(dev); return; }
    if (r === "gnd") { gndDevs.add(dev); return; }
    if (!byNet.has(netId)) byNet.set(netId, []);
    byNet.get(netId)!.push({ dev, term });
  }

  for (const d of devs) {
    for (const t of d.terminals) {
      addTerm(d.instanceName, t.name, t.netId);
    }
  }

  const result: ElementDefinition[] = [];

  // ── VDD / GND rail nodes ────────────────────────────────────
  if (vddDevs.size > 0) {
    result.push({
      group: "nodes", data: { id: "VDD", label: "VDD", nt: "rail" },
      style: { "background-color": "#ff446622", "border-color": "#ff4466", width: 60, height: 32, shape: "roundrectangle", "font-size": 11, "font-weight": "bold" },
    });
    for (const d of vddDevs) {
      const terms = devs.find(x => x.instanceName === d)?.terminals.filter(t => railForNet.get(t.netId) === "vdd") ?? [];
      result.push({
        group: "edges",
        data: { id: `e:VDD:${d}`, source: "VDD", target: d, label: terms.map(t => t.name).join("/") },
      });
    }
  }
  if (gndDevs.size > 0) {
    result.push({
      group: "nodes", data: { id: "GND", label: "GND", nt: "rail" },
      style: { "background-color": "#aa885522", "border-color": "#aa8855", width: 60, height: 32, shape: "roundrectangle", "font-size": 11, "font-weight": "bold" },
    });
    for (const d of gndDevs) {
      const terms = devs.find(x => x.instanceName === d)?.terminals.filter(t => railForNet.get(t.netId) === "gnd") ?? [];
      result.push({
        group: "edges",
        data: { id: `e:GND:${d}`, source: "GND", target: d, label: terms.map(t => t.name).join("/") },
      });
    }
  }

  // ── Device nodes ────────────────────────────────────────────
  for (const d of devs) {
    const c = KIND_COLOR[d.kind] ?? "#888";
    result.push({
      group: "nodes",
      data: { id: d.instanceName, label: `${d.instanceName}·${d.kindLabel}`, k: d.kind, cellId: (d as any)._cellId ?? "", nt: "dev" },
      style: { "background-color": c + "22", "border-color": c },
    });
  }

  // ── Device-to-device edges (non-rail nets) ──────────────────
  const edgeSet = new Set<string>();
  for (const [, list] of byNet) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const key = [list[i].dev, list[j].dev].sort().join("<>");
        if (edgeSet.has(key)) continue;
        edgeSet.add(key);
        const terms = [...new Set(list.map(e => e.term))];
        result.push({
          group: "edges",
          data: { id: `e:${key}`, source: list[i].dev, target: list[j].dev, label: terms.join("/") },
        });
      }
    }
  }

  // ── IO pins (match via real netIdMap from collector) ───────
  for (const pin of pins) {
    const matched = netAtPoint(nets, pin.x, pin.y);
    if (!matched) continue;
    const spid = netIdMap.get(matched.id);
    if (spid == null) continue;
    // Ensure the net has a name in namedNets for rail detection
    const netName = namedNets.get(spid) ?? pin.name;
    const pinId = `pin:${pin.name}`;
    result.push({
      group: "nodes",
      data: { id: pinId, label: pin.name, nt: "io", netUuid: matched.id },
      style: {
        "background-color": "#e8d44d22", "border-color": "#e8d44d", width: 32, height: 32, shape: "diamond", "font-size": 7.5,
      },
    });
    // Connect pin to all devices sharing its net
    const devsOnNet = new Set<string>();
    for (const d of devs) {
      for (const t of d.terminals) {
        if (t.netId === spid) devsOnNet.add(d.instanceName);
      }
    }
    for (const d of devsOnNet) {
      result.push({
        group: "edges",
        data: { id: `e:${pinId}:${d}`, source: pinId, target: d, label: "" },
      });
    }
  }

  return result;
}

// ═════════════════════════════════════════════════════════════════
// Stylesheet
// ═════════════════════════════════════════════════════════════════

// Cytoscape node style keys: use the short aliases for brevity
// bg = background-color, bc = border-color, w = width, h = height
// sh = shape, fs = font-size, fw = font-weight

type ES = cytoscape.Stylesheet;
const BASE: ES[] = [
  { selector: "node", style: {
    "font-family": "monospace", color: "#e8e8e8",
    "text-valign": "center", "text-halign": "center",
    "min-zoomed-font-size": 5, "border-width": 3,
    "background-color": "#1a1a1a",
    label: "data(label)", width: 52, height: 52, shape: "ellipse",
    "font-size": 8.5,
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

interface Props {
  annotations: DieAnnotations | undefined;
  onDeviceClick?: (name: string, cellId: string) => void;
}

export function NetGraphView({ annotations, onDeviceClick }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  const navigate = useNavigate();
  const dieId = useSession((s) => s.dieId);
  const cbRef = useRef(onDeviceClick);
  cbRef.current = onDeviceClick;

  const elements = useMemo<ElementDefinition[]>(() => {
    if (!annotations) return [];
    const { devices, namedNets, netIdMap } = collectDieWideAnalogDevices(annotations);
    return buildElements({ annotations, devs: nameDevices(devices), namedNets, netIdMap });
  }, [annotations]);

  // Elements already have inline style with correct Cytoscape property names.

  useEffect(() => {
    if (!containerRef.current || elements.length === 0) return;
    const cy = cytoscape({
      container: containerRef.current,
      elements,
      style: BASE,
      layout: {
        name: "cose",
        animate: false,
        nodeRepulsion: n => n.data("nt") === "rail" ? 500 : 6000,
        idealEdgeLength: e => (e.data("source") === "VDD" || e.data("source") === "GND") ? 80 : 100,
        gravity: 0.25,
        numIter: 300,
      },
      minZoom: 0.15, maxZoom: 5, wheelSensitivity: 0.3,
    });

    cy.on("tap", "node", (evt) => {
      const n = evt.target;
      if (n.data("nt") === "rail" || n.data("nt") === "io") return;
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
