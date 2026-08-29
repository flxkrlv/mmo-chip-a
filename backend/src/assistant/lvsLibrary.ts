/// <reference types="node" />

/**
 * lvsLibrary.ts — reference netlist libraries for LLM LVS verification.
 *
 * A library is a directory `data/reference-library/<libId>/` containing:
 *   - `cells/<id>.spice`  — original SPICE (Spectre) of each reference cell
 *   - `index.json`        — metadata + normalized CDL per cell
 *
 * Each cell is stored pre-normalized (`cdl` = output of `normalizeForVyges`)
 * so query-time matching never re-normalizes 130K files. Cells are deduplicated
 * by structural signature at import time (keeping a bounded number of
 * representatives per signature) — this bounds vyges-lvs runs while still
 * letting the model test multiple near-topology variants.
 */

import { promises as fsp } from "node:fs";
import path from "node:path";
import { normalizeForVyges } from "../lib/normalizeNetlist.js";
import { signatureFromSpice } from "./subcircuitExtract.js";

export interface LvsLibraryCell {
  id: string;
  topology?: string;
  metrics?: unknown;
  /** Device-letter multiset, used for tolerant prefiltering. */
  signature: Record<string, number>;
  /** Normalized CDL netlist (output of normalizeForVyges) — fed straight to vyges-lvs. */
  cdl: string;
  /** Original SPICE (Spectre) — kept for reference/browsing. */
  spice?: string;
  source?: string;
}

export interface LvsLibrary {
  libId: string;
  cells: LvsLibraryCell[];
}

export const DEFAULT_LIBRARY_ID = "analog-circuits-sky130";

const POWER_NET_NAMES = new Set([
  "GND", "VCC", "VDD", "VSS", "VEE", "VBB", "VSUB", "AVDD", "AVSS", "DVDD", "DVSS", "0",
]);

function sanitizeNetName(raw: string): string {
  if (!raw) return "n0";
  const cleaned = raw.replace(/[^A-Za-z0-9_]/g, "_");
  return /^[A-Za-z_]/.test(cleaned) ? cleaned : `n${cleaned}`;
}

// ── Dataset netlist_json → Spectre SPICE ───────────────────────

interface NlNet {
  name: string;
  role?: string;
  external?: boolean;
}
interface NlPin {
  role: string;
  net: string;
}
interface NlDev {
  name: string;
  type: string;
  model?: string;
  pins: NlPin[];
  params?: Record<string, unknown>;
}
interface NlJson {
  nets: NlNet[];
  devices: NlDev[];
}

const TYPE_INFO: Record<string, { token: string; ordered: boolean }> = {
  nmos: { token: "nmos", ordered: true },
  pmos: { token: "pmos", ordered: true },
  npn: { token: "npn", ordered: true },
  pnp: { token: "pnp", ordered: true },
  res: { token: "resistor", ordered: false },
  cap: { token: "capacitor", ordered: false },
  ind: { token: "inductor", ordered: false },
  isrc: { token: "isrc", ordered: false },
  vsrc: { token: "vsrc", ordered: false },
  other: { token: "other", ordered: false },
};

const ROLE_PRIORITY = ["D", "G", "S", "B", "C", "E", "P", "N", "SUB"];

function orderPins(pins: NlPin[]): NlPin[] {
  return [...pins].sort((a, b) => ROLE_PRIORITY.indexOf(a.role) - ROLE_PRIORITY.indexOf(b.role));
}

/**
 * Convert a dataset `netlist_json` primitive (the canonical graph form shipped by
 * pphilip/analog-circuits-sky130) into a Spectre SPICE netlist using the SAME
 * device-token conventions as `emitSubcircuitSpice`, so both sides normalize
 * identically before vyges-lvs comparison.
 */
export function netlistJsonToSpice(json: string): string {
  const data = JSON.parse(json) as NlJson;
  const netByName = new Map(data.nets.map((n) => [n.name, n]));
  const globals = new Set<string>();

  const lines: string[] = [];
  for (const dev of data.devices) {
    const info = TYPE_INFO[dev.type] ?? TYPE_INFO.other;
    const ordered = orderPins(dev.pins);
    const netTerms = ordered.map((p) => sanitizeNetName(p.net)).join(" ");
    const name = dev.name.replace(/[^A-Za-z0-9_]/g, "_");

    let line: string;
    if (info.ordered) {
      line = `${name} (${netTerms}) ${info.token} m=1`;
    } else if (dev.type === "res") {
      line = `${name} (${netTerms}) resistor r=1k`;
    } else if (dev.type === "cap") {
      line = `${name} (${netTerms}) capacitor c=1p`;
    } else if (dev.type === "ind") {
      line = `${name} (${netTerms}) inductor l=1n`;
    } else {
      line = `${name} (${netTerms}) ${info.token}`;
    }
    lines.push(line);
  }

  for (const net of data.nets) {
    const nm = sanitizeNetName(net.name);
    if (POWER_NET_NAMES.has(nm) || net.role === "supply_pos" || net.role === "supply_neg") {
      globals.add(nm);
    }
  }

  const header = globals.size > 0 ? `.GLOBAL ${[...globals].join(" ")}\n` : "";
  return header + lines.join("\n");
}

// ── Index build / import ───────────────────────────────────────

export interface LibraryRow {
  circuit_id: string;
  topology?: string;
  netlist_json: string;
  metrics?: unknown;
}

export interface ImportOptions {
  /** Max number of representative cells kept per unique signature cluster. */
  maxPerSignature?: number;
  /** Keep only this many rows total (useful for a quick curated subset). */
  limit?: number;
}

/**
 * Build (in memory) a library from dataset rows. Deduplicates by structural
 * signature, keeping up to `maxPerSignature` representatives per cluster so a
 * query still tests several near-topology variants without exploding.
 */
export function buildLibraryFromRows(libId: string, rows: LibraryRow[], opts: ImportOptions = {}): LvsLibrary {
  const maxPerSignature = opts.maxPerSignature ?? 50;
  const bySig = new Map<string, LvsLibraryCell[]>();

  const take = opts.limit != null ? rows.slice(0, opts.limit) : rows;
  for (const row of take) {
    const spice = netlistJsonToSpice(row.netlist_json);
    const cdl = normalizeForVyges(spice, "top");
    const signature = signatureFromSpice(cdl);
    const sigKey = JSON.stringify(signature);
    const cell: LvsLibraryCell = {
      id: row.circuit_id,
      topology: row.topology,
      metrics: row.metrics,
      signature,
      cdl,
      spice,
      source: "analog-circuits-sky130",
    };
    const bucket = bySig.get(sigKey) ?? [];
    if (bucket.length < maxPerSignature) {
      bucket.push(cell);
      bySig.set(sigKey, bucket);
    }
  }

  const cells = [...bySig.values()].flat();
  return { libId, cells };
}

/** Count cells by topology group (used for cheap library metadata). */
export function computeGroups(cells: LvsLibraryCell[]): Array<{ topology: string; count: number }> {
  const counts = new Map<string, number>();
  for (const cell of cells) {
    const t = cell.topology || "unknown";
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([topology, count]) => ({ topology, count }))
    .sort((a, b) => b.count - a.count);
}

/** Persist a library to `data/reference-library/<libId>/` (index.json + cells). */
export async function writeLibrary(dataRoot: string, library: LvsLibrary): Promise<void> {
  const dir = path.join(dataRoot, "reference-library", library.libId);
  await fsp.mkdir(path.join(dir, "cells"), { recursive: true });

  for (const cell of library.cells) {
    if (cell.spice) {
      await fsp.writeFile(path.join(dir, "cells", `${cell.id}.spice`), cell.spice, "utf-8");
    }
  }
  // Strip the bulky `spice` field from the index (kept on disk per-cell instead).
  const index = {
    libId: library.libId,
    cells: library.cells.map((c) => ({
      id: c.id,
      topology: c.topology,
      metrics: c.metrics,
      signature: c.signature,
      cdl: c.cdl,
      source: c.source,
    })),
  };
  await fsp.writeFile(path.join(dir, "index.json"), `${JSON.stringify(index, null, 2)}\n`, "utf-8");

  // Lightweight metadata for the UI (group list + counts) — avoids loading the
  // full 40K-cell index just to show the library picker.
  const meta = { libId: library.libId, cellCount: library.cells.length, groups: computeGroups(library.cells) };
  await fsp.writeFile(path.join(dir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`, "utf-8");
}

/** Load a persisted library (or build an in-memory one from cells). */
export async function loadLibrary(dataRoot: string, libId: string): Promise<LvsLibrary | null> {
  const indexPath = path.join(dataRoot, "reference-library", libId, "index.json");
  try {
    const raw = await fsp.readFile(indexPath, "utf-8");
    const index = JSON.parse(raw) as { libId: string; cells: LvsLibraryCell[] };
    return { libId: index.libId, cells: index.cells };
  } catch {
    return null;
  }
}

/** Cheap per-library metadata (group counts), written at import time. */
export async function readLibraryMeta(dataRoot: string, libId: string): Promise<{ libId: string; cellCount: number; groups: Array<{ topology: string; count: number }> } | null> {
  const metaPath = path.join(dataRoot, "reference-library", libId, "meta.json");
  try {
    const raw = await fsp.readFile(metaPath, "utf-8");
    const parsed = JSON.parse(raw) as { libId: string; cellCount: number; groups?: Array<{ topology: string; count: number }> };
    return { libId: parsed.libId, cellCount: parsed.cellCount, groups: parsed.groups ?? [] };
  } catch {
    return null;
  }
}

/** List available libraries under `data/reference-library/` with cell + group counts. */
export async function listLibraries(
  dataRoot: string,
): Promise<Array<{ libId: string; cellCount: number; groups: Array<{ topology: string; count: number }> }>> {
  const root = path.join(dataRoot, "reference-library");
  try {
    const entries = await fsp.readdir(root, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    const summaries = await Promise.all(
      dirs.map(async (libId) => {
        const meta = await readLibraryMeta(dataRoot, libId);
        if (meta) return meta;
        const lib = await loadLibrary(dataRoot, libId);
        return { libId, cellCount: lib?.cells.length ?? 0, groups: lib ? computeGroups(lib.cells) : [] };
      }),
    );
    return summaries;
  } catch {
    return [];
  }
}

/** Add a single user-supplied SPICE file as a cell in the given library. */
export async function addSpiceCell(
  dataRoot: string,
  libId: string,
  cellId: string,
  spice: string,
): Promise<LvsLibrary> {
  const dir = path.join(dataRoot, "reference-library", libId);
  await fsp.mkdir(path.join(dir, "cells"), { recursive: true });
  await fsp.writeFile(path.join(dir, "cells", `${cellId}.spice`), spice, "utf-8");

  const existing = (await loadLibrary(dataRoot, libId)) ?? { libId, cells: [] };
  const cdl = normalizeForVyges(spice, "top");
  const cell: LvsLibraryCell = { id: cellId, signature: signatureFromSpice(cdl), cdl, spice, source: "user" };
  const others = existing.cells.filter((c) => c.id !== cellId);
  const library: LvsLibrary = { libId, cells: [...others, cell] };
  await writeLibrary(dataRoot, library);
  return library;
}
