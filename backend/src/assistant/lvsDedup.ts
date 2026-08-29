/**
 * lvsDedup.ts — Collapse reference-library cells that are LVS-topologically
 * identical so vyges-lvs only runs once per unique topology+connectivity.
 *
 * A reference group (e.g. 3,506 bandgap cells) contains many cells that differ
 * only in device parameters (W/L/m) but share the exact same device types and
 * net connectivity. For the purpose of "does my selection match this reference
 * topology", those are equivalent — running vyges-lvs on every one is wasteful.
 *
 * We compute a canonical key: parse the normalized CDL, build the device graph
 * (ordered terminals per device), and produce an isomorphism-invariant string
 * (try every net as a BFS root, keep the lexicographically smallest labeling,
 * order disconnected components by their canonical form). Parametric values are
 * dropped so size variants of the same topology collapse together. The key is
 * conservative: two cells only share a key when their topology+connectivity is
 * genuinely identical, so collapsing is safe.
 */

import type { LvsLibraryCell } from "./lvsLibrary.js";

interface ParsedDevice {
  /** Device class (nmos, pmos, npn, pnp, resistor, capacitor, inductor, diode, …). */
  type: string;
  /** Terminal net names in pin order (D,G,S,B for MOS; C,B,E for BJT; +,- for passives). */
  terminals: string[];
}

// ── Parse normalized CDL into typed devices ──────────────────────────────

function classify(prefix: string, model: string | undefined): string {
  const m = (model ?? "").toLowerCase();
  switch (prefix) {
    case "M":
      if (m.includes("pmos")) return "pmos";
      if (m.includes("nmos")) return "nmos";
      return "mos";
    case "Q":
      if (m.includes("pnp")) return "pnp";
      if (m.includes("npn")) return "npn";
      return "bjt";
    case "R":
      return "resistor";
    case "C":
      return "capacitor";
    case "L":
      return "inductor";
    case "D":
      if (m.includes("schottky")) return "schottky";
      if (m.includes("zener")) return "zener";
      return "diode";
    default:
      return prefix || "x";
  }
}

export function parseCdlDevices(cdl: string): ParsedDevice[] {
  const devices: ParsedDevice[] = [];
  for (const raw of cdl.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("*") || line.startsWith("//")) continue;
    if (line.startsWith(".")) continue; // .SUBCKT / .ENDS / .GLOBAL
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s+(.*)$/);
    if (!m) continue;
    const name = m[1];
    const prefix = name[0].toUpperCase();
    const tokens = m[2].trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;

    let terminals: string[];
    let model: string | undefined;
    if (prefix === "M") {
      // D G S B model params…
      terminals = tokens.slice(0, 4);
      model = tokens[4]?.replace(/^.*=/, ""); // strip any key= prefix
    } else if (prefix === "Q") {
      // C B E model params… (substrate already dropped by normalizer)
      terminals = tokens.slice(0, 3);
      model = tokens[3]?.replace(/^.*=/, "");
    } else if (prefix === "R" || prefix === "C" || prefix === "L" || prefix === "D") {
      // + - value/model params…
      terminals = tokens.slice(0, 2);
      model = tokens[2]?.replace(/^.*=/, "");
    } else {
      terminals = tokens.slice(0, 2);
    }
    if (terminals.length === 0) continue;
    devices.push({ type: classify(prefix, model), terminals });
  }
  return devices;
}

// ── Canonical (isomorphism-invariant) key ───────────────────────────────

interface CdlGraph {
  devices: ParsedDevice[];
  /** net name → incident device indices */
  netDevices: Map<string, number[]>;
  nets: string[];
}

function buildGraph(cdl: string): CdlGraph {
  const devices = parseCdlDevices(cdl);
  const netDevices = new Map<string, number[]>();
  devices.forEach((d, i) => {
    for (const net of d.terminals) {
      if (!netDevices.has(net)) netDevices.set(net, []);
      netDevices.get(net)!.push(i);
    }
  });
  return { devices, netDevices, nets: [...netDevices.keys()] };
}

function canonicalFormFromRoot(g: CdlGraph, root: string): string {
  const label = new Map<string, number>();
  label.set(root, 1);
  let next = 2;
  const queue: string[] = [root];
  while (queue.length > 0) {
    const net = queue.shift()!;
    for (const devIdx of g.netDevices.get(net) ?? []) {
      const dev = g.devices[devIdx];
      for (const t of dev.terminals) {
        if (!label.has(t)) {
          label.set(t, next++);
          queue.push(t);
        }
      }
    }
  }
  const devStrs = g.devices.map((d) => {
    const labs = d.terminals.map((t) => label.get(t) ?? 0);
    return `${d.type}:${labs.join("-")}`;
  });
  devStrs.sort();
  return devStrs.join(";");
}

function componentCanonical(g: CdlGraph, seed: string): string {
  // Try every net in the connected component as a BFS root; keep the smallest
  // canonical form. BFS expansion order is deterministic (device input order,
  // then terminal order), so the minimum over roots is isomorphism-invariant.
  let best = "";
  const visited = new Set<string>();
  const stack = [seed];
  // collect component nets via flood fill (any order)
  const comp: string[] = [];
  while (stack.length) {
    const n = stack.pop()!;
    if (visited.has(n)) continue;
    visited.add(n);
    comp.push(n);
    for (const di of g.netDevices.get(n) ?? []) {
      for (const t of g.devices[di].terminals) if (!visited.has(t)) stack.push(t);
    }
  }
  for (const root of comp) {
    const form = canonicalFormFromRoot(g, root);
    if (best === "" || form < best) best = form;
  }
  return best;
}

export function canonicalLvsKey(cdl: string): string {
  const g = buildGraph(cdl);
  if (g.nets.length === 0) return "";
  const seen = new Set<string>();
  const compForms: string[] = [];
  for (const net of g.nets) {
    if (seen.has(net)) continue;
    const form = componentCanonical(g, net);
    // mark whole component seen
    const stack = [net];
    while (stack.length) {
      const n = stack.pop()!;
      if (seen.has(n)) continue;
      seen.add(n);
      for (const di of g.netDevices.get(n) ?? []) {
        for (const t of g.devices[di].terminals) if (!seen.has(t)) stack.push(t);
      }
    }
    compForms.push(form);
  }
  compForms.sort();
  return compForms.join("||");
}

// ── Dedup a list of library cells ───────────────────────────────────────

export interface DedupResult {
  /** One representative cell per unique topology+connectivity. */
  representatives: LvsLibraryCell[];
  /** canonical key → number of cells that collapsed into it. */
  memberCounts: Map<string, number>;
  /** Original cell count before dedup. */
  originalCount: number;
}

export function dedupeCells(cells: LvsLibraryCell[]): DedupResult {
  const byKey = new Map<string, LvsLibraryCell>();
  const memberCounts = new Map<string, number>();
  for (const cell of cells) {
    const key = canonicalLvsKey(cell.cdl);
    if (!byKey.has(key)) byKey.set(key, cell);
    memberCounts.set(key, (memberCounts.get(key) ?? 0) + 1);
  }
  return {
    representatives: [...byKey.values()],
    memberCounts,
    originalCount: cells.length,
  };
}
