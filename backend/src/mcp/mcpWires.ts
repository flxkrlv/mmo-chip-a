import { randomUUID } from "node:crypto";
import { effectiveLayerStack } from "shared";
import type {
  AnnotationNet,
  AnnotationNetEdge,
  AnnotationNetNode,
  DieAnnotations,
  HumanAnnotation,
  MetalStack,
  WireLayer
} from "shared";
import { DEFAULT_METAL_STACK } from "../api/metalStack.js";
import { readAnnotations, readDieRecord } from "../store.js";
import type { DieRecord } from "../types.js";
import { findItem, McpEditError, readMcpState, type McpDieState, type McpOwned } from "./mcpState.js";
import {
  assertOnDie,
  nonEmpty,
  num,
  point,
  requireOwned,
  str,
  textResult,
  ToolInputError,
  write,
  type ToolDef
} from "./mcpToolKit.js";

/**
 * MCP wire + via tools, gated by the die's separate "wire edits" toggle.
 *
 * Ownership is tracked per net, node, segment (edge) and via. The MCP client
 * may create nets, extend or connect into ANY net (adding nodes/segments,
 * splitting a segment where it taps in, merging two nets), but may only move,
 * relayer or delete nodes, segments and vias it created itself. A node can
 * only move or be deleted when every segment touching it is MCP-made, so
 * human geometry never changes shape. Net results mirror the GUI wire tool
 * (lib/netGraph.ts): a merge keeps the `from` net's id and name; a delete that
 * disconnects a net splits it into one net per connected piece.
 */

type Pt = { x: number; y: number };
type Owned = { nodes: string[]; edges: string[] };

/** Wire layers + vias of the die: its metal stack plus its process layers
 *  (poly, diffusions, wells… with their contacts / taps), as in the GUI. */
export function layerStackOf(record: DieRecord, annotations: Pick<DieAnnotations, "process">): MetalStack {
  return effectiveLayerStack(record.config?.metalStack ?? DEFAULT_METAL_STACK, annotations.process);
}

// ─── Pure graph helpers ─────────────────────────────────────────────

const makeNode = (p: Pt): AnnotationNetNode => ({ id: randomUUID(), x: p.x, y: p.y });
const makeEdge = (from: string, to: string, layer: WireLayer | null): AnnotationNetEdge => ({
  id: randomUUID(),
  from,
  to,
  ...(layer ? { layer } : {})
});

/** Next "Net N" name, never reusing a number (same rule as the GUI). */
export function nextNetName(nets: AnnotationNet[]): string {
  let max = 0;
  for (const net of nets) {
    const m = net.name?.match(/(\d+)$/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `Net ${max + 1}`;
}

export interface NetRef {
  netId: string;
  nodeId?: string;
  edgeId?: string;
  x?: number;
  y?: number;
}

/**
 * The node `ref` points at inside `net`. A segment ref is split at the
 * projection of (x, y) — both halves keep the segment's layer and its
 * ownership; the new junction node is MCP-owned. Landing on (or within a
 * pixel of) an end of the segment just uses that end node.
 */
export function resolveRef(
  net: AnnotationNet,
  ref: NetRef,
  ownedEdges: ReadonlySet<string>,
  added: Owned
): { net: AnnotationNet; nodeId: string } {
  if (ref.nodeId) {
    if (!net.nodes.some((n) => n.id === ref.nodeId)) {
      throw new McpEditError(`No node ${ref.nodeId} in net ${net.id}`, 404);
    }
    return { net, nodeId: ref.nodeId };
  }
  if (!ref.edgeId) throw new ToolInputError(`A net reference needs nodeId, or edgeId + x + y`);
  if (ref.x === undefined || ref.y === undefined) {
    throw new ToolInputError(`A segment reference needs x and y (the tap point, projected onto the segment)`);
  }
  const edge = net.edges.find((e) => e.id === ref.edgeId);
  if (!edge) throw new McpEditError(`No segment ${ref.edgeId} in net ${net.id}`, 404);
  const a = net.nodes.find((n) => n.id === edge.from);
  const b = net.nodes.find((n) => n.id === edge.to);
  if (!a || !b) throw new McpEditError(`Segment ${edge.id} references a missing node`, 409);

  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((ref.x - a.x) * dx + (ref.y - a.y) * dy) / len2));
  const at = { x: Math.round(a.x + t * dx), y: Math.round(a.y + t * dy) };
  if (Math.hypot(at.x - a.x, at.y - a.y) <= 1) return { net, nodeId: a.id };
  if (Math.hypot(at.x - b.x, at.y - b.y) <= 1) return { net, nodeId: b.id };

  const node = makeNode(at);
  const layer = edge.layer ?? null;
  const first = makeEdge(a.id, node.id, layer);
  const second = makeEdge(node.id, b.id, layer);
  added.nodes.push(node.id);
  if (ownedEdges.has(edge.id)) added.edges.push(first.id, second.id);
  return {
    net: {
      ...net,
      nodes: [...net.nodes, node],
      edges: net.edges.flatMap((e) => (e.id === edge.id ? [first, second] : [e]))
    },
    nodeId: node.id
  };
}

/** Connected pieces of `net` over `edges`; nodes without edges are dropped. */
export function connectedParts(net: AnnotationNet, edges: AnnotationNetEdge[]): AnnotationNet[] {
  const adjacency = new Map<string, AnnotationNetEdge[]>();
  for (const e of edges) {
    adjacency.set(e.from, [...(adjacency.get(e.from) ?? []), e]);
    adjacency.set(e.to, [...(adjacency.get(e.to) ?? []), e]);
  }
  const seen = new Set<string>();
  const parts: AnnotationNet[] = [];
  for (const start of adjacency.keys()) {
    if (seen.has(start)) continue;
    const nodeIds = new Set<string>([start]);
    const partEdges = new Set<AnnotationNetEdge>();
    const pending = [start];
    seen.add(start);
    while (pending.length) {
      const id = pending.pop()!;
      for (const e of adjacency.get(id) ?? []) {
        partEdges.add(e);
        const other = e.from === id ? e.to : e.from;
        if (!seen.has(other)) {
          seen.add(other);
          nodeIds.add(other);
          pending.push(other);
        }
      }
    }
    parts.push({
      ...net,
      nodes: net.nodes.filter((n) => nodeIds.has(n.id)),
      edges: edges.filter((e) => partEdges.has(e))
    });
  }
  return parts;
}

// ─── Argument helpers ───────────────────────────────────────────────

function wireLayer(value: unknown, stack: MetalStack, key: string): WireLayer | null {
  const allowed = ["poly", ...stack.metals.map((m) => m.layer)];
  if (value === "unknown") return null;
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new ToolInputError(`"${key}" must be one of: ${[...allowed, "unknown"].join(", ")}`);
  }
  return value as WireLayer;
}

function viaLayer(value: unknown, stack: MetalStack): string {
  const ids = stack.vias.map((v) => v.id);
  if (typeof value !== "string" || !ids.includes(value)) {
    throw new ToolInputError(`"via" must be one of: ${ids.join(", ")}`);
  }
  return value;
}

function pointList(value: unknown, key: string): Pt[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ToolInputError(`"${key}" must be an array of {x, y}`);
  return value.map((p) => {
    const x = (p as { x?: unknown })?.x;
    const y = (p as { y?: unknown })?.y;
    if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) {
      throw new ToolInputError(`"${key}" must be an array of {x, y} numbers`);
    }
    return { x: Math.round(x), y: Math.round(y) };
  });
}

function netRef(value: unknown, key: string): NetRef | undefined {
  if (value === undefined || value === null) return undefined;
  const ref = value as Record<string, unknown>;
  if (typeof ref !== "object" || typeof ref.netId !== "string") {
    throw new ToolInputError(`"${key}" must be {netId, nodeId} or {netId, edgeId, x, y}`);
  }
  return {
    netId: ref.netId,
    nodeId: str(ref, "nodeId", true),
    edgeId: str(ref, "edgeId", true),
    x: num(ref, "x", true),
    y: num(ref, "y", true)
  };
}

function idList(value: unknown, key: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new ToolInputError(`"${key}" must be an array of ids`);
  }
  return value as string[];
}

function ownedSets(owned: McpOwned) {
  return {
    nets: new Set(owned.nets),
    nodes: new Set(owned.netNodes),
    edges: new Set(owned.netEdges)
  };
}

function findNet(nets: AnnotationNet[], netId: string): AnnotationNet {
  const net = nets.find((n) => n.id === netId);
  if (!net) throw new McpEditError(`No net with id ${netId}`, 404);
  return net;
}

/** Every segment touching `nodeId` must be MCP-made for the node to move / go. */
function requireFreeNode(
  net: AnnotationNet,
  nodeId: string,
  owned: ReturnType<typeof ownedSets>,
  full: boolean
): AnnotationNetNode {
  const node = net.nodes.find((n) => n.id === nodeId);
  if (!node) throw new McpEditError(`No node ${nodeId} in net ${net.id}`, 404);
  if (full) return node;
  if (!owned.nodes.has(nodeId)) throw new McpEditError(`Node ${nodeId} was not created by MCP; it is read-only.`, 403);
  const humanEdge = net.edges.find((e) => (e.from === nodeId || e.to === nodeId) && !owned.edges.has(e.id));
  if (humanEdge) {
    throw new McpEditError(
      `Node ${nodeId} is an end of segment ${humanEdge.id}, which was not created by MCP; the node can't be moved or deleted.`,
      403
    );
  }
  return node;
}

const nodeRefSchema = {
  type: "object",
  properties: {
    netId: { type: "string" },
    nodeId: { type: "string", description: "Connect at this existing vertex" },
    edgeId: { type: "string", description: "Or tap into this segment (it is split at the projection of x, y)" },
    x: point,
    y: point
  },
  required: ["netId"],
  additionalProperties: false
};

const layerSchema = (description: string) => ({
  type: "string",
  description: `${description} One of the wireLayers from get_die_info (poly, metal1, …) or "unknown".`
});

// ─── Read tool ──────────────────────────────────────────────────────

const findWiresNear: ToolDef = {
  name: "find_wires_near",
  title: "Find wires near a point",
  description:
    "List net vertices, wire segments and vias near a die point, with their ids — use them as from / to " +
    "references for add_wire or to pick what to edit. `mcpOwned` marks items this MCP client created.",
  inputSchema: {
    type: "object",
    properties: {
      x: point,
      y: point,
      radius: { type: "number", minimum: 1, maximum: 2000, description: "Search radius in die pixels (default 25)" },
      limit: { type: "integer", minimum: 1, maximum: 200, description: "Max items per kind (default 30)" }
    },
    required: ["x", "y"],
    additionalProperties: false
  },
  annotations: { readOnlyHint: true },
  run: async (ctx, args) => {
    const p = { x: num(args, "x"), y: num(args, "y") };
    const radius = Math.min(2000, Math.max(1, num(args, "radius", true) ?? 25));
    const limit = Math.min(200, Math.max(1, Math.floor(num(args, "limit", true) ?? 30)));
    const annotations = await readAnnotations(ctx.dataRoot, ctx.dieId);
    const state = await readMcpState(ctx.dataRoot, ctx.dieId);
    const owned = ownedSets(state.owned);
    const viaOwned = new Set(state.owned.annotations);
    const round = (v: number) => Math.round(v * 10) / 10;

    const nodes: Record<string, unknown>[] = [];
    const segments: Record<string, unknown>[] = [];
    for (const net of annotations.nets) {
      const byId = new Map(net.nodes.map((n) => [n.id, n]));
      for (const n of net.nodes) {
        const distance = Math.hypot(n.x - p.x, n.y - p.y);
        if (distance > radius) continue;
        nodes.push({
          netId: net.id,
          netName: net.name,
          nodeId: n.id,
          x: n.x,
          y: n.y,
          distance: round(distance),
          degree: net.edges.filter((e) => e.from === n.id || e.to === n.id).length,
          mcpOwned: owned.nodes.has(n.id)
        });
      }
      for (const e of net.edges) {
        const a = byId.get(e.from);
        const b = byId.get(e.to);
        if (!a || !b) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len2 = dx * dx + dy * dy;
        const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
        const closest = { x: round(a.x + t * dx), y: round(a.y + t * dy) };
        const distance = Math.hypot(closest.x - p.x, closest.y - p.y);
        if (distance > radius) continue;
        segments.push({
          netId: net.id,
          netName: net.name,
          edgeId: e.id,
          from: { nodeId: a.id, x: a.x, y: a.y },
          to: { nodeId: b.id, x: b.x, y: b.y },
          layer: e.layer ?? "unknown",
          closest,
          distance: round(distance),
          mcpOwned: owned.edges.has(e.id)
        });
      }
    }
    const vias = (annotations.annotations ?? [])
      .filter((a) => a.class === "point_via" && a.geometry.kind === "point")
      .map((a) => {
        const g = a.geometry as { x: number; y: number };
        return { viaId: a.id, via: a.layer ?? null, x: g.x, y: g.y, distance: round(Math.hypot(g.x - p.x, g.y - p.y)), mcpOwned: viaOwned.has(a.id) };
      })
      .filter((v) => v.distance <= radius);
    const nearest = <T extends Record<string, unknown>>(list: T[]) =>
      list.sort((a, b) => (a.distance as number) - (b.distance as number)).slice(0, limit);
    return textResult({ at: p, radius, nodes: nearest(nodes), segments: nearest(segments), vias: nearest(vias) });
  }
};

// ─── Wire writes ────────────────────────────────────────────────────

const addWire: ToolDef = {
  name: "add_wire",
  title: "Add wire",
  description:
    "Draw a wire (polyline of segments) on the die. Without from/to it becomes a new net. With `from` it " +
    "extends that net from an existing vertex, or taps into a segment (split at the projection of x, y). " +
    "With `to` it ends on a vertex / segment: if that is another net, the two nets are MERGED into the " +
    "`from` net (only do this when they are electrically the same node). Use find_wires_near for ids. " +
    "Requires \"Allow wire edits\" for this die.",
  inputSchema: {
    type: "object",
    properties: {
      points: {
        type: "array",
        items: { type: "object", properties: { x: point, y: point }, required: ["x", "y"] },
        description: "Free vertices in order, between `from` and `to` (both optional)"
      },
      from: nodeRefSchema,
      to: nodeRefSchema,
      layer: layerSchema("Layer of every new segment."),
      segmentLayers: {
        type: "array",
        items: { type: "string" },
        description: "Optional per-segment layers overriding `layer`, one per new segment in order"
      },
      name: { type: "string", description: "Name for a NEW net (default: next \"Net N\")" }
    },
    required: ["layer"],
    additionalProperties: false
  },
  annotations: { readOnlyHint: false, destructiveHint: false },
  run: async (ctx, args) => {
    const record = await readDieRecord(ctx.dataRoot, ctx.dieId);
    const stack = layerStackOf(record, await readAnnotations(ctx.dataRoot, ctx.dieId));
    let pts = pointList(args.points, "points");
    let from = netRef(args.from, "from");
    let to = netRef(args.to, "to");
    for (const ref of [from, to]) {
      if (ref?.x !== undefined && ref.y !== undefined) assertOnDie(record, [{ x: ref.x, y: ref.y }]);
    }
    assertOnDie(record, pts);
    const layer = wireLayer(args.layer, stack, "layer");
    const name = str(args, "name", true);
    if (name !== undefined) nonEmpty(name, "name");
    if (name !== undefined && (from || to)) {
      throw new ToolInputError(`"name" is only for a new net; rename your own net with update_wire`);
    }

    const vertexCount = (from ? 1 : 0) + pts.length + (to ? 1 : 0);
    if (vertexCount < 2) throw new ToolInputError(`A wire needs at least 2 vertices (counting from / to)`);
    const segmentCount = vertexCount - 1;
    let segLayers: (WireLayer | null)[] = Array.from({ length: segmentCount }, () => layer);
    if (args.segmentLayers !== undefined) {
      if (!Array.isArray(args.segmentLayers) || args.segmentLayers.length !== segmentCount) {
        throw new ToolInputError(`"segmentLayers" must have exactly ${segmentCount} entries (one per new segment)`);
      }
      segLayers = args.segmentLayers.map((l, i) => wireLayer(l, stack, `segmentLayers[${i}]`));
    }
    // Only `to` given: draw it backwards from `to`, same result.
    if (!from && to) {
      from = to;
      to = undefined;
      pts = [...pts].reverse();
      segLayers = [...segLayers].reverse();
    }
    for (let i = 1; i < pts.length; i++) {
      if (pts[i].x === pts[i - 1].x && pts[i].y === pts[i - 1].y) {
        throw new ToolInputError(`Consecutive points ${i - 1} and ${i} are identical`);
      }
    }

    return write(ctx, "wires", (annotations, state) => {
      const owned = ownedSets(state.owned);
      const added: Owned = { nodes: [], edges: [] };
      const ownNets: string[] = [];
      const items: { collection: "nets"; id: string; after: AnnotationNet | null }[] = [];

      let net: AnnotationNet;
      let prevId: string;
      if (from) {
        const resolved = resolveRef(findNet(annotations.nets, from.netId), from, owned.edges, added);
        net = resolved.net;
        prevId = resolved.nodeId;
      } else {
        const start = makeNode(pts[0]);
        added.nodes.push(start.id);
        net = { id: randomUUID(), name: name ?? nextNetName(annotations.nets), nodes: [start], edges: [] };
        ownNets.push(net.id);
        prevId = start.id;
        pts = pts.slice(1);
      }

      const chainNodeIds = [prevId];
      const newEdgeIds: string[] = [];
      let seg = 0;
      const link = (toId: string) => {
        if (toId === prevId) throw new ToolInputError(`The wire would connect a vertex to itself`);
        const edge = makeEdge(prevId, toId, segLayers[seg++]);
        net = { ...net, edges: [...net.edges, edge] };
        added.edges.push(edge.id);
        newEdgeIds.push(edge.id);
        chainNodeIds.push(toId);
        prevId = toId;
      };
      for (const p of pts) {
        const node = makeNode(p);
        net = { ...net, nodes: [...net.nodes, node] };
        added.nodes.push(node.id);
        link(node.id);
      }

      let mergedNetId: string | undefined;
      if (to) {
        if (to.netId === net.id) {
          const resolved = resolveRef(net, to, new Set([...owned.edges, ...added.edges]), added);
          net = resolved.net;
          link(resolved.nodeId);
        } else {
          const resolved = resolveRef(findNet(annotations.nets, to.netId), to, owned.edges, added);
          net = {
            ...net,
            nodes: [...net.nodes, ...resolved.net.nodes],
            edges: [...net.edges, ...resolved.net.edges]
          };
          link(resolved.nodeId);
          mergedNetId = to.netId;
          items.push({ collection: "nets", id: to.netId, after: null });
        }
      }
      items.push({ collection: "nets", id: net.id, after: net });

      const layerText = layer ?? "unknown layer";
      return {
        tool: "add_wire",
        summary: mergedNetId
          ? `Wire joining ${net.name} + ${findNet(annotations.nets, mergedNetId).name}`
          : from
            ? `Wire on ${net.name} (${segmentCount} seg, ${layerText})`
            : `New net ${net.name} (${segmentCount} seg, ${layerText})`,
        items,
        own: { nets: ownNets, netNodes: added.nodes, netEdges: added.edges },
        result: {
          netId: net.id,
          netName: net.name,
          nodeIds: chainNodeIds,
          edgeIds: newEdgeIds,
          ...(mergedNetId ? { mergedNetId } : {})
        }
      };
    });
  }
};

const updateWire: ToolDef = {
  name: "update_wire",
  title: "Update wire",
  description:
    "Edit wire geometry this MCP client created: rename one of its own nets, move its own vertices (only " +
    "when every segment touching the vertex is its own), or change the layer of its own segments. " +
    "Requires \"Allow wire edits\".",
  inputSchema: {
    type: "object",
    properties: {
      netId: { type: "string" },
      name: { type: "string", description: "New net name (own nets only)" },
      moveNodes: {
        type: "array",
        items: {
          type: "object",
          properties: { nodeId: { type: "string" }, x: point, y: point },
          required: ["nodeId", "x", "y"]
        }
      },
      setLayers: {
        type: "array",
        items: {
          type: "object",
          properties: { edgeId: { type: "string" }, layer: layerSchema("") },
          required: ["edgeId", "layer"]
        }
      }
    },
    required: ["netId"],
    additionalProperties: false
  },
  annotations: { readOnlyHint: false, destructiveHint: false },
  run: async (ctx, args) => {
    const record = await readDieRecord(ctx.dataRoot, ctx.dieId);
    const stack = layerStackOf(record, await readAnnotations(ctx.dataRoot, ctx.dieId));
    const netId = str(args, "netId");
    const name = str(args, "name", true);
    if (name !== undefined) nonEmpty(name, "name");
    const moves = (Array.isArray(args.moveNodes) ? args.moveNodes : args.moveNodes === undefined ? [] : null);
    const layers = (Array.isArray(args.setLayers) ? args.setLayers : args.setLayers === undefined ? [] : null);
    if (!moves || !layers) throw new ToolInputError(`"moveNodes" and "setLayers" must be arrays`);
    const moveList = moves.map((m) => {
      const o = m as Record<string, unknown>;
      return { nodeId: str(o, "nodeId"), x: Math.round(num(o, "x")), y: Math.round(num(o, "y")) };
    });
    assertOnDie(record, moveList);
    const layerList = layers.map((l, i) => {
      const o = l as Record<string, unknown>;
      return { edgeId: str(o, "edgeId"), layer: wireLayer(o.layer, stack, `setLayers[${i}].layer`) };
    });
    if (name === undefined && moveList.length === 0 && layerList.length === 0) {
      throw new ToolInputError(`Nothing to change: pass name, moveNodes and/or setLayers`);
    }

    return write(ctx, "wires", (annotations, state) => {
      const owned = ownedSets(state.owned);
      let net = findNet(annotations.nets, netId);
      if (name !== undefined) {
        requireOwned<AnnotationNet>(annotations, state, "nets", netId);
        net = { ...net, name };
      }
      for (const move of moveList) {
        requireFreeNode(net, move.nodeId, owned, state.full);
        net = { ...net, nodes: net.nodes.map((n) => (n.id === move.nodeId ? { ...n, x: move.x, y: move.y } : n)) };
      }
      for (const { edgeId, layer } of layerList) {
        if (!net.edges.some((e) => e.id === edgeId)) throw new McpEditError(`No segment ${edgeId} in net ${netId}`, 404);
        if (!state.full && !owned.edges.has(edgeId)) throw new McpEditError(`Segment ${edgeId} was not created by MCP; it is read-only.`, 403);
        net = {
          ...net,
          edges: net.edges.map((e) => {
            if (e.id !== edgeId) return e;
            const { layer: _old, ...rest } = e;
            return layer ? { ...rest, layer } : rest;
          })
        };
      }
      const parts = [
        name !== undefined ? `rename → ${name}` : null,
        moveList.length ? `move ${moveList.length} vertex${moveList.length > 1 ? "es" : ""}` : null,
        layerList.length ? `relayer ${layerList.length} seg` : null
      ].filter(Boolean);
      return {
        tool: "update_wire",
        summary: `Edit ${net.name}: ${parts.join(", ")}`,
        items: [{ collection: "nets", id: netId, after: net }]
      };
    });
  }
};

const deleteWire: ToolDef = {
  name: "delete_wire",
  title: "Delete wire",
  description:
    "Delete wire geometry this MCP client created. With only netId, deletes a whole net (only if it is " +
    "entirely MCP-made). With nodeIds / edgeIds, deletes those vertices (and their segments) and segments — " +
    "all must be MCP-made. If that disconnects the net it is split into one net per connected piece. " +
    "Requires \"Allow wire edits\".",
  inputSchema: {
    type: "object",
    properties: {
      netId: { type: "string" },
      nodeIds: { type: "array", items: { type: "string" } },
      edgeIds: { type: "array", items: { type: "string" } }
    },
    required: ["netId"],
    additionalProperties: false
  },
  annotations: { readOnlyHint: false, destructiveHint: true },
  run: async (ctx, args) => {
    const netId = str(args, "netId");
    const nodeIds = idList(args.nodeIds, "nodeIds");
    const edgeIds = idList(args.edgeIds, "edgeIds");
    return write(ctx, "wires", (annotations, state) => {
      const owned = ownedSets(state.owned);
      const net = findNet(annotations.nets, netId);

      if (nodeIds.length === 0 && edgeIds.length === 0) {
        requireOwned<AnnotationNet>(annotations, state, "nets", netId);
        const human =
          net.nodes.find((n) => !owned.nodes.has(n.id))?.id ?? net.edges.find((e) => !owned.edges.has(e.id))?.id;
        if (human && !state.full) {
          throw new McpEditError(`Net ${netId} contains geometry not created by MCP (${human}); delete your own parts instead.`, 403);
        }
        return {
          tool: "delete_wire",
          summary: `Delete net ${net.name}`,
          items: [{ collection: "nets", id: netId, after: null }]
        };
      }

      for (const nodeId of nodeIds) requireFreeNode(net, nodeId, owned, state.full);
      for (const edgeId of edgeIds) {
        if (!net.edges.some((e) => e.id === edgeId)) throw new McpEditError(`No segment ${edgeId} in net ${netId}`, 404);
        if (!state.full && !owned.edges.has(edgeId)) throw new McpEditError(`Segment ${edgeId} was not created by MCP; it is read-only.`, 403);
      }
      const deadNodes = new Set(nodeIds);
      const deadEdges = new Set(edgeIds);
      const surviving = net.edges.filter((e) => !deadEdges.has(e.id) && !deadNodes.has(e.from) && !deadNodes.has(e.to));
      const parts = connectedParts(net, surviving);
      // The piece with the most human vertices keeps the net's id and name.
      const humanCount = (p: AnnotationNet) => p.nodes.filter((n) => !owned.nodes.has(n.id)).length;
      parts.sort((a, b) => humanCount(b) - humanCount(a) || b.nodes.length - a.nodes.length);

      const items: { collection: "nets"; id: string; after: AnnotationNet | null }[] = [];
      const ownNets: string[] = [];
      if (parts.length === 0) {
        items.push({ collection: "nets", id: netId, after: null });
      } else {
        items.push({ collection: "nets", id: netId, after: parts[0] });
        parts.slice(1).forEach((part, i) => {
          const split = { ...part, id: randomUUID(), name: `${net.name} (${i + 2})` };
          if (humanCount(part) === 0) ownNets.push(split.id);
          items.push({ collection: "nets", id: split.id, after: split });
        });
      }
      const what = [
        nodeIds.length ? `${nodeIds.length} vertex${nodeIds.length > 1 ? "es" : ""}` : null,
        edgeIds.length ? `${edgeIds.length} seg` : null
      ].filter(Boolean);
      return {
        tool: "delete_wire",
        summary: `Delete ${what.join(" + ")} from ${net.name}${parts.length > 1 ? ` (split into ${parts.length})` : ""}`,
        items,
        own: { nets: ownNets },
        result: { netIds: items.filter((i) => i.after).map((i) => i.id) }
      };
    });
  }
};

// ─── Vias ───────────────────────────────────────────────────────────

const addVia: ToolDef = {
  name: "add_via",
  title: "Add via",
  description:
    "Place a via (layer transition, e.g. VIA12 = metal1↔metal2) at a die point. Vias connect wire vertices of " +
    "the two metals that sit on it. Requires \"Allow wire edits\".",
  inputSchema: {
    type: "object",
    properties: { x: point, y: point, via: { type: "string", description: "Via id from get_die_info metalStack.vias" } },
    required: ["x", "y", "via"],
    additionalProperties: false
  },
  annotations: { readOnlyHint: false, destructiveHint: false },
  run: async (ctx, args) => {
    const record = await readDieRecord(ctx.dataRoot, ctx.dieId);
    const p = { x: Math.round(num(args, "x")), y: Math.round(num(args, "y")) };
    assertOnDie(record, [p]);
    const via = viaLayer(args.via, layerStackOf(record, await readAnnotations(ctx.dataRoot, ctx.dieId)));
    return write(ctx, "wires", () => {
      const annotation: HumanAnnotation = {
        id: randomUUID(),
        class: "point_via",
        geometry: { kind: "point", ...p },
        layer: via
      };
      return {
        tool: "add_via",
        summary: `Via ${via} at ${p.x}, ${p.y}`,
        items: [{ collection: "annotations", id: annotation.id, after: annotation }],
        own: { annotations: [annotation.id] },
        result: { viaId: annotation.id }
      };
    });
  }
};

function requireOwnedVia(annotations: DieAnnotations, state: McpDieState, viaId: string): HumanAnnotation {
  const via = findItem<HumanAnnotation>(annotations, "annotations", viaId);
  if (!via || via.class !== "point_via") throw new McpEditError(`No via with id ${viaId}`, 404);
  return requireOwned<HumanAnnotation>(annotations, state, "annotations", viaId);
}

const updateVia: ToolDef = {
  name: "update_via",
  title: "Update via",
  description: "Move a via this MCP client placed, or change its type. Requires \"Allow wire edits\".",
  inputSchema: {
    type: "object",
    properties: { viaId: { type: "string" }, x: point, y: point, via: { type: "string" } },
    required: ["viaId"],
    additionalProperties: false
  },
  annotations: { readOnlyHint: false, destructiveHint: false },
  run: async (ctx, args) => {
    const record = await readDieRecord(ctx.dataRoot, ctx.dieId);
    const viaId = str(args, "viaId");
    const x = num(args, "x", true);
    const y = num(args, "y", true);
    const via = args.via === undefined ? undefined : viaLayer(args.via, layerStackOf(record, await readAnnotations(ctx.dataRoot, ctx.dieId)));
    if (x === undefined && y === undefined && via === undefined) {
      throw new ToolInputError(`Nothing to change: pass x, y and/or via`);
    }
    return write(ctx, "wires", (annotations, state) => {
      const current = requireOwnedVia(annotations, state, viaId);
      const g = current.geometry as { x: number; y: number };
      const p = { x: Math.round(x ?? g.x), y: Math.round(y ?? g.y) };
      assertOnDie(record, [p]);
      const next: HumanAnnotation = {
        ...current,
        geometry: { kind: "point", ...p },
        ...(via !== undefined ? { layer: via } : {})
      };
      return {
        tool: "update_via",
        summary: `Edit via ${next.layer ?? ""} at ${p.x}, ${p.y}`,
        items: [{ collection: "annotations", id: viaId, after: next }]
      };
    });
  }
};

const deleteVia: ToolDef = {
  name: "delete_via",
  title: "Delete via",
  description: "Delete a via this MCP client placed. Requires \"Allow wire edits\".",
  inputSchema: {
    type: "object",
    properties: { viaId: { type: "string" } },
    required: ["viaId"],
    additionalProperties: false
  },
  annotations: { readOnlyHint: false, destructiveHint: true },
  run: async (ctx, args) => {
    const viaId = str(args, "viaId");
    return write(ctx, "wires", (annotations, state) => {
      const via = requireOwnedVia(annotations, state, viaId);
      return {
        tool: "delete_via",
        summary: `Delete via ${via.layer ?? ""}`,
        items: [{ collection: "annotations", id: viaId, after: null }]
      };
    });
  }
};

export const WIRE_TOOLS: ToolDef[] = [findWiresNear, addWire, updateWire, deleteWire, addVia, updateVia, deleteVia];
