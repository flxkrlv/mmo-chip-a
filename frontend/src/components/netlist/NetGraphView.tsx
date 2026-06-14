/**
 * NetGraphView.tsx — SPICE netlist visualization as an interactive
 * force-directed device connection graph using Cytoscape.js.
 *
 * Two modes:
 *   D2D (Device-to-Device) — nodes = devices, edges = shared nets
 *   N2N (Net-to-Net) — bipartite: devices + net nodes, edges = terminal→net
 *
 * Click on a device node navigates to the die viewer and frames the cell.
 */

import { useEffect, useMemo, useRef } from "react";
import cytoscape, { type Core, type ElementDefinition } from "cytoscape";
import type { DieAnnotations } from "shared";
import { collectDieWideAnalogDevices } from "../../api/dieWideAnalog";
import { useNavigate } from "react-router-dom";
import { useSession } from "../../state/session";

// ── Device kind → colour / shape ─────────────────────────────────

const DEVICE_STYLE: Record<string, { color: string; shape: string }> = {
  mos: { color: "#4488ff", shape: "roundrectangle" },
  bjt_npn: { color: "#44ff66", shape: "triangle" },
  bjt_pnp: { color: "#66ff88", shape: "triangle" },
  jfet_n: { color: "#88ffaa", shape: "triangle" },
  jfet_p: { color: "#44ffaa", shape: "triangle" },
  resistor: { color: "#ffaa44", shape: "rectangle" },
  capacitor: { color: "#44ddff", shape: "rectangle" },
  diode: { color: "#ff6666", shape: "diamond" },
  zener: { color: "#ff6666", shape: "diamond" },
  schottky: { color: "#ff6666", shape: "diamond" },
  inductor: { color: "#6aadc8", shape: "rectangle" },
  unknown: { color: "#888888", shape: "ellipse" },
};

// ── Props ────────────────────────────────────────────────────────

export type GraphMode = "d2d" | "n2n";

interface Props {
  annotations: DieAnnotations | undefined;
  /** Graph view mode. */
  mode?: GraphMode;
  /** Called when user clicks a device node. Receives instanceName + cellId. */
  onDeviceClick?: (instanceName: string, cellId: string) => void;
}

// ── Helpers ──────────────────────────────────────────────────────

type NamedDevice = ReturnType<typeof collectDieWideAnalogDevices>["devices"][number] & {
  instanceName: string;
};

function assignInstanceNames(
  devices: ReturnType<typeof collectDieWideAnalogDevices>["devices"],
): NamedDevice[] {
  const counters: Record<string, number> = {};
  const prefixMap: Record<string, string> = {
    mos: "M", bjt_npn: "Q", bjt_pnp: "Q", jfet_n: "J", jfet_p: "J",
    resistor: "R", capacitor: "C", diode: "D", zener: "DZ", schottky: "DS",
    inductor: "L", unknown: "X",
  };
  return devices.map((d) => {
    const prefix = prefixMap[d.kind] ?? "X";
    counters[prefix] = (counters[prefix] ?? 0) + 1;
    return { ...d, instanceName: `${prefix}${counters[prefix]}` };
  });
}

function buildD2D(
  namedDevices: NamedDevice[],
  namedNets: Map<number, string>,
): ElementDefinition[] {
  // Group devices by net
  const netToDevices = new Map<
    number,
    Array<{ name: string; cellId: string }>
  >();
  for (const d of namedDevices) {
    const name = d.instanceName;
    for (const t of d.terminals) {
      if (!netToDevices.has(t.netId)) netToDevices.set(t.netId, []);
      netToDevices.get(t.netId)!.push({ name, cellId: (d as any)._cellId ?? "" });
    }
  }

  const nodes: ElementDefinition[] = [];
  const edges: ElementDefinition[] = [];
  const edgeSet = new Set<string>();

  for (const d of namedDevices) {
    const name = d.instanceName;
    const s = DEVICE_STYLE[d.kind] ?? DEVICE_STYLE.unknown;
    nodes.push({
      group: "nodes",
      data: { id: name, label: name, kind: d.kind, cellId: (d as any)._cellId ?? "" },
      style: { "background-color": s.color + "22", "border-color": s.color },
    });
  }

  for (const [, devs] of netToDevices) {
    for (let i = 0; i < devs.length; i++) {
      for (let j = i + 1; j < devs.length; j++) {
        const key = [devs[i].name, devs[j].name].sort().join("<>");
        if (edgeSet.has(key)) continue;
        edgeSet.add(key);
        edges.push({
          group: "edges",
          data: {
            id: `e:${key}`,
            source: devs[i].name,
            target: devs[j].name,
          },
        });
      }
    }
  }

  return [...nodes, ...edges];
}

function buildN2N(
  namedDevices: NamedDevice[],
  namedNets: Map<number, string>,
): ElementDefinition[] {
  const netSet = new Set<number>();
  const nodes: ElementDefinition[] = [];
  const edges: ElementDefinition[] = [];

  for (const d of namedDevices) {
    const name = d.instanceName;
    const s = DEVICE_STYLE[d.kind] ?? DEVICE_STYLE.unknown;
    nodes.push({
      group: "nodes",
      data: { id: name, label: name, kind: d.kind, cellId: (d as any)._cellId ?? "", nodeType: "device" },
      style: { "background-color": s.color + "22", "border-color": s.color, width: 48, height: 36 },
    });
    for (const t of d.terminals) {
      netSet.add(t.netId);
      // Edge from device to net, labeled with terminal name
      const netLabel = namedNets.get(t.netId) ?? `net${t.netId}`;
      edges.push({
        group: "edges",
        data: {
          id: `e:${name}:${t.name}`,
          source: name,
          target: `net:${t.netId}`,
          terminal: t.name,
          netName: netLabel,
        },
      });
    }
  }

  // Net nodes (small circles)
  for (const netId of netSet) {
    const label = namedNets.get(netId) ?? `net${netId}`;
    nodes.push({
      group: "nodes",
      data: { id: `net:${netId}`, label, nodeType: "net", netId: String(netId) },
      style: {
        "background-color": "var(--ink3)",
        "border-color": "var(--ink3)",
        "border-width": 1,
        width: 20,
        height: 20,
        "font-size": 8,
        "min-zoomed-font-size": 4,
        "text-valign": "bottom",
        "text-halign": "center",
        "text-margin-y": -2,
      },
    });
  }

  return [...nodes, ...edges];
}

// ── Default stylesheet ──────────────────────────────────────────

const BASE_STYLE: cytoscape.Stylesheet[] = [
  {
    selector: "node[nodeType = 'device']",
    style: {
      "font-size": 10,
      "font-family": "var(--mono)",
      color: "var(--ink)",
      "text-valign": "center",
      "text-halign": "center",
      "min-zoomed-font-size": 6,
      "border-width": 3,
    },
  },
  {
    selector: "edge",
    style: {
      width: 1.5,
      "line-color": "var(--l2)",
      "curve-style": "bezier",
    },
  },
  {
    selector: "edge:visible",
    style: { "target-arrow-color": "var(--l2)" },
  },
  {
    selector: "node:active",
    style: { "border-opacity": 0.7 },
  },
];

// ── Component ────────────────────────────────────────────────────

export function NetGraphView({ annotations, mode = "d2d", onDeviceClick }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  const navigate = useNavigate();
  const dieId = useSession((s) => s.dieId);
  const onDeviceClickRef = useRef(onDeviceClick);
  onDeviceClickRef.current = onDeviceClick;

  const elements = useMemo<ElementDefinition[]>(() => {
    if (!annotations) return [];
    const { devices, namedNets } = collectDieWideAnalogDevices(annotations);
    const named = assignInstanceNames(devices);
    if (mode === "d2d") return buildD2D(named, namedNets);
    return buildN2N(named, namedNets);
  }, [annotations, mode]);

  // Layout config: N2N needs more repulsion since it has more nodes
  const layoutOptions = useMemo(() => ({
    name: "cose" as const,
    animate: false,
    nodeRepulsion: mode === "n2n" ? () => 12000 : () => 8000,
    idealEdgeLength: () => 120,
    gravity: 0.25,
    numIter: mode === "n2n" ? 1000 : 250,
  }), [mode]);

  useEffect(() => {
    if (!containerRef.current) return;
    const cy = cytoscape({
      container: containerRef.current,
      elements,
      style: [
        ...BASE_STYLE,
        // Device node borders by kind (set via element style)
        {
          selector: "node[nodeType = 'net']",
          style: {
            "background-color": "var(--ink3)",
            opacity: 0.7,
          },
        },
      ],
      layout: layoutOptions,
      minZoom: 0.15,
      maxZoom: 5,
      wheelSensitivity: 0.3,
    });

    // Click → navigate to die viewer
    cy.on("tap", "node[nodeType = 'device']", (evt) => {
      const node = evt.target;
      const cellId = node.data("cellId");
      const name = node.data("label");
      const cb = onDeviceClickRef.current;
      if (cb && cellId) {
        cb(name, cellId);
      } else if (cellId && dieId) {
        navigate(`/die/${encodeURIComponent(dieId)}?focusCell=${encodeURIComponent(cellId)}&focusDevice=${encodeURIComponent(name)}`);
      }
    });

    // Hover: highlight connected edges + neighbor nodes
    cy.on("mouseover", "node[nodeType = 'device']", (evt) => {
      const node = evt.target;
      node.style({ "border-width": 5 });
      const ee = node.connectedEdges();
      ee.style({ width: 3, "line-color": "#fff" });
      // Highlight neighbor net nodes in N2N mode
      if (mode === "n2n") {
        ee.targets().style({ opacity: 1, "border-width": 3, "border-color": "#fff" });
        ee.sources().style({ opacity: 1, "border-width": 3, "border-color": "#fff" });
      }
    });
    cy.on("mouseout", "node[nodeType = 'device']", (evt) => {
      const node = evt.target;
      node.style({ "border-width": 3 });
      const ee = node.connectedEdges();
      ee.style({ width: 1.5, "line-color": "var(--l2)" });
      if (mode === "n2n") {
        ee.targets().style({ opacity: 0.7, "border-width": 1, "border-color": "var(--ink3)" });
        ee.sources().style({ opacity: 0.7, "border-width": 1, "border-color": "var(--ink3)" });
      }
    });

    cyRef.current = cy;

    return () => {
      cy.destroy();
      cyRef.current = null;
    };
  }, [elements, layoutOptions, dieId, navigate, mode]);

  return (
    <div
      ref={containerRef}
      style={{
        flex: "1 1 auto",
        minHeight: 0,
        background: "var(--card)",
        position: "relative",
      }}
    />
  );
}
