/// <reference types="node" />

/**
 * lvsMatch.ts — verify a candidate subcircuit (Spectre) against a reference
 * library using vyges-lvs.
 *
 * Flow: normalize the candidate (same Spectre→CDL path as the library cells),
 * prefilter the library by a tolerant structural signature (so near-topologies
 * like "matched except one extra resistor" still get checked), then run
 * vyges-lvs on the top-K candidates and rank results (exact MATCH first, then
 * near-misses with their extra/missing device lists).
 */

import { runVygesLvs } from "../api/lvs.js";
import { normalizeForVyges } from "../lib/normalizeNetlist.js";
import { signatureDistance, signatureFromSpice } from "./subcircuitExtract.js";
import type { LvsLibrary, LvsLibraryCell } from "./lvsLibrary.js";
import type { LvsRawResult } from "shared";

export interface LvsMatchResult {
  cellId: string;
  topology?: string;
  matched: boolean;
  /** Structural distance (extra/missing devices) used for ranking. */
  distance: number;
  engine: "vyges-lvs";
  report: string;
  json?: LvsRawResult;
  /** Devices present in candidate but not in the reference cell (LVS unbalanced). */
  extraDevices?: string[];
  /** Devices present in the reference cell but not in the candidate. */
  missingDevices?: string[];
  /** Normalized reference netlist (CDL) of this cell — surfaced for display/SVG. */
  referenceNetlist?: string;
  /** Normalized candidate netlist (CDL) — same for every result in the summary. */
  candidateNetlist?: string;
}

export interface LvsCheckOptions {
  /** Max per-device-type count delta allowed when prefiltering candidates. */
  tolerance?: number;
  /** Max number of candidate cells sent to vyges-lvs. */
  budget?: number;
  /** Called as cells are actually compared with vyges-lvs (for progress UI). */
  onProgress?: (checked: number, total: number) => void;
}

export interface LvsMatchSummary {
  candidateSignature: Record<string, number>;
  checkedCount: number;
  matches: LvsMatchResult[];
  best: LvsMatchResult | null;
  /** Normalized candidate netlist (CDL). */
  candidateNetlist?: string;
  /** Number of checked reference cells per topology (after prefilter, before collapse). */
  topologyCounts?: Record<string, number>;
  /** False if vyges-lvs CLI was unavailable for any candidate. */
  engineAvailable: boolean;
}

function cellDevCount(cell: LvsLibraryCell): number {
  return Object.values(cell.signature).reduce((a, b) => a + b, 0);
}

function rankComparator(a: LvsMatchResult, b: LvsMatchResult): number {
  if (a.matched !== b.matched) return a.matched ? -1 : 1;
  if (a.distance !== b.distance) return a.distance - b.distance;
  const aExtra = (a.extraDevices?.length ?? 0) + (a.missingDevices?.length ?? 0);
  const bExtra = (b.extraDevices?.length ?? 0) + (b.missingDevices?.length ?? 0);
  return aExtra - bExtra;
}

export async function matchSubcircuit(
  candidateSpice: string,
  library: LvsLibrary,
  options: LvsCheckOptions = {},
): Promise<LvsMatchSummary> {
  const tolerance = options.tolerance ?? 3;
  const budget = options.budget ?? 50;

  const candNorm = normalizeForVyges(candidateSpice, "top");
  const candSig = signatureFromSpice(candNorm);

  const scored = library.cells
    .map((cell) => ({ cell, distance: signatureDistance(candSig, cell.signature) }))
    .filter((s) => s.distance <= tolerance)
    .sort((a, b) => a.distance - b.distance || Math.abs(cellDevCount(b.cell) - cellDevCount(a.cell)));

  const top = scored.slice(0, budget);
  const total = top.length;

  const results: LvsMatchResult[] = [];
  let engineAvailable = true;

  let checked = 0;
  for (const { cell, distance } of top) {
    try {
      const res = await runVygesLvs(candNorm, cell.cdl, "spectre", "top");
      const unbalanced = (res.json?.unbalanced ?? []).filter((u) => u.what === "device");
      const stripSide = (name: string) => name.replace(/^[AB]\//, "");
      const extraDevices = unbalanced
        .filter((u) => u.a_count > 0 && u.b_count === 0)
        .flatMap((u) => u.a)
        .map(stripSide);
      const missingDevices = unbalanced
        .filter((u) => u.a_count === 0 && u.b_count > 0)
        .flatMap((u) => u.b)
        .map(stripSide);
        results.push({
          cellId: cell.id,
          topology: cell.topology,
          matched: res.matched,
          distance,
          engine: "vyges-lvs",
          report: res.report,
          json: res.json,
          extraDevices,
          missingDevices,
          referenceNetlist: cell.cdl,
          candidateNetlist: candNorm,
        });
    } catch (err) {
      engineAvailable = false;
      results.push({
        cellId: cell.id,
        topology: cell.topology,
        matched: false,
        distance,
        engine: "vyges-lvs",
        report: `LVS engine error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    checked++;
    options.onProgress?.(checked, total);
  }

  results.sort(rankComparator);
  const best = results.find((r) => r.matched) ?? results[0] ?? null;

  // Collapse near-miss noise: keep every exact MATCH, but only the single best
  // representative per topology for non-matches. The library stores up to
  // maxPerSignature near-identical cells per device-count bucket, so without
  // this a 2-transistor candidate returns ~30 "analogtobi_*_s00x" near-misses
  // that only differ in internal wiring/sizing.
  const seenTopologies = new Set<string>();
  const collapsed: LvsMatchResult[] = [];
  for (const r of results) {
    if (r.matched) {
      collapsed.push(r);
      continue;
    }
    const key = r.topology ?? "unknown";
    if (seenTopologies.has(key)) continue;
    seenTopologies.add(key);
    collapsed.push(r);
  }

  const topologyCounts: Record<string, number> = {};
  for (const { cell } of top) {
    const t = cell.topology ?? "unknown";
    topologyCounts[t] = (topologyCounts[t] ?? 0) + 1;
  }

  return {
    candidateSignature: candSig,
    checkedCount: results.length,
    matches: collapsed,
    best,
    candidateNetlist: candNorm,
    topologyCounts,
    engineAvailable,
  };
}
