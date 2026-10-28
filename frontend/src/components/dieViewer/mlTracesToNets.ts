import type { AnnotationNet, AnnotationNetEdge, AnnotationNetNode, MLTracePolyline, WireLayer } from "shared";
import { uuid } from "../../lib/uuid";

/**
 * Materialize ML trace centrelines into real annotation nets.
 *
 * v2 skeleton decode emits one polyline per metal branch with meaningful
 * endpoint coordinates. This module:
 *   1. snaps each polyline end to the nearest device contact / cell
 *      terminal / IO pin (the wire tool's snap targets) — the snapped
 *      coordinate becomes the endpoint, so the wire actually connects;
 *   2. unions branches that share an endpoint (snapped to the same contact
 *      or decoded onto the same junction) into one electrical net;
 *   3. builds one AnnotationNet per group as a node-edge graph (vertices in
 *      polyline order, edges between consecutive vertices), edge layer
 *      stamped so SPICE/RE metadata sees the conductor.
 *
 * Pure functions — the caller dispatches the resulting `upsertNet` batch
 * through the annotation dispatcher (undoable, persisted).
 */

/** A wire-tool-style snap candidate (device contact / terminal / IO pin). */
export interface TraceSnapTarget {
  x: number;
  y: number;
  label: string;
}

export interface TracesToNetsInput {
  /** Deduplicated trace polylines (layer.collectTraces()). */
  traces: MLTracePolyline[];
  /** Drop traces scoring below this (the trace-confidence slider value). */
  minScore: number;
  snapTargets: TraceSnapTarget[];
  /** Snap tolerance in world (source-px) units. */
  snapTol: number;
  /** Conductor layer stamped on every created edge. */
  layer: WireLayer;
  /** Net naming: `<prefix>1`, `<prefix>2`, … */
  namePrefix?: string;
}

export interface TracesToNetsResult {
  nets: AnnotationNet[];
  /** How many polyline ends actually landed on a snap target. */
  snappedEnds: number;
  /** Traces dropped for having fewer than 2 vertices. */
  droppedDegenerate: number;
}

/** Endpoint merge key: snapped ends land on identical coordinates; decoded
 *  junction ends agree within ~2 px, so quantize to a 2 px grid. */
function endpointKey(x: number, y: number): string {
  return `${Math.round(x / 2)}:${Math.round(y / 2)}`;
}

export function buildNetsFromTraces(input: TracesToNetsInput): TracesToNetsResult {
  const { traces, minScore, snapTargets, snapTol, layer, namePrefix = "ML-" } = input;

  // 1. Snap every polyline end to the nearest target (first hit wins by
  //    distance, matching the wire tool's nearest-candidate behaviour).
  let snappedEnds = 0;
  let droppedDegenerate = 0;
  const snapped: { points: [number, number][]; score: number }[] = [];
  for (const t of traces) {
    if ((t.score ?? 1) < minScore || t.points.length < 2) {
      droppedDegenerate += 1;
      continue;
    }
    const pts = t.points.map((p) => [p[0], p[1]] as [number, number]);
    for (const end of [0, pts.length - 1] as const) {
      let best: TraceSnapTarget | null = null;
      let bestD = snapTol;
      for (const s of snapTargets) {
        const d = Math.hypot(s.x - pts[end][0], s.y - pts[end][1]);
        if (d <= bestD) {
          bestD = d;
          best = s;
        }
      }
      if (best) {
        pts[end] = [best.x, best.y];
        snappedEnds += 1;
      }
    }
    snapped.push({ points: pts, score: t.score ?? 1 });
  }

  // 2. Union branches whose endpoints coincide (same contact / junction).
  const parent = new Map<string, string>();
  const find = (k: string): string => {
    let root = k;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let cur = k;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  };
  const groupOf: string[] = [];
  const endsByKey = new Map<string, number[]>();
  snapped.forEach((t, i) => {
    const k = `t${i}`;
    parent.set(k, k);
    groupOf.push(k);
    for (const end of [t.points[0], t.points[t.points.length - 1]]) {
      const ek = endpointKey(end[0], end[1]);
      const list = endsByKey.get(ek);
      if (list) {
        for (const other of list) union(k, `t${other}`);
        list.push(i);
      } else {
        endsByKey.set(ek, [i]);
      }
    }
  });

  // 3. One net per group: collect vertices (endpoint-key merged so shared
  //    ends become a single node — that is the electrical connection).
  const groups = new Map<string, number[]>();
  snapped.forEach((_, i) => {
    const root = find(`t${i}`);
    const list = groups.get(root);
    if (list) list.push(i);
    else groups.set(root, [i]);
  });

  const nets: AnnotationNet[] = [];
  let n = 0;
  for (const members of groups.values()) {
    n += 1;
    const nodes: AnnotationNetNode[] = [];
    const nodeByKey = new Map<string, AnnotationNetNode>();
    const edges: AnnotationNetEdge[] = [];
    const nodeAt = (x: number, y: number): AnnotationNetNode => {
      const key = endpointKey(x, y);
      const existing = nodeByKey.get(key);
      if (existing) return existing;
      const node: AnnotationNetNode = { id: uuid(), x, y };
      nodeByKey.set(key, node);
      nodes.push(node);
      return node;
    };
    for (const i of members) {
      const pts = snapped[i].points;
      for (let j = 0; j < pts.length - 1; j++) {
        const a = nodeAt(pts[j][0], pts[j][1]);
        const b = nodeAt(pts[j + 1][0], pts[j + 1][1]);
        if (a.id === b.id) continue;
        edges.push({ id: uuid(), from: a.id, to: b.id, layer });
      }
    }
    nets.push({
      id: uuid(),
      name: `${namePrefix}${n}`,
      nodes,
      edges
    });
  }

  return { nets, snappedEnds, droppedDegenerate };
}
