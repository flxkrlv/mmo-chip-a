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
  /** Gap-bridging tolerance: decode fragments whose ends nearly touch are
   *  stitched into one connected wire (both ends pulled to the shared
   *  point). In world (source-px) units. */
  stitchTol: number;
  /** Conductor layer stamped on every created edge. */
  layer: WireLayer;
  /** Net naming: `<prefix>1`, `<prefix>2`, … */
  namePrefix?: string;
  /** A net must touch at least this many DISTINCT device contacts (pins /
   *  electrodes / terminals) to be materialized. 0 = off. 2 filters
   *  floating artifacts: only wires joining two real contacts survive. */
  minDeviceContacts?: number;
  /** Drop octilinear-decoder traces kept raw with `irregular: true`
   *  (the raw axis could not be snapped within delta) instead of
   *  materializing their non-octilinear geometry. */
  dropIrregular?: boolean;
}

export interface TracesToNetsResult {
  nets: AnnotationNet[];
  /** How many polyline ends actually landed on a snap target. */
  snappedEnds: number;
  /** Traces dropped for having fewer than 2 vertices. */
  droppedDegenerate: number;
  /** Traces dropped by the score filter (`minScore`) — distinct from
   *  degenerate drops so the UI can say WHY nothing was materialized. */
  filteredByScore: number;
  /** How many fragment pairs were stitched into shared points. */
  stitchedPairs: number;
  /** Nets dropped by the min-device-contacts filter. */
  droppedLowContacts: number;
  /** Traces dropped by the drop-irregular filter. */
  droppedIrregular: number;
  /** Suspicious merges: a "group" union holding hundreds of traces usually
   *  means the MASK over-bridged wires (band too wide / Min gap too high) —
   *  the netlist is technically connected but is not what the user drew. */
  warnings: string[];
}

/** Endpoint merge key: snapped ends land on identical coordinates; decoded
 *  junction ends agree within ~2 px, so quantize to a 2 px grid. */
function endpointKey(x: number, y: number): string {
  return `${Math.round(x / 2)}:${Math.round(y / 2)}`;
}

export function buildNetsFromTraces(input: TracesToNetsInput): TracesToNetsResult {
  const {
    traces,
    minScore,
    snapTargets,
    snapTol,
    stitchTol,
    layer,
    namePrefix = "ML-",
    minDeviceContacts = 0,
    dropIrregular = false
  } = input;

  // 1. Snap every polyline end to the nearest target (first hit wins by
  //    distance, matching the wire tool's nearest-candidate behaviour).
  let snappedEnds = 0;
  let droppedDegenerate = 0;
  let filteredByScore = 0;
  let droppedIrregular = 0;
  interface SnappedTrace {
    points: [number, number][];
    score: number;
    onContact: [boolean, boolean];
    /** vertex index -> snap target label. Endpoints AND mid-wire contacts
     *  (a contact lying ON the metal: the polyline is split at the
     *  projection of the contact onto the nearest segment). */
    contacts: Map<number, string>;
  }
  const snapped: SnappedTrace[] = [];
  for (const t of traces) {
    if (dropIrregular && t.irregular === true) {
      droppedIrregular += 1;
      continue;
    }
    if ((t.score ?? 1) < minScore) {
      filteredByScore += 1;
      continue;
    }
    if (t.points.length < 2) {
      droppedDegenerate += 1;
      continue;
    }
    const pts = t.points.map((p) => [p[0], p[1]] as [number, number]);
    const onContact: [boolean, boolean] = [false, false];
    const contacts = new Map<number, string>();
    // 1a. Endpoints: proximity snap (wire-tool behaviour).
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
        onContact[end] = true;
        contacts.set(end, best.label);
        snappedEnds += 1;
      }
    }
    // 1b. Mid-wire contacts (INTERSECTION snap): a device contact that lies
    //     ON the metal centreline — within snapTol of a SEGMENT, not just of
    //     an endpoint — becomes a real net vertex: the polyline is split at
    //     the projection point and the contact coordinates inserted. A wire
    //     passing a pad in the middle now actually connects to it.
    const insertions: { at: number; target: TraceSnapTarget }[] = [];
    for (const s of snapTargets) {
      let bestD = snapTol;
      let bestAt = -1;
      for (let i = 0; i < pts.length - 1; i++) {
        const ax = pts[i][0];
        const ay = pts[i][1];
        const bx = pts[i + 1][0];
        const by = pts[i + 1][1];
        const dx = bx - ax;
        const dy = by - ay;
        const len2 = dx * dx + dy * dy;
        const u =
          len2 === 0
            ? 0
            : Math.max(0, Math.min(1, ((s.x - ax) * dx + (s.y - ay) * dy) / len2));
        const px = ax + u * dx;
        const py = ay + u * dy;
        const d = Math.hypot(s.x - px, s.y - py);
        if (d <= bestD) {
          bestD = d;
          bestAt = i + u;
        }
      }
      // Skip endpoints already snapped to THIS target (1a did it).
      if (bestAt >= 0) {
        const isEnd =
          bestAt < 0.5 || bestAt > pts.length - 1 - 0.5;
        if (isEnd && contacts.has(bestAt < 0.5 ? 0 : pts.length - 1)) continue;
        insertions.push({ at: bestAt, target: s });
      }
    }
    // Splice from the end so earlier indices stay valid.
    insertions.sort((a, b) => b.at - a.at);
    for (const ins of insertions) {
      const idx = Math.ceil(ins.at);
      pts.splice(idx, 0, [ins.target.x, ins.target.y]);
      contacts.set(idx, ins.target.label);
      snappedEnds += 1;
    }
    snapped.push({ points: pts, score: t.score ?? 1, onContact, contacts });
  }

  // 1.5 Stitch decode fragments: endpoints that nearly touch are merged and
  //     pulled to a shared point (the contact end wins — it preserves the
  //     real connection — otherwise the midpoint), so the wire is physically
  //     continuous instead of "segments with gaps".
  let stitchedPairs = 0;
  interface EndRef { trace: number; end: 0 | 1; x: number; y: number; onContact: boolean }
  const ends: EndRef[] = [];
  snapped.forEach((t, i) => {
    ends.push({ trace: i, end: 0, x: t.points[0][0], y: t.points[0][1], onContact: t.onContact[0] });
    ends.push({ trace: i, end: 1, x: t.points[t.points.length - 1][0], y: t.points[t.points.length - 1][1], onContact: t.onContact[1] });
  });
  for (let a = 0; a < ends.length; a++) {
    for (let b = a + 1; b < ends.length; b++) {
      const ea = ends[a];
      const eb = ends[b];
      if (ea.trace === eb.trace) continue;
      const d = Math.hypot(ea.x - eb.x, ea.y - eb.y);
      if (d > stitchTol) continue;
      const shared: [number, number] = ea.onContact
        ? [ea.x, ea.y]
        : eb.onContact
          ? [eb.x, eb.y]
          : [(ea.x + eb.x) / 2, (ea.y + eb.y) / 2];
      snapped[ea.trace].points[ea.end === 0 ? 0 : snapped[ea.trace].points.length - 1] = shared;
      snapped[eb.trace].points[eb.end === 0 ? 0 : snapped[eb.trace].points.length - 1] = shared;
      ea.x = shared[0];
      ea.y = shared[1];
      eb.x = shared[0];
      eb.y = shared[1];
      ea.onContact = ea.onContact || eb.onContact;
      eb.onContact = ea.onContact;
      stitchedPairs += 1;
    }
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

  // 1.6 Runs-decoder grouping: traces sharing a `group` belong to ONE
  //     physical wire / closed contour (the decoder already dissolved noise
  //     junctions) — union them even when no endpoints coincide.
  const rawTraces = traces;
  const groupIds = new Map<number, string>();
  snapped.forEach((_, i) => {
    const g = rawTraces[i]?.group;
    if (typeof g !== "number") return;
    const key = `g${g}`;
    const prev = groupIds.get(g);
    if (prev) union(prev, `t${i}`);
    else groupIds.set(g, `t${i}`);
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
  const warnings: string[] = [];
  const GROUP_WARN_TRACES = 64;
  let droppedLowContacts = 0;
  let n = 0;
  for (const members of groups.values()) {
    n += 1;
    if (members.length > GROUP_WARN_TRACES) {
      warnings.push(
        `net with ${members.length} traces merged by decoder group — the mask likely ` +
          "over-bridged neighbouring wires (threshold band too wide / Min gap too high). " +
          "Check the outlines; narrow the band or lower Min gap and re-decode."
      );
    }
    // Distinct device contacts this net touches (endpoint snaps + mid-wire
    // intersection snaps across every member trace).
    const labels = new Set<string>();
    for (const i of members) {
      for (const label of snapped[i].contacts.values()) labels.add(label);
    }
    if (minDeviceContacts > 0 && labels.size < minDeviceContacts) {
      droppedLowContacts += 1;
      continue;
    }
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

  return {
    nets,
    snappedEnds,
    droppedDegenerate,
    filteredByScore,
    stitchedPairs,
    droppedLowContacts,
    droppedIrregular,
    warnings
  };
}
