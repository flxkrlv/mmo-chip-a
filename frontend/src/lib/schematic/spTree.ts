/**
 * Series-parallel decomposition of a CMOS pull-up or pull-down network.
 *
 * Given the set of transistors between a "top" net (VCC for PUN, OUTPUT for
 * PDN) and a "bottom" net (OUTPUT or GND), produce the hierarchical SP-tree
 * that the schematic layout walks: a leaf is one transistor; a series node
 * stacks its children top-to-bottom; a parallel node lays them side-by-side
 * sharing the same top and bottom rails.
 *
 * Standard CMOS library cells (INV, NAND, NOR, AOI, OAI, AND, OR, …) are all
 * series-parallel by construction. Non-SP networks (XOR built from pass
 * transistors, bridge-style topologies) return `null` so the caller can
 * fall back to a free-form rendering or just warn the user.
 *
 * The algorithm is two checks, recursive:
 *   1. **Parallel**: build a sub-graph from edges that share an interior
 *      net (i.e. a net that's neither `top` nor `bottom`). If that sub-
 *      graph has more than one connected component, each component is a
 *      parallel branch and we recurse with the same (top, bottom) into
 *      each. Edges that touch only `top` and `bottom` (direct) each form
 *      their own branch (single-transistor parallel arm).
 *   2. **Series**: try each interior net as a candidate cut vertex. If
 *      removing it splits the graph so `top` is in one connected component
 *      and `bottom` is in another, the edges fall cleanly into an upper
 *      group (touching `top`) and a lower group (touching `bottom`), and
 *      we recurse with (top, mid) and (mid, bottom).
 *   3. **Non-SP**: neither check fires → return null.
 */

import { UnionFind } from "../extraction/common";

/** One transistor's contribution to the network — just its S/D net ids; the
 *  algorithm treats it as an undirected edge. The caller carries the gate
 *  net + transistor id alongside so layout can pull them back out. */
export interface SPEdge {
  id: string;
  a: number;
  b: number;
}

export type SPTree =
  | { kind: "leaf"; transistorId: string }
  /** Children stacked top-to-bottom in that order. */
  | { kind: "series"; parts: SPTree[] }
  /** Children laid out left-to-right; all share `top` and `bottom`. */
  | { kind: "parallel"; branches: SPTree[] };

/**
 * Recursive decomposer. Returns null when the network can't be expressed as
 * a series-parallel composition — that's the signal to use a fallback
 * renderer.
 */
export function decompose(
  top: number,
  bottom: number,
  edges: SPEdge[],
): SPTree | null {
  if (edges.length === 0) return null;
  if (edges.length === 1) {
    const e = edges[0];
    // A single-edge sub-problem is valid only when the edge's endpoints
    // are exactly {top, bottom}. Anything else means the recursion fed
    // us a dangling edge and the overall network isn't SP.
    if ((e.a === top && e.b === bottom) || (e.a === bottom && e.b === top)) {
      return { kind: "leaf", transistorId: e.id };
    }
    return null;
  }

  // 1. Parallel: split into components that share no interior net.
  const parallelGroups = parallelSplit(top, bottom, edges);
  if (parallelGroups && parallelGroups.length > 1) {
    const branches: SPTree[] = [];
    for (const group of parallelGroups) {
      const sub = decompose(top, bottom, group);
      if (!sub) return null;
      // Flatten nested parallels — a parallel-of-parallels is the same as
      // one wider parallel and reads cleaner in the layout.
      if (sub.kind === "parallel") branches.push(...sub.branches);
      else branches.push(sub);
    }
    return { kind: "parallel", branches };
  }

  // 2. Series: try each interior net as a cut vertex. Iterate in a stable
  //    order so identical inputs produce identical trees across runs.
  const interior = new Set<number>();
  for (const e of edges) {
    if (e.a !== top && e.a !== bottom) interior.add(e.a);
    if (e.b !== top && e.b !== bottom) interior.add(e.b);
  }
  const sorted = Array.from(interior).sort((a, b) => a - b);
  for (const mid of sorted) {
    const split = trySeriesAt(top, bottom, mid, edges);
    if (!split) continue;
    const upper = decompose(top, mid, split.upper);
    const lower = decompose(mid, bottom, split.lower);
    if (!upper || !lower) continue;
    // Flatten nested series at this level — keeps the tree shallow.
    const parts: SPTree[] = [];
    if (upper.kind === "series") parts.push(...upper.parts);
    else parts.push(upper);
    if (lower.kind === "series") parts.push(...lower.parts);
    else parts.push(lower);
    return { kind: "series", parts };
  }

  return null;
}

// ── Parallel split ────────────────────────────────────────────────

/**
 * Group edges into connected components based on shared INTERIOR nets.
 * Edges touching only `top` and `bottom` (i.e. direct one-transistor paths
 * across the entire sub-network) don't share an interior with anyone, so
 * each lands in its own one-edge group — that's exactly the "parallel
 * branch with a single transistor" case.
 */
function parallelSplit(
  top: number,
  bottom: number,
  edges: SPEdge[],
): SPEdge[][] | null {
  const n = edges.length;
  const uf = new UnionFind(n);
  const byInteriorNet = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const e = edges[i];
    for (const net of [e.a, e.b]) {
      if (net === top || net === bottom) continue;
      let arr = byInteriorNet.get(net);
      if (!arr) {
        arr = [];
        byInteriorNet.set(net, arr);
      }
      arr.push(i);
    }
  }
  for (const arr of byInteriorNet.values()) {
    for (let i = 1; i < arr.length; i++) uf.union(arr[0], arr[i]);
  }
  const components = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = uf.find(i);
    let arr = components.get(r);
    if (!arr) {
      arr = [];
      components.set(r, arr);
    }
    arr.push(i);
  }
  if (components.size <= 1) return null;
  return Array.from(components.values()).map((indices) => indices.map((i) => edges[i]));
}

// ── Series split (cut-vertex test) ────────────────────────────────

interface SeriesSplit {
  upper: SPEdge[];
  lower: SPEdge[];
}

/**
 * Test whether `mid` is a cut vertex that cleanly separates `top` from
 * `bottom`. If yes, return the (upper, lower) edge partition. Otherwise
 * null. "Cleanly" means every non-mid-touching edge lives entirely in
 * `top`'s connected component or `bottom`'s, never bridging them and
 * never floating off in a third component (the latter would imply a
 * non-SP topology even after the cut).
 */
function trySeriesAt(
  top: number,
  bottom: number,
  mid: number,
  edges: SPEdge[],
): SeriesSplit | null {
  // Index every distinct net (other than mid) so we can union-find
  // adjacency without mid in the picture.
  const nets = new Set<number>([top, bottom]);
  for (const e of edges) {
    if (e.a !== mid) nets.add(e.a);
    if (e.b !== mid) nets.add(e.b);
  }
  const netIdx = new Map<number, number>();
  let idx = 0;
  for (const n of nets) netIdx.set(n, idx++);
  const uf = new UnionFind(netIdx.size);
  for (const e of edges) {
    if (e.a === mid || e.b === mid) continue;
    uf.union(netIdx.get(e.a)!, netIdx.get(e.b)!);
  }
  const sRoot = uf.find(netIdx.get(top)!);
  const tRoot = uf.find(netIdx.get(bottom)!);
  // Mid isn't a cut vertex if top and bottom are still connected without it.
  if (sRoot === tRoot) return null;

  const upper: SPEdge[] = [];
  const lower: SPEdge[] = [];
  for (const e of edges) {
    // For an edge touching mid: classify by the OTHER endpoint's component.
    // For a non-mid edge: both endpoints share a component (since they're
    // unioned), so either endpoint's root is fine.
    const aRoot = e.a === mid ? null : uf.find(netIdx.get(e.a)!);
    const bRoot = e.b === mid ? null : uf.find(netIdx.get(e.b)!);
    const inSide = aRoot === sRoot || bRoot === sRoot;
    const inTSide = aRoot === tRoot || bRoot === tRoot;
    if (inSide && !inTSide) upper.push(e);
    else if (inTSide && !inSide) lower.push(e);
    else return null; // edge floats in a third component or spans both — not a clean cut
  }
  if (upper.length === 0 || lower.length === 0) return null;
  return { upper, lower };
}
