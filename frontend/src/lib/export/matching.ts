/**
 * matching.ts — Device geometry matching / averaging.
 *
 * Optional post-processing step after collectDieWideAnalogDevices:
 * clusters devices with similar geometry (W/L/AE/PE) within a tolerance
 * and averages their parameters. This mimics intentional matching in
 * analog design (diff pairs, current mirrors) where nominally identical
 * devices should produce identical SPICE parameters despite pixel-level
 * extraction noise.
 *
 * Tolerance is configured in SpiceConfig.matchTolerancePercent.
 * 0 = disabled (default).
 */

import type { AnalogDevice, DeviceGeometry, DeviceGeometryMOS, DeviceGeometryBJT, DeviceGeometryResistor, DeviceGeometryDiode, SpiceConfig } from "shared";

// ── Helpers ──────────────────────────────────────────────────────

/** Relative diff in percent. */
function relDiff(a: number, b: number): number {
  const mx = Math.max(Math.abs(a), Math.abs(b));
  if (mx === 0) return 0;
  return Math.abs(a - b) / mx * 100;
}

/** Round to a reasonable precision (3 significant digits for microns). */
function r3(v: number): number {
  if (v === 0) return 0;
  const p = Math.pow(10, 2 - Math.floor(Math.log10(Math.abs(v))));
  return Math.round(v * p) / p;
}

// ── Per-kind feature vectors ─────────────────────────────────────

interface MatchKey {
  kind: string;
  /** Extra discriminant: mosType, bjtType, resistorType, etc. */
  subType: string;
}

interface GeometryFeatures {
  /** Primary continuous parameters used for similarity check. */
  values: number[];
  /** Set geometry to this new mean. Returns derived fields. */
  setMean(mean: number[]): void;
}

function featuresOf(d: AnalogDevice): GeometryFeatures | null {
  const g = d.geometry;
  switch (d.kind) {
    case "mos": {
      const mg = g as DeviceGeometryMOS;
      return {
        values: [mg.L_um, mg.W_um, mg.multiplier],
        setMean([L, W, m]) {
          mg.L_um = r3(L);
          mg.W_um = r3(W);
          mg.multiplier = r3(m);
          mg.totalW_um = r3(mg.W_um * (mg.fingers ?? 1) * mg.multiplier);
        },
      };
    }
    case "bjt_npn":
    case "bjt_pnp": {
      const bg = g as DeviceGeometryBJT;
      return {
        values: [bg.AE_um2, bg.PE_um, bg.multiplier],
        setMean([AE, PE, m]) {
          bg.AE_um2 = r3(AE);
          bg.PE_um = r3(PE);
          bg.multiplier = r3(m);
          bg.totalAE_um2 = r3(bg.AE_um2 * bg.multiplier);
        },
      };
    }
    case "resistor": {
      const rg = g as DeviceGeometryResistor;
      return {
        values: [rg.L_um, rg.W_um, rg.multiplier],
        setMean([L, W, m]) {
          rg.L_um = r3(L);
          rg.W_um = r3(W);
          rg.multiplier = r3(m);
          rg.squares = W > 0 ? r3(L / W) : 0;
          if (rg.resistance_ohms != null) {
            const oldSq = W > 0 ? (rg.squares > 0 ? rg.resistance_ohms / rg.squares : 0) : 0;
            rg.resistance_ohms = rg.squares > 0 ? Math.round(rg.squares * oldSq) : 0;
          }
        },
      };
    }
    case "diode": {
      const dg = g as DeviceGeometryDiode;
      return {
        values: [dg.area_um2, dg.perimeter_um, dg.multiplier],
        setMean([area, perim, m]) {
          dg.area_um2 = r3(area);
          dg.perimeter_um = r3(perim);
          dg.multiplier = r3(m);
        },
      };
    }
    default:
      return null; // capacitors, JFETs, inductors — skip
  }
}

function subTypeOf(d: AnalogDevice): string {
  const g = d.geometry;
  switch (d.kind) {
    case "mos":
      return (g as DeviceGeometryMOS).mosType;
    case "bjt_npn":
    case "bjt_pnp":
      return (g as DeviceGeometryBJT).bjtType;
    case "resistor":
      return (g as DeviceGeometryResistor).resistorType ?? "poly";
    case "diode":
      return (g as DeviceGeometryDiode).diodeType ?? "pn";
    default:
      return "";
  }
}

// ── Union-Find ───────────────────────────────────────────────────

class UnionFind {
  parent: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(x: number): number {
    while (this.parent[x] !== x) {
      this.parent[x] = this.parent[this.parent[x]];
      x = this.parent[x];
    }
    return x;
  }
  union(a: number, b: number): void {
    const ra = this.find(a), rb = this.find(b);
    if (ra !== rb) this.parent[rb] = ra;
  }
}

// ── Public API ──────────────────────────────────────────────────

export interface MatchWarning {
  text: string;
  /** Device instance names involved. */
  devices: string[];
}

/**
 * Match and average geometry of similar devices.
 *
 * @param devices   — extracted analog devices (instanceName assigned)
 * @param config    — SPICE config (matchTolerancePercent)
 * @param netLookup — optional netId → net name map (for readable warnings)
 * @returns         — warnings (shared nets with mismatched geometry)
 */
export function matchGeometry(
  devices: (AnalogDevice & { instanceName: string })[],
  config: SpiceConfig,
  netLookup?: Map<number, string>,
): MatchWarning[] {
  const vddName = config.vdd ?? "VDD";
  const gndName = config.gnd ?? "GND";
  const tolerance = config.matchTolerancePercent ?? 0;
  if (tolerance <= 0) return [];

  const warnings: MatchWarning[] = [];

  // 1. Partition devices by kind + subType
  const buckets = new Map<string, number[]>();
  for (let i = 0; i < devices.length; i++) {
    const d = devices[i];
    const key = `${d.kind}::${subTypeOf(d)}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(i);
  }

  // 2. Within each bucket, run Union-Find on pairwise feature similarity
  for (const indices of buckets.values()) {
    const n = indices.length;
    if (n < 2) continue;

    // Precompute features to avoid calling featuresOf repeatedly
    const feats = indices.map((i) => featuresOf(devices[i]));
    // Filter out devices we can't match
    const valid: { idx: number; feat: GeometryFeatures }[] = [];
    for (let i = 0; i < n; i++) {
      if (feats[i]) valid.push({ idx: indices[i], feat: feats[i]! });
    }
    if (valid.length < 2) continue;

    const uf = new UnionFind(valid.length);
    for (let i = 0; i < valid.length; i++) {
      for (let j = i + 1; j < valid.length; j++) {
        const va = valid[i].feat.values;
        const vb = valid[j].feat.values;
        if (va.length !== vb.length) continue;
        let similar = true;
        for (let k = 0; k < va.length; k++) {
          if (relDiff(va[k], vb[k]) > tolerance) { similar = false; break; }
        }
        if (similar) uf.union(i, j);
      }
    }

    // 3. Group by root
    const clusters = new Map<number, number[]>();
    for (let i = 0; i < valid.length; i++) {
      const root = uf.find(i);
      if (!clusters.has(root)) clusters.set(root, []);
      clusters.get(root)!.push(i);
    }

    // 4. Average each cluster (size >= 2)
    for (const members of clusters.values()) {
      if (members.length < 2) continue;

      const featRef = valid[members[0]].feat;
      const dim = featRef.values.length;
      const sum = new Array(dim).fill(0);
      for (const mi of members) {
        const fv = valid[mi].feat.values;
        for (let k = 0; k < dim; k++) sum[k] += fv[k];
      }
      const mean = sum.map((s) => s / members.length);

      // Apply averaged values
      for (const mi of members) {
        valid[mi].feat.setMean(mean);
      }

      // 5. Check for shared nets (matched devices that share a terminal net)
      const memberDevices = members.map((mi) => devices[valid[mi].idx]);
      const netMap = new Map<number, string[]>();
      for (const d of memberDevices) {
        for (const t of d.terminals) {
          if (t.netId < 0) continue;
          if (!netMap.has(t.netId)) netMap.set(t.netId, []);
          netMap.get(t.netId)!.push(d.instanceName);
        }
      }
      for (const [netId, names] of netMap) {
        if (names.length < 2) continue;
        // Skip global supply nets
        const netName = netLookup?.get(netId) ?? `net${netId}`;
        if (netName === vddName || netName === gndName || netName === "0") continue;
        warnings.push({
          text: `${names.join(", ")} share ${netName} — matched as similar`,
          devices: [...names],
        });
      }
    }
  }

  return warnings;
}
