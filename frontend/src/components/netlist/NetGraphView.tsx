/**
 * NetGraphView.tsx — SPICE netlist graph with Cytoscape.js.
 *
 * Two modes:
 *   D2D — Device-to-Device: nodes = devices, edges = shared nets (labeled)
 *   N2N — Bipartite device↔net: device nodes + net nodes (labeled),
 *         edges show terminal names (C, B, E, D, G, S…)
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

const KIND_SHAPE: Record<string, string> = {
  mos: "roundrectangle", bjt_npn: "triangle", bjt_pnp: "triangle",
  jfet_n: "triangle", jfet_p: "triangle",
  resistor: "rectangle", capacitor: "rectangle",
  diode: "diamond", zener: "diamond", schottky: "diamond",
  inductor: "rectangle", unknown: "ellipse",
};

export type GraphMode = "d2d" | "n2n";

interface Props {
  annotations: DieAnnotations | undefined;
  mode?: GraphMode;
  onDeviceClick?: (name: string, cellId: string) => void;
}

// ── Helpers ──────────────────────────────────────────────────────

type NamedDevice = ReturnType<typeof collectDieWideAnalogDevices>["devices"][number] & {
  instanceName: string;
};

function nameDevices(raw: ReturnType<typeof collectDieWideAnalogDevices>["devices"]): NamedDevice[] {
  const c: Record<string, number> = {};
  const pre: Record<string, string> = {
    mos:"M",bjt_npn:"Q",bjt_pnp:"Q",jfet_n:"J",jfet_p:"J",
    resistor:"R",capacitor:"C",diode:"D",zener:"DZ",schottky:"DS",
    inductor:"L",unknown:"X",
  };
  return raw.map(d => {
    const p = pre[d.kind] ?? "X";
    c[p] = (c[p] ?? 0) + 1;
    return { ...d, instanceName: `${p}${c[p]}` };
  });
}

// ── D2D builder ───────────────────────────────────────────────────

function buildD2D(devs: NamedDevice[], _nets: Map<number, string>): ElementDefinition[] {
  const netMap = new Map<number, Array<{dev:string;term:string}>>();
  for (const d of devs) {
    for (const t of d.terminals) {
      if (!netMap.has(t.netId)) netMap.set(t.netId, []);
      netMap.get(t.netId)!.push({ dev: d.instanceName, term: t.name });
    }
  }

  const r: ElementDefinition[] = [];
  const edgeSet = new Set<string>();

  for (const d of devs) {
    const c = KIND_COLOR[d.kind] ?? "#888";
    r.push({
      group: "nodes",
      data: { id: d.instanceName, label: d.instanceName, kind: d.kind, cellId: (d as any)._cellId ?? "" },
      style: { "background-color": c + "22", "border-color": c },
    });
  }

  for (const [netId, list] of netMap) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const key = [list[i].dev, list[j].dev].sort().join("<>");
        if (edgeSet.has(key)) continue;
        edgeSet.add(key);
        // Collect terminal pairs for this device pair on this net
        const terms = list
          .filter(e => e.dev === list[i].dev || e.dev === list[j].dev)
          .map(e => e.term);
        r.push({
          group: "edges",
          data: {
            id: `e:${key}:${netId}`,
            source: list[i].dev,
            target: list[j].dev,
            netId: String(netId),
            label: `${terms.join("/")}`,
          },
        });
      }
    }
  }

  return r;
}

// ── N2N (bipartite) builder ──────────────────────────────────────

function buildN2N(devs: NamedDevice[], namedNets: Map<number, string>): ElementDefinition[] {
  const r: ElementDefinition[] = [];
  const seenNets = new Set<number>();

  for (const d of devs) {
    const c = KIND_COLOR[d.kind] ?? "#888";
    r.push({
      group: "nodes",
      data: { id: d.instanceName, label: d.instanceName, kind: d.kind, cellId: (d as any)._cellId ?? "" },
      style: { "background-color": c + "22", "border-color": c },
    });
    for (const t of d.terminals) {
      seenNets.add(t.netId);
      const netLabel = namedNets.get(t.netId) ?? (t.netId < 0 ? `nc${Math.abs(t.netId)}` : `n${t.netId}`);
      r.push({
        group: "edges",
        data: {
          id: `e:${d.instanceName}:${t.name}:${t.netId}`,
          source: d.instanceName,
          target: `net:${t.netId}`,
          label: t.name,
        },
      });
    }
  }

  for (const netId of seenNets) {
    const label = namedNets.get(netId) ?? (netId < 0 ? `nc${Math.abs(netId)}` : `n${netId}`);
    r.push({
      group: "nodes",
      data: { id: `net:${netId}`, label, nodeType: "net" },
      style: {
        "background-color": "var(--panel)",
        "border-color": "var(--ink3)",
        "border-width": 1.5,
        width: 36,
        height: 24,
        "font-size": 8.5,
        "min-zoomed-font-size": 5,
        "text-valign": "center",
        "text-halign": "center",
        color: "var(--ink2)",
      },
    });
  }

  return r;
}

// ── Shared stylesheet ────────────────────────────────────────────

function stylesheet(mode: GraphMode): cytoscape.Stylesheet[] {
  return [
    {
      selector: "node",
      style: {
        "font-family": "var(--mono)",
        color: "var(--ink)",
        "text-valign": "center",
        "text-halign": "center",
        "min-zoomed-font-size": 5,
        "border-width": 3,
        width: 48,
        height: 36,
        "font-size": 10,
      },
    },
    {
      selector: "edge",
      style: {
        width: 1.5,
        "line-color": "var(--l2)",
        "curve-style": "bezier",
        "font-size": 8,
        "font-family": "var(--mono)",
        color: "var(--ink3)",
        "text-background-color": "var(--card)",
        "text-background-opacity": 0.85,
        "text-background-padding": 2,
        "target-arrow-color": "var(--l2)",
        label: "data(label)",
        "text-valign": "center",
        "text-halign": "center",
        "min-zoomed-font-size": 4,
      },
    },
    {
      selector: "node:active",
      style: { "border-opacity": 0.7 },
    },
  ];
}

// ── Component ────────────────────────────────────────────────────

export function NetGraphView({ annotations, mode = "d2d", onDeviceClick }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  const navigate = useNavigate();
  const dieId = useSession((s) => s.dieId);
  const cbRef = useRef(onDeviceClick);
  cbRef.current = onDeviceClick;

  const elements = useMemo<ElementDefinition[]>(() => {
    if (!annotations) return [];
    const { devices, namedNets } = collectDieWideAnalogDevices(annotations);
    const named = nameDevices(devices);
    return mode === "d2d" ? buildD2D(named, namedNets) : buildN2N(named, namedNets);
  }, [annotations, mode]);

  const layoutOpts = useMemo(() => {
    const common = {
      name: "cose" as const,
      animate: false,
      gravity: 0.25,
      idealEdgeLength: () => 100,
    };
    if (mode === "n2n") {
      return { ...common, nodeRepulsion: () => 15000, numIter: 1000, edgeElasticity: () => 0.1 };
    }
    return { ...common, nodeRepulsion: () => 6000, numIter: 250 };
  }, [mode]);

  useEffect(() => {
    if (!containerRef.current) return;
    const cy = cytoscape({
      container: containerRef.current,
      elements,
      style: stylesheet(mode),
      layout: layoutOpts,
      minZoom: 0.15,
      maxZoom: 5,
      wheelSensitivity: 0.3,
    });

    cy.on("tap", "node", (evt) => {
      const n = evt.target;
      const cellId = n.data("cellId");
      if (!cellId || n.data("nodeType") === "net") return;
      const name = n.data("label");
      const cb = cbRef.current;
      if (cb && cellId) cb(name, cellId);
      else if (cellId && dieId)
        navigate(`/die/${encodeURIComponent(dieId)}?focusCell=${encodeURIComponent(cellId)}&focusDevice=${encodeURIComponent(name)}`);
    });

    cy.on("mouseover", "node", (evt) => {
      const n = evt.target;
      if (n.data("nodeType") !== "net") {
        n.style({ "border-width": 5 });
        n.connectedEdges().style({ width: 3, "line-color": "#fff" });
        n.neighborhood().nodes().forEach(nb => {
          nb.style({ "border-width": 4, "border-color": "#fff" });
        });
      }
    });
    cy.on("mouseout", "node", (evt) => {
      const n = evt.target;
      if (n.data("nodeType") !== "net") {
        n.style({ "border-width": 3 });
        n.connectedEdges().style({ width: 1.5, "line-color": "var(--l2)" });
        n.neighborhood().nodes().forEach(nb => {
          const c = KIND_COLOR[nb.data("kind")] ?? "var(--ink3)";
          nb.style({ "border-width": nb.data("nodeType") === "net" ? 1.5 : 3, "border-color": c });
        });
      }
    });

    cyRef.current = cy;
    return () => { cy.destroy(); cyRef.current = null; };
  }, [elements, layoutOpts, dieId, navigate, mode]);

  return (
    <div
      ref={containerRef}
      style={{ flex: "1 1 auto", minHeight: 0, background: "var(--card)", position: "relative" }}
    />
  );
}
