import type {
  AnnotationNet,
  AnnotationNetEdge,
  AnnotationNetNode,
  WireLayer
} from "shared";
import type { Point } from "./geometry";
import { uuid } from "./uuid";

/** Per-segment layer (null = the "unknown" default, stored as no `layer`). */
export type SegLayer = WireLayer | null;

/**
 * Pure graph edits over nets. Each helper returns the set of nets that
 * changed as `{ prev, next }` pairs (prev/next null = create/delete), which
 * the caller maps to `upsertNet` / `removeNet` actions (wrapped in a `batch`
 * when more than one net is touched, so it's a single undo step).
 *
 * Nothing here mutates its inputs.
 */
export interface NetChange {
  prev: AnnotationNet | null;
  next: AnnotationNet | null;
}

/** Anchor for in-progress drawing: an existing node we started extending. */
export interface DrawAnchor {
  netId: string;
  nodeId: string;
}

/** Parse a selection/hit id produced by the net annotation factory. */
export function parseNetPartId(
  id: string
): { netId: string; part: "net" | "node" | "edge"; partId?: string } | null {
  if (!id.startsWith("net:")) return null;
  const body = id.slice(4);
  const nodeAt = body.indexOf("/node:");
  if (nodeAt !== -1) {
    return { netId: body.slice(0, nodeAt), part: "node", partId: body.slice(nodeAt + 6) };
  }
  const edgeAt = body.indexOf("/edge:");
  if (edgeAt !== -1) {
    return { netId: body.slice(0, edgeAt), part: "edge", partId: body.slice(edgeAt + 6) };
  }
  return { netId: body, part: "net" };
}

const newId = () => uuid();
const makeNode = (p: Point): AnnotationNetNode => ({ id: newId(), x: p.x, y: p.y });
const makeEdge = (
  from: string,
  to: string,
  layer?: SegLayer
): AnnotationNetEdge => ({
  id: newId(),
  from,
  to,
  ...(layer ? { layer } : {})
});

/** Monotonically increasing counter for net names. Never reuses a name,
 *  even when nets are deleted/merged. Resets on die change. */
let _netNameCounter = 0;
function nextNetName(nets: AnnotationNet[]): string {
  // Find the max existing net number to seed the counter.
  if (_netNameCounter === 0) {
    let maxN = 0;
    for (const net of nets) {
      const m = net.name?.match(/^Net (\d+)$/);
      if (m) {
        const n = parseInt(m[1], 10);
        if (n > maxN) maxN = n;
      }
    }
    _netNameCounter = maxN;
  }
  // Also catch nets that already have a higher numeric suffix.
  for (const net of nets) {
    const m = net.name?.match(/(\d+)$/);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > _netNameCounter) _netNameCounter = n;
    }
  }
  _netNameCounter++;
  return `Net ${_netNameCounter}`;
}

/**
 * Commit a free-standing draft polyline (no terminal node hit).
 *  - with `anchor`: append the chain onto the anchor's net
 *  - without: create a brand-new net
 */
/**
 * Drop consecutive coincident points (avoids zero-length segments), keeping a
 * parallel per-segment layer array in sync. `segLayers[i]` is the layer of the
 * segment `points[i] → points[i+1]`. When a point is dropped its degenerate
 * incoming segment is dropped with it.
 */
function dedupe(
  points: Point[],
  segLayers: SegLayer[]
): { points: Point[]; segLayers: SegLayer[] } {
  const outP: Point[] = [];
  const outS: SegLayer[] = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const last = outP[outP.length - 1];
    if (last && Math.abs(last.x - p.x) < 1e-3 && Math.abs(last.y - p.y) < 1e-3) {
      continue;
    }
    if (outP.length > 0) outS.push(segLayers[i - 1] ?? null);
    outP.push(p);
  }
  return { points: outP, segLayers: outS };
}

export function commitDraft(
  nets: AnnotationNet[],
  rawPoints: Point[],
  anchor: DrawAnchor | null,
  rawSegLayers: SegLayer[] = []
): NetChange[] {
  const { points, segLayers } = dedupe(rawPoints, rawSegLayers);
  if (points.length < 2) return [];

  if (anchor) {
    const net = nets.find((n) => n.id === anchor.netId);
    if (!net) return [];
    const nodes = [...net.nodes];
    const edges = [...net.edges];
    let prevId = anchor.nodeId;
    // points[0] is the anchor node itself — start chaining from points[1].
    // Segment points[i-1]→points[i] carries segLayers[i-1].
    for (let i = 1; i < points.length; i++) {
      const node = makeNode(points[i]);
      nodes.push(node);
      edges.push(makeEdge(prevId, node.id, segLayers[i - 1]));
      prevId = node.id;
    }
    return [{ prev: net, next: { ...net, nodes, edges } }];
  }

  const nodes = points.map(makeNode);
  const edges: AnnotationNetEdge[] = [];
  for (let i = 0; i < nodes.length - 1; i++) {
    edges.push(makeEdge(nodes[i].id, nodes[i + 1].id, segLayers[i]));
  }
  const net: AnnotationNet = {
    id: newId(),
    name: nextNetName(nets),
    nodes,
    edges
  };
  return [{ prev: null, next: net }];
}

/**
 * Terminate the draft on an existing node. Three cases:
 *  - same net  → close the chain within that net
 *  - cross net → merge the two nets into one
 *  - no anchor → free draft that ends inside an existing net
 */
export function connectToNode(
  nets: AnnotationNet[],
  rawPoints: Point[],
  anchor: DrawAnchor | null,
  hitNetId: string,
  hitNodeId: string,
  rawSegLayers: SegLayer[] = [],
  connectLayer: SegLayer = null
): NetChange[] {
  const hitNet = nets.find((n) => n.id === hitNetId);
  if (!hitNet) return [];
  const hitNode = hitNet.nodes.find((n) => n.id === hitNodeId);
  if (!hitNode) return [];
  const { points, segLayers } = dedupe(rawPoints, rawSegLayers);
  // points[0] is the anchor node (when anchored); the mid points are the
  // free-clicked vertices between anchor and the terminal hit node. The
  // segment points[k]→points[k+1] carries segLayers[k]; with an anchor that
  // is exactly the edge into mid[k]. The terminal bridge edge uses
  // `connectLayer` (the layer active at the connecting click).
  const mid = anchor ? points.slice(1) : points;
  if (mid.length === 0 && !anchor) return [];
  const segOf = (k: number): SegLayer => segLayers[k] ?? null;

  // Same-net: extend within one net, closing on the hit node.
  if (anchor && hitNetId === anchor.netId) {
    const nodes = [...hitNet.nodes];
    const edges = [...hitNet.edges];
    let prevId = anchor.nodeId;
    mid.forEach((p, k) => {
      const node = makeNode(p);
      nodes.push(node);
      edges.push(makeEdge(prevId, node.id, segOf(k)));
      prevId = node.id;
    });
    edges.push(makeEdge(prevId, hitNode.id, connectLayer));
    return [{ prev: hitNet, next: { ...hitNet, nodes, edges } }];
  }

  // Cross-net merge: chain mid points onto src, splice in dst's graph
  // (node ids are stable so no index fixups), bridge to the hit node.
  if (anchor) {
    const src = nets.find((n) => n.id === anchor.netId);
    if (!src) return [];
    const nodes = [...src.nodes];
    const edges = [...src.edges];
    let prevId = anchor.nodeId;
    mid.forEach((p, k) => {
      const node = makeNode(p);
      nodes.push(node);
      edges.push(makeEdge(prevId, node.id, segOf(k)));
      prevId = node.id;
    });
    for (const n of hitNet.nodes) nodes.push(n);
    for (const e of hitNet.edges) edges.push(e);
    edges.push(makeEdge(prevId, hitNode.id, connectLayer));
    return [
      { prev: hitNet, next: null },
      { prev: src, next: { ...src, nodes, edges } }
    ];
  }

  // No anchor: free draft connecting into an existing net.
  const midNodes = mid.map(makeNode);
  const nodes = [...midNodes, ...hitNet.nodes];
  const edges: AnnotationNetEdge[] = [];
  for (let i = 0; i < midNodes.length - 1; i++) {
    edges.push(makeEdge(midNodes[i].id, midNodes[i + 1].id, segOf(i)));
  }
  for (const e of hitNet.edges) edges.push(e);
  edges.push(makeEdge(midNodes[midNodes.length - 1].id, hitNode.id, connectLayer));
  return [{ prev: hitNet, next: { ...hitNet, nodes, edges } }];
}

/**
 * Insert a vertex on the body of `edgeId`, splitting it into two collinear
 * edges that both inherit the original layer. Returns the rebuilt net and the
 * new node's id (use it as a `DrawAnchor`/terminus so a wire taps into the
 * middle of an existing trace). Returns null if the edge is gone. Pure.
 */
export function splitEdgeAtPoint(
  net: AnnotationNet,
  edgeId: string,
  at: Point
): { net: AnnotationNet; nodeId: string } | null {
  const edge = net.edges.find((e) => e.id === edgeId);
  if (!edge) return null;
  const node = makeNode({ x: Math.round(at.x), y: Math.round(at.y) });
  const layer: SegLayer = edge.layer ?? null;
  const edges = net.edges.filter((e) => e.id !== edgeId);
  edges.push(makeEdge(edge.from, node.id, layer));
  edges.push(makeEdge(node.id, edge.to, layer));
  return {
    net: { ...net, nodes: [...net.nodes, node], edges },
    nodeId: node.id
  };
}

/** What the user has selected, grouped per net. */
export interface NetSelection {
  /** Whole nets to delete outright. */
  netIds: ReadonlySet<string>;
  /** Per-net node ids to remove. */
  nodeIds: ReadonlyMap<string, ReadonlySet<string>>;
  /** Per-net edge ids to remove. */
  edgeIds: ReadonlyMap<string, ReadonlySet<string>>;
}

/**
 * Delete selected nets / nodes / edges. Removing nodes/edges can split a net
 * into disconnected pieces — each surviving component becomes its own net
 * (the original id stays on the first component); lone fragments with no
 * edges are dropped.
 */
export function deleteSelection(
  nets: AnnotationNet[],
  sel: NetSelection
): NetChange[] {
  const changes: NetChange[] = [];

  for (const net of nets) {
    if (sel.netIds.has(net.id)) {
      changes.push({ prev: net, next: null });
      continue;
    }
    const deadNodes = sel.nodeIds.get(net.id);
    const deadEdges = sel.edgeIds.get(net.id);
    if (!deadNodes?.size && !deadEdges?.size) continue;

    const surviving = net.edges.filter((e) => {
      if (deadEdges?.has(e.id)) return false;
      if (deadNodes?.has(e.from) || deadNodes?.has(e.to)) return false;
      return true;
    });

    if (surviving.length === 0) {
      changes.push({ prev: net, next: null });
      continue;
    }

    const components = splitComponents(net, surviving);
    if (components.length === 0) {
      changes.push({ prev: net, next: null });
      continue;
    }
    // Keep the original id on the first component; the rest become new nets.
    changes.push({ prev: net, next: { ...components[0], id: net.id, name: net.name } });
    for (let i = 1; i < components.length; i++) {
      changes.push({
        prev: null,
        next: { ...components[i], id: newId(), name: `${net.name} (${i + 1})` }
      });
    }
  }

  return changes;
}

/** Group surviving edges into connected components by node-id adjacency. */
function splitComponents(
  net: AnnotationNet,
  edges: AnnotationNetEdge[]
): AnnotationNet[] {
  const nodeById = new Map(net.nodes.map((n) => [n.id, n]));
  const adj = new Map<string, AnnotationNetEdge[]>();
  const link = (id: string, e: AnnotationNetEdge) => {
    const list = adj.get(id);
    if (list) list.push(e);
    else adj.set(id, [e]);
  };
  for (const e of edges) {
    link(e.from, e);
    link(e.to, e);
  }

  const seen = new Set<string>();
  const out: AnnotationNet[] = [];

  for (const start of adj.keys()) {
    if (seen.has(start)) continue;
    const compNodeIds = new Set<string>();
    const compEdges = new Set<AnnotationNetEdge>();
    const stack = [start];
    seen.add(start);
    while (stack.length) {
      const id = stack.pop()!;
      compNodeIds.add(id);
      for (const e of adj.get(id) ?? []) {
        compEdges.add(e);
        const other = e.from === id ? e.to : e.from;
        if (!seen.has(other)) {
          seen.add(other);
          stack.push(other);
        }
      }
    }
    const nodes: AnnotationNetNode[] = [];
    for (const id of compNodeIds) {
      const n = nodeById.get(id);
      if (n) nodes.push(n);
    }
    out.push({
      id: net.id,
      name: net.name,
      nodes,
      edges: [...compEdges]
    });
  }

  return out;
}
