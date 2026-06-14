/**
 * NetGraphView.tsx — SPICE netlist as a force-directed device graph.
 *
 * D2D mode: nodes = devices, edges = shared nets with terminal labels.
 * Click a device → navigate to die viewer and frame the cell.
 */

import { useEffect, useMemo, useRef } from "react";
import cytoscape, { type Core, type ElementDefinition } from "cytoscape";
import type { DieAnnotations } from "shared";
import { collectDieWideAnalogDevices } from "../../api/dieWideAnalog";
import { useNavigate } from "react-router-dom";
import { useSession } from "../../state/session";

// ── Device kind → colour / shape ─────────────────────────────────

const KIND_COLOR: Record<string, string> = {
  mos: "#4488ff", bjt_npn: "#44ff66", bjt_pnp: "#66ff88",
  jfet_n: "#88ffaa", jfet_p: "#44ffaa",
  resistor: "#ffaa44", capacitor: "#44ddff",
  diode: "#ff6666", zener: "#ff6666", schottky: "#ff6666",
  inductor: "#6aadc8", unknown: "#888888",
};

/** All devices use ellipse (circle) — clean visual. */
const NODE_SHAPE = "ellipse";

interface Props {
  annotations: DieAnnotations | undefined;
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

// ── Build elements ───────────────────────────────────────────────

function buildElements(devs: NamedDevice[]): ElementDefinition[] {
  // Collect terminals by netId
  const netMap = new Map<number, Array<{dev:string;term:string}>>();
  for (const d of devs) {
    for (const t of d.terminals) {
      if (!netMap.has(t.netId)) netMap.set(t.netId, []);
      netMap.get(t.netId)!.push({ dev: d.instanceName, term: t.name });
    }
  }

  const r: ElementDefinition[] = [];
  const edgeSet = new Set<string>();

  // Device nodes
  for (const d of devs) {
    const c = KIND_COLOR[d.kind] ?? "#888";
    r.push({
      group: "nodes",
      data: {
        id: d.instanceName,
        label: d.instanceName,
        kind: d.kind,
        cellId: (d as any)._cellId ?? "",
      },
      style: {
        "background-color": c + "22",
        "border-color": c,
        shape: NODE_SHAPE,
      },
    });
  }

  // Edges: device ↔ device (shared net)
  for (const [netId, list] of netMap) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const key = [list[i].dev, list[j].dev].sort().join("<>");
        if (edgeSet.has(key)) continue;
        edgeSet.add(key);
        // Collect unique terminal names on this net for this device pair
        const terms = [...new Set(list.map(e => e.term))];
        r.push({
          group: "edges",
          data: {
            id: `e:${key}:${netId}`,
            source: list[i].dev,
            target: list[j].dev,
            label: terms.join("/"),
          },
        });
      }
    }
  }

  return r;
}

// ── Stylesheet ───────────────────────────────────────────────────

const STYLE: cytoscape.Stylesheet[] = [
  // Device nodes
  {
    selector: "node",
    style: {
      "font-family": "var(--mono)",
      color: "var(--ink)",
      "text-valign": "center",
      "text-halign": "center",
      "min-zoomed-font-size": 6,
      "border-width": 3,
      width: 48,
      height: 48,  // equal = circle
      "font-size": 10,
      "background-color": "var(--card)",
      label: "data(label)",
      "border-color": "#666",
    },
  },
  // Edges with terminal label
  {
    selector: "edge",
    style: {
      width: 1.5,
      "line-color": "var(--l2)",
      "curve-style": "bezier",
      "font-size": 8,
      "font-family": "var(--mono)",
      color: "var(--ink2)",
      "text-background-color": "var(--card)",
      "text-background-opacity": 0.9,
      "text-background-padding": 2,
      "text-border-color": "var(--l1)",
      "text-border-width": 0.5,
      "text-border-opacity": 0.6,
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

// ── Component ────────────────────────────────────────────────────

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
    return buildElements(nameDevices(devices));
  }, [annotations]);

  useEffect(() => {
    if (!containerRef.current) return;
    const cy = cytoscape({
      container: containerRef.current,
      elements,
      style: STYLE,
      layout: {
        name: "cose",
        animate: false,
        nodeRepulsion: () => 6000,
        idealEdgeLength: () => 100,
        gravity: 0.25,
        numIter: 250,
      },
      minZoom: 0.15,
      maxZoom: 5,
      wheelSensitivity: 0.3,
    });

    cy.on("tap", "node", (evt) => {
      const n = evt.target;
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
      n.connectedEdges().style({ width: 1.5, "line-color": "var(--l2)" });
    });

    cyRef.current = cy;
    return () => { cy.destroy(); cyRef.current = null; };
  }, [elements, dieId, navigate]);

  return (
    <div
      ref={containerRef}
      style={{ flex: "1 1 auto", minHeight: 0, background: "var(--card)", position: "relative" }}
    />
  );
}
