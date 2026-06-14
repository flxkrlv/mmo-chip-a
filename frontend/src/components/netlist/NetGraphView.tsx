/**
 * NetGraphView.tsx — SPICE netlist visualization as an interactive
 * force-directed device connection graph using Cytoscape.js.
 *
 * Nodes = devices (M1, Q1, R1…), edges = shared nets between devices.
 * Click on a node navigates to the die viewer and frames the cell.
 */

import { useEffect, useMemo, useRef } from "react";
import cytoscape, { type Core, type ElementDefinition } from "cytoscape";
import type { DieAnnotations } from "shared";
import { collectDieWideAnalogDevices } from "../../api/dieWideAnalog";
import { useNavigate } from "react-router-dom";
import { useSession } from "../../state/session";

// ── Device kind → colour / shape ─────────────────────────────────

const STYLE_BY_KIND: Record<
  string,
  { color: string; shape: string; label: string }
> = {
  mos: { color: "#4488ff", shape: "roundrectangle", label: "MOS" },
  bjt_npn: { color: "#44ff66", shape: "triangle", label: "NPN" },
  bjt_pnp: { color: "#66ff88", shape: "triangle", label: "PNP" },
  jfet_n: { color: "#88ffaa", shape: "triangle", label: "NJF" },
  jfet_p: { color: "#44ffaa", shape: "triangle", label: "PJF" },
  resistor: { color: "#ffaa44", shape: "rectangle", label: "R" },
  capacitor: { color: "#44ddff", shape: "rectangle", label: "C" },
  diode: { color: "#ff6666", shape: "diamond", label: "D" },
  zener: { color: "#ff6666", shape: "diamond", label: "DZ" },
  schottky: { color: "#ff6666", shape: "diamond", label: "DS" },
  inductor: { color: "#6aadc8", shape: "rectangle", label: "L" },
  unknown: { color: "#888888", shape: "ellipse", label: "?" },
};

interface Props {
  annotations: DieAnnotations | undefined;
  /** Called when user clicks a device node. Receives instanceName + cellId. */
  onDeviceClick?: (instanceName: string, cellId: string) => void;
}

/** Cytoscape stylesheet. */
const STYLESHEET: cytoscape.Stylesheet[] = [
  {
    selector: "node",
    style: {
      "background-color": "var(--card)",
      "border-width": 3,
      "border-color": "#666",
      width: 48,
      height: 36,
      label: "data(label)",
      "font-size": 10,
      "font-family": "var(--mono)",
      color: "var(--ink)",
      "text-valign": "center",
      "text-halign": "center",
      "min-zoomed-font-size": 6,
    },
  },
  {
    selector: "edge",
    style: {
      width: 2,
      "line-color": "var(--l2)",
      "target-arrow-color": "var(--l2)",
      "curve-style": "haystack",
    },
  },
  {
    selector: "node:active",
    style: { "border-opacity": 0.7 },
  },
];

export function NetGraphView({ annotations, onDeviceClick }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  const navigate = useNavigate();
  const dieId = useSession((s) => s.dieId);
  const onDeviceClickRef = useRef(onDeviceClick);
  onDeviceClickRef.current = onDeviceClick;

  // Build cytoscape elements from annotations
  const elements = useMemo<ElementDefinition[]>(() => {
    if (!annotations) return [];
    const { devices, namedNets } = collectDieWideAnalogDevices(annotations);

    // Assign instance names (M1, Q1, R1…)
    const counters: Record<string, number> = {};
    const namedDevices = devices.map((d) => {
      const prefix = (
        {
          mos: "M",
          bjt_npn: "Q",
          bjt_pnp: "Q",
          jfet_n: "J",
          jfet_p: "J",
          resistor: "R",
          capacitor: "C",
          diode: "D",
          zener: "DZ",
          schottky: "DS",
          inductor: "L",
          unknown: "X",
        } as Record<string, string>
      )[d.kind] ?? "X";
      counters[prefix] = (counters[prefix] ?? 0) + 1;
      return { ...d, instanceName: `${prefix}${counters[prefix]}` };
    });

    // Group devices by net → which devices share each net
    const netToDevices = new Map<number, Array<{ name: string; terminal: string; cellId: string }>>();
    for (const d of namedDevices) {
      const name = d.instanceName ?? d.id;
      for (const t of d.terminals) {
        const netId = t.netId;
        if (!netToDevices.has(netId)) netToDevices.set(netId, []);
        netToDevices.get(netId)!.push({
          name,
          terminal: t.name,
          cellId: (d as any)._cellId ?? "",
        });
      }
    }

    const nodeDefs: ElementDefinition[] = [];
    const edgeSet = new Set<string>();

    // Device nodes
    for (const d of namedDevices) {
      const name = d.instanceName ?? d.id;
      const style = STYLE_BY_KIND[d.kind] ?? STYLE_BY_KIND.unknown;
      const cellId = (d as any)._cellId ?? "";
      nodeDefs.push({
        group: "nodes",
        data: {
          id: name,
          label: name,
          kind: d.kind,
          cellId,
          device: d,
        },
        style: {
          "background-color": style.color + "22",
          "border-color": style.color,
        },
      });
    }

    // Edges: connect devices that share a net
    for (const [netId, devices] of netToDevices) {
      for (let i = 0; i < devices.length; i++) {
        for (let j = i + 1; j < devices.length; j++) {
          const key = [devices[i].name, devices[j].name].sort().join("<>");
          if (edgeSet.has(key)) continue;
          edgeSet.add(key);
          nodeDefs.push({
            group: "edges",
            data: {
              id: `e:${key}`,
              source: devices[i].name,
              target: devices[j].name,
              netId: String(netId),
              netName: namedNets.get(netId) ?? `net${netId}`,
            },
          });
        }
      }
    }

    return nodeDefs;
  }, [annotations]);

  // Mount / update cytoscape
  useEffect(() => {
    if (!containerRef.current) return;
    const cy = cytoscape({
      container: containerRef.current,
      elements,
      style: STYLESHEET,
      layout: {
        name: "cose",
        animate: false,
        nodeRepulsion: () => 8000,
        idealEdgeLength: () => 120,
        gravity: 0.25,
      },
      minZoom: 0.2,
      maxZoom: 4,
      wheelSensitivity: 0.3,
    });

    // Click on a device node → callback / navigate
    cy.on("tap", "node", (evt) => {
      const node = evt.target;
      const cellId = node.data("cellId");
      const name = node.data("label");
      // Store in ref for the callback
      const cb = onDeviceClickRef.current;
      if (cb && cellId) {
        cb(name, cellId);
      } else if (cellId && dieId) {
        navigate(`/die/${encodeURIComponent(dieId)}?focusCell=${encodeURIComponent(cellId)}&focusDevice=${encodeURIComponent(name)}`);
      }
    });

    // Hover highlight
    cy.on("mouseover", "node", (evt) => {
      const node = evt.target;
      node.style({ "border-width": 5 });
      // Highlight connected edges
      node.connectedEdges().style({ width: 3, "line-color": "#fff" });
    });
    cy.on("mouseout", "node", (evt) => {
      const node = evt.target;
      node.style({ "border-width": 3 });
      node.connectedEdges().style({ width: 2, "line-color": "var(--l2)" });
    });

    cyRef.current = cy;

    return () => {
      cy.destroy();
      cyRef.current = null;
    };
  }, [elements, dieId, navigate]);

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
