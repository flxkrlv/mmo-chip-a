/**
 * NetGraphView.tsx — Device graph with IO pins, VDD/GND rails.
 * Shows device type info in labels (M1·NMOS, Q1·NPN, R1·RES…).
 *
 * Toolbar:
 *   - "Hide VDD/GND" toggle (default: on)
 *   - Net filter dropdown — select a net to highlight all devices on it
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import cytoscape, { type Core, type ElementDefinition } from "cytoscape";
import type { DieAnnotations } from "shared";
import { collectDieWideAnalogDevices, getRenameVersion } from "../../api/dieWideAnalog";
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

/**
 * Check if a net name matches VDD or GND.
 * Uses exact case-insensitive match against user-supplied names first,
 * then falls back to the built-in heuristic.
 */
function railKind(
  name: string,
  userVdd?: string,
  userGnd?: string,
): "vdd" | "gnd" | null {
  const lo = name.toLowerCase();
  // User-supplied exact match (e.g. "VDD", "GND", "vdd!", "gnd!")
  if (userVdd && lo === userVdd.toLowerCase()) return "vdd";
  if (userGnd && lo === userGnd.toLowerCase()) return "gnd";
  // Built-in heuristic as fallback
  const clean = lo.replace(/[^a-z0-9]/g, "");
  if (/^v(dd|cc|bat|ddio)$/.test(clean)) return "vdd";
  if (/^g(nd|round)$/.test(clean) || /^vss?$/.test(clean)) return "gnd";
  return null;
}

/** Debug: log namedNets to console when module loads */
const _railKindDebugCtx = { fired: false };

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
  const usedNames = new Set<string>();
  return raw.map(d => {
    // Preserve stable instanceName if already set (from assignStableInstanceNames)
    if (d.instanceName && !usedNames.has(d.instanceName)) {
      let kl = KIND_LABEL[d.kind] ?? "?";
      if (d.kind === "mos" && d.geometry && "mosType" in d.geometry) {
        kl = (d.geometry as any).mosType === "pmos" ? "PMOS" : "NMOS";
      }
      usedNames.add(d.instanceName);
      return { ...d, instanceName: d.instanceName, kindLabel: kl };
    }
    const p = pre[d.kind] ?? "X";
    c[p] = (c[p] ?? 0) + 1;
    let kl = KIND_LABEL[d.kind] ?? "?";
    if (d.kind === "mos" && d.geometry && "mosType" in d.geometry) {
      kl = (d.geometry as any).mosType === "pmos" ? "PMOS" : "NMOS";
    }
    const name = `${p}${c[p]}`;
    usedNames.add(name);
    return { ...d, instanceName: name, kindLabel: kl };
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
  userVdd?: string;
  userGnd?: string;
}

let _debugFired = false;

function buildElements(ctx: BuildCtx, hideGlobalNets: boolean): ElementDefinition[] {
  const { annotations, devs, namedNets, netIdMap, userVdd, userGnd } = ctx;
  const nets = annotations.nets ?? [];
  const pins = annotations.pins ?? [];

  // ── Detect VDD / GND by net name ──
  // Uses user-supplied net names when available, falls back to built-in heuristic.
  const railForNet = new Map<number, "vdd" | "gnd">();
  for (const [nid, name] of namedNets) {
    const r = railKind(name, userVdd, userGnd);
    if (r) railForNet.set(nid, r);
  }

  // Debug: dump rail detection once
  if (!_debugFired) {
    _debugFired = true;


    for (const [nid, name] of namedNets) {
      const r = railForNet.get(nid);

    }

    for (const d of devs) {
      const terms = d.terminals.map(t => `${t.name}:netId=${t.netId}${railForNet.has(t.netId) ? "["+railForNet.get(t.netId)+"]" : ""}`).join(", ");

    }
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

  // ── VDD / GND rail nodes (skipped when hidden) ──────────────
  if (!hideGlobalNets) {
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
    // If global nets are hidden, skip IO pins that also match VDD/GND
    // (they'd just duplicate the hidden rail, creating a dangling node)
    if (hideGlobalNets && railKind(pin.name, userVdd, userGnd)) continue;
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

/**
 * Collect net id → name mapping from namedNets, sorted alphabetically.
 * First entry is a "—" placeholder (no filter).
 */
function buildNetList(namedNets: Map<number, string>): Array<{ id: number | null; name: string }> {
  const list: Array<{ id: number | null; name: string }> = [{ id: null, name: "— all nets" }];
  const entries = [...namedNets.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  for (const [id, name] of entries) {
    list.push({ id, name });
  }
  return list;
}

// ═════════════════════════════════════════════════════════════════
// Stylesheet
// ═════════════════════════════════════════════════════════════════

type ES = cytoscape.StylesheetCSS;
const BASE: ES[] = [
  { selector: "node", css: {
    "font-family": "monospace", color: "#e8e8e8",
    "text-valign": "center", "text-halign": "center",
    "min-zoomed-font-size": 5, "border-width": 3,
    "background-color": "#1a1a1a",
    label: "data(label)", width: 52, height: 52, shape: "ellipse",
    "font-size": 8.5,
  }},
  { selector: "edge", css: {
    width: "2", "line-color": "#667", "curve-style": "bezier",
    "font-size": "8.5", "font-family": "monospace",
    color: "#ccc",
    "text-background-color": "#222",
    "text-background-opacity": 0.7,
    "text-background-padding": "2",
    label: "data(label)",
    "text-valign": "center", "text-halign": "center",
    "min-zoomed-font-size": "4",
  }},
  { selector: "node:active", css: { "border-opacity": 0.7 }},
  // Net filter highlight / dim
  { selector: ".net-dim", css: { opacity: 0.12 }},
  { selector: ".net-dim-edge", css: { opacity: 0.08 }},
  { selector: ".net-highlight", css: {
    "border-width": 5,
    "border-color": "#ffcc00",
  }},
  // Instance highlight (from INSTANCES list)
  { selector: ".inst-dim", css: { opacity: 0.12 }},
  { selector: ".inst-dim-edge", css: { opacity: 0.08 }},
  { selector: ".inst-highlight", css: {
    "border-width": 5,
    "border-color": "#44ddff",
  }},
];

// ═════════════════════════════════════════════════════════════════
// Component
// ═════════════════════════════════════════════════════════════════

interface Props {
  annotations: DieAnnotations | undefined;
  onDeviceClick?: (name: string, cellId: string) => void;
  /** User-configured VDD net name from page settings. */
  vddNet?: string;
  /** User-configured GND net name from page settings. */
  gndNet?: string;
  /** Instance name to highlight on the graph (yellow border). */
  highlightDevice?: string | null;
  /** Called when user taps empty area of the canvas (e.g. to clear selection). */
  onCanvasTap?: () => void;
}

export function NetGraphView({ annotations, onDeviceClick, vddNet, gndNet, highlightDevice, onCanvasTap }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  const navigate = useNavigate();
  const dieId = useSession((s) => s.dieId);
  const cbRef = useRef(onDeviceClick);
  cbRef.current = onDeviceClick;
  const canvasTapRef = useRef(onCanvasTap);
  canvasTapRef.current = onCanvasTap;

  // ── Toolbar state ──────────────────────────────────────────
  const [hideGlobalNets, setHideGlobalNets] = useState(true);
  const [selectedNet, setSelectedNet] = useState<number | null>(null);

  // Collected data
  const collected = useMemo(() => {
    if (!annotations) return null;
    return collectDieWideAnalogDevices(annotations, annotations?.umPerPx ?? 1);
  }, [annotations, getRenameVersion()]);

  const collAnn = useMemo(() => annotations, [annotations]);

  const devs = useMemo(() => {
    if (!collected || !collAnn) return [];
    return nameDevices(collected.devices);
  }, [collected, collAnn]);

  const netList = useMemo(() => {
    if (!collected) return [];
    return buildNetList(collected.namedNets);
  }, [collected]);

  const elements = useMemo<ElementDefinition[]>(() => {
    if (!collected || !collAnn) return [];
    return buildElements({
      annotations: collAnn,
      devs,
      namedNets: collected.namedNets,
      netIdMap: collected.netIdMap,
      userVdd: vddNet,
      userGnd: gndNet,
    }, hideGlobalNets);
  }, [collAnn, devs, collected, hideGlobalNets, vddNet, gndNet]);

  // ── Create / update Cytoscape instance ─────────────────────
  useEffect(() => {
    if (!containerRef.current || elements.length === 0) return;
    cyRef.current?.destroy();

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
      minZoom: 0.15, maxZoom: 5, wheelSensitivity: 2,
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

    // Click on empty canvas area → clear instance selection
    cy.on("tap", (evt) => {
      if (evt.target === cy) {
        canvasTapRef.current?.();
      }
    });

    cyRef.current = cy;
    return () => { cy.destroy(); cyRef.current = null; };
  }, [elements, dieId, navigate]);

  // ── Apply net filter highlight ─────────────────────────────
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;

    // Remove all filter classes first
    cy.nodes().removeClass("net-dim net-highlight");
    cy.edges().removeClass("net-dim-edge");

    if (selectedNet == null) return;

    // Find devices whose terminals include this net
    const devIds = new Set<string>();
    for (const d of devs) {
      for (const t of d.terminals) {
        if (t.netId === selectedNet) {
          devIds.add(d.instanceName);
          break;
        }
      }
    }

    // Dim everything except the target net's devices
    const allNodes = cy.nodes();
    const allEdges = cy.edges();

    for (const node of allNodes) {
      const id = node.data("id");
      if (id === "VDD" || id === "GND") continue; // don't dim rail nodes
      if (node.data("nt") === "io") continue; // don't dim IO pins
      if (devIds.has(id)) {
        // Also add highlight border
        node.addClass("net-highlight");
      } else {
        node.addClass("net-dim");
      }
    }

    for (const edge of allEdges) {
      const src = edge.data("source");
      const tgt = edge.data("target");
      // Keep edge visible if both ends are highlighted
      if (devIds.has(src) && devIds.has(tgt)) continue;
      // Keep edge visible if one end is a highlighted dev and the other is IO pin or rail
      if (
        (devIds.has(src) || devIds.has(tgt)) &&
        (allNodes.getElementById(src).data("nt") === "io" || allNodes.getElementById(src).data("nt") === "rail" ||
         allNodes.getElementById(tgt).data("nt") === "io" || allNodes.getElementById(tgt).data("nt") === "rail")
      ) continue;
      edge.addClass("net-dim-edge");
    }

  }, [selectedNet, devs]);

  // ── Instance highlight (from INSTANCES list) ───────────────
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;

    // Remove previous instance highlight
    cy.nodes().removeClass("inst-dim inst-highlight");
    cy.edges().removeClass("inst-dim-edge");

    if (!highlightDevice) return;

    const node = cy.getElementById(highlightDevice);
    if (!node || node.length === 0) return;

    // Dim all other nodes
    for (const n of cy.nodes()) {
      const id = n.data("id");
      if (id === "VDD" || id === "GND") continue;
      if (n.data("nt") === "io") continue;
      if (id === highlightDevice) {
        n.addClass("inst-highlight");
      } else {
        n.addClass("inst-dim");
      }
    }

    // Dim edges that don't involve the highlighted node
    for (const e of cy.edges()) {
      const src = e.data("source");
      const tgt = e.data("target");
      if (src === highlightDevice || tgt === highlightDevice) continue;
      e.addClass("inst-dim-edge");
    }
  }, [highlightDevice]);

  // ── Toolbar change handlers ────────────────────────────────
  const onToggleRails = useCallback(() => {
    setHideGlobalNets(v => !v);
  }, []);

  const onNetChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value;
    setSelectedNet(val === "" ? null : parseInt(val, 10));
  }, []);

  if (elements.length === 0) {
    return (
      <div style={{ flex: "1 1 auto", display: "flex", alignItems: "center", justifyContent: "center", color: "#888", fontSize: 11 }}>
        no devices to display
      </div>
    );
  }

  return (
    <div style={{ flex: "1 1 auto", minHeight: 0, display: "flex", flexDirection: "column" }}>
      {/* ── Toolbar ──────────────────────────────────────────── */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "4px 10px",
          borderBottom: "1px solid var(--l2)",
          background: "var(--panel)",
          flex: "0 0 auto",
          fontSize: 10,
          color: "var(--ink2)",
        }}
      >
        {/* VDD/GND toggle */}
        <label style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer", userSelect: "none" }}>
          <input
            type="checkbox"
            checked={hideGlobalNets}
            onChange={onToggleRails}
          />
          Hide VDD/GND
        </label>

        <div style={{ width: 1, height: 14, background: "var(--l2)" }} />

        {/* Net filter dropdown */}
        <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <span style={{ color: "var(--ink3)" }}>Net:</span>
          <select
            value={selectedNet == null ? "" : String(selectedNet)}
            onChange={onNetChange}
            style={{
              fontSize: 10,
              padding: "1px 4px",
              border: "1px solid var(--l2)",
              borderRadius: 3,
              background: "var(--card)",
              color: "var(--fg)",
              outline: "none",
              maxWidth: 160,
            }}
          >
            {netList.map(entry => (
              <option key={entry.id ?? "_all"} value={entry.id == null ? "" : String(entry.id)}>
                {entry.name}
              </option>
            ))}
          </select>
          {selectedNet != null && (
            <button
              type="button"
              className="btn sm"
              onClick={() => setSelectedNet(null)}
              style={{ fontSize: 9, padding: "1px 6px" }}
              title="Clear filter"
            >
              ✕
            </button>
          )}
        </label>
      </div>

      {/* ── Canvas ────────────────────────────────────────────── */}
      <div
        ref={containerRef}
        style={{ flex: "1 1 auto", minHeight: 0, background: "var(--card)", position: "relative" }}
      />
    </div>
  );
}
