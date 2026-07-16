import { useCallback, useEffect, useRef, useState } from "react";
import type { AnnotationNet, DieAnnotations } from "shared";
import { netChangesToAction, type ActionDispatcher } from "../../api/actions";
import {
  closestPointOnSegment,
  orthoElbow,
  snapTo45,
  type Point
} from "../../lib/geometry";
import {
  VIA_DEFAULT_SIZE,
  viaSnapTolerance
} from "../../renderer/annotations/style";
import { isTypingTarget } from "../../lib/keyboard";
import type { LiveValue } from "../../lib/liveValue";
import {
  commitDraft,
  connectToNode,
  parseNetPartId,
  splitEdgeAtPoint,
  type DrawAnchor,
  type NetChange,
  type SegLayer
} from "../../lib/netGraph";
import type {
  AnnotationHit,
  AnnotationLayer
} from "../../renderer/layers/AnnotationLayer";
import type { Viewport } from "../../renderer/types";
import { useDieViewerStore, type ToolKind } from "../../state/dieViewer";
import { useSession, DEFAULT_METAL_STACK } from "../../state/session";
import type { WirePreview } from "./WireDraftOverlay";
import type { WireLayer, MetalStack } from "shared";
import { uuid } from "../../lib/uuid";

// ── Metal-stack helpers ────────────────────────────────────────

/** Resolve activeMetalId → layer name from the current metal stack. */
function activeLayer(): WireLayer | null {
  const stack = useSession.getState().metalStack ?? DEFAULT_METAL_STACK;
  const id = useDieViewerStore.getState().activeMetalId;
  if (!id) return null;
  const m = stack.metals.find(m => m.id === id);
  return (m?.layer ?? null) as WireLayer | null;
}

/** Get the current active metal id from the store. */
function activeMetalId(): string | null {
  return useDieViewerStore.getState().activeMetalId;
}

/** Collect all distinct edge layers at a net vertex. */
function getEdgeLayersAtVertex(
  nets: AnnotationNet[],
  netId: string,
  nodeId: string,
): Set<string | undefined> {
  const layers = new Set<string | undefined>();
  for (const net of nets) {
    if (net.id !== netId) continue;
    for (const edge of net.edges) {
      if (edge.from === nodeId || edge.to === nodeId) {
        layers.add(edge.layer);
      }
    }
  }
  return layers;
}

/** Find a via in the metal stack that connects `fromId` to `toId`. */
function viaBetween(stack: MetalStack, fromId: string, toId: string): { id: string } | undefined {
  return stack.vias.find(
    v => (v.from === fromId && v.to === toId) || (v.from === toId && v.to === fromId),
  );
}

/** Check if two metal ids are adjacent in the stack (z diff = 1). */
function areAdjacent(stack: MetalStack, aId: string, bId: string): boolean {
  const a = stack.metals.find(m => m.id === aId);
  const b = stack.metals.find(m => m.id === bId);
  if (!a || !b) return false;
  return Math.abs(a.z - b.z) === 1;
}

/** Click tolerance in CSS pixels — world tolerance is this divided by zoom. */
export const HIT_TOLERANCE_PX = 4;

/** Tolerance for snapping to a cell terminal (world px at the current zoom).
 *  Slightly larger than the vertex tolerance so the user can feel the snap
 *  area around a terminal without having to be pixel-accurate. */
export const TERMINAL_SNAP_TOLERANCE_PX = 10;

export interface ResolvedNode {
  netId: string;
  nodeId: string;
  x: number;
  y: number;
}

/** A terminal snap target - the cursor is near a cell instance terminal.
 *  Committing here places a node at the terminal center so the SPICE export
 *  can match the wire to the cell port via distance. */
export interface TerminalSnapTarget {
  x: number;
  y: number;
  terminalId: string;
}

/** A point snapped onto the *body* of an existing edge — committing here
 *  splits that edge into a real vertex so the new wire taps the net. */
export interface EdgeSplitTarget {
  netId: string;
  edgeId: string;
  at: Point;
}

/** What the cursor would snap to when starting a wire: an existing vertex
 *  (`virtual: false`) or a to-be-created vertex on a wire body. */
export interface WireSnap {
  x: number;
  y: number;
  virtual: boolean;
  /** Snapped to a via (ML or manual) rather than a net vertex / wire body.
   *  Drawn with the solid snap halo, matching the multi-wire overlay. */
  via?: boolean;
  /** Snapped to a cell terminal. Drawn with the orange terminal halo. */
  terminal?: TerminalSnapTarget;
}

/** Draft polyline. `segLayers[i]` is the conductor layer of the segment
 *  `points[i] → points[i+1]` (length always `points.length - 1`). */
export interface WireDraft {
  points: Point[];
  anchor: DrawAnchor | null;
  segLayers: SegLayer[];
  /** Set when the draft started on a wire body: the edge is split into a
   *  real vertex on commit so the new wire connects into that net. */
  startSplit?: EdgeSplitTarget;
}

export interface WireTool {
  /** Open a fresh draft anchored exactly at `point`. Bypasses snap/hit-test —
   *  the caller has already resolved the start (e.g. a context-menu "start
   *  wiring from this via" or a double-click on a via point). When `anchor`
   *  is non-null, the draft extends that existing net rather than starting a
   *  fresh one. Discards any in-progress draft (user explicitly asked to
   *  start fresh) — the abandoned points are not committed. */
  beginDraftAt: (point: Point, anchor: DrawAnchor | null) => void;
  /** In-progress polyline (null when idle). */
  draft: WireDraft | null;
  /** Latest committed nets (for the pointer-down router's vertex drag). */
  netsRef: React.RefObject<AnnotationNet[]>;
  /** Resolve a hit to an existing net vertex (connect / anchor / snap). */
  nodeFromHit: (hit: AnnotationHit | null) => ResolvedNode | null;
  /** Pre-start hover: what a click here would start on — an existing vertex
   *  or a virtual vertex on a wire body (null = empty space). */
  resolveWireSnap: (world: Point) => WireSnap | null;
  /** Nearest existing net vertex to snap to, applying "vertex beats via"
   *  precedence. `via` is the via the cursor would otherwise snap to (if any),
   *  so a vertex sitting under a via still wins. Shared with the multi-wire
   *  tool. */
  snapVertex: (world: Point, zoom: number, via: Point | null) => ResolvedNode | null;
  /** Wire-tool click: start / extend / connect. */
  addWirePoint: (world: Point, shift: boolean) => void;
  /** Finish the wire. `dropLast` drops the spurious double-click point. */
  commitWire: (opts?: { dropLast?: boolean }) => void;
  /** Recompute the rubber-band preview for the current cursor. */
  computeWirePreview: (world: Point, shiftKey: boolean, zoom: number) => void;
  /**
   * Extend the draft with a free-placed point (no snapping).
   * Returns the rounded point, or null if no draft is active.
   * Used by the via-insertion hotkeys (E/Q) to place a
   * layer-transition via mid-wire.
   */
  insertDraftPoint: (world: Point) => Point | null;
}

/**
 * The wire draw/edit machine: transient draft polyline, snap-to-45 / snap-to-
 * vertex with orthogonal connect, commit → `upsertNet`/`batch` actions, plus
 * the global keyboard map (per-point draw undo/redo, Esc/Enter, delete with
 * graph-split, and app-wide ⌘Z/⌘⇧Z when not drawing). Drawing stays local
 * until committed so it never re-renders the page or thrashes the index.
 */
export function useWireTool(opts: {
  dispatcher: ActionDispatcher;
  annotationLayer: AnnotationLayer | null;
  annotations: DieAnnotations | undefined;
  viewportLive: LiveValue<Viewport | null>;
  wirePreviewLive: LiveValue<WirePreview | null>;
  activeTool: ToolKind;
  setActiveTool: (tool: ToolKind) => void;
  /** Resolve the cursor to the nearest via (manual + ML) within `tolWorld`
   *  world px, or null. Optional — when absent, snap-to-vias does nothing. */
  findNearestVia?: (world: Point, tolWorld: number) => Point | null;
  /** First via lying on the open segment `a`–`b` within `perpTol` world px of
   *  the line (foot closest to `a` wins). Optional — when absent, the
   *  auto-end-on-via path is a no-op. */
  findViaOnSegment?: (a: Point, b: Point, perpTol: number) => Point | null;
  /** Live getter for the "Snap to vias" pref so flipping it takes effect on
   *  the next render without re-binding the hook. Default = off. */
  snapToViasEnabled?: () => boolean;
  /** Live getter for the "Auto-end on via" pref. When true, a via touched by
   *  the projected wire segment forces the endpoint there and commits the
   *  wire. Default = off. */
  autoEndOnViaEnabled?: () => boolean;
  /** Live getter for the via radius (world px). Drives the snap tolerance:
   *  the snap area equals the rendered via dot's radius, so clicks inside
   *  the visible via always land on it. */
  getViaSizeWorld?: () => number;
  /** Nearest cell-instance terminal within `tolWorld` world px of the cursor.
   *  Returns the centre point and a unique terminal id for visual feedback.
   *  Optional — when absent, terminal snapping is disabled. */
  findNearestTerminal?: (world: Point, tolWorld: number) => TerminalSnapTarget | null;
  /** Live getter for the "Auto-end on contact" pref. When true, clicking on
   *  a cell terminal (orange halo) commits the wire immediately. Default = on. */
  autoEndOnContactEnabled?: () => boolean;
  /** Find a via annotation (manual, with layer) near `world` within `tolWorld`.
   *  Returns the via layer id and centre point, or null. Used for cross-layer
   *  snap detection and auto-via placement. */
  findViaAnnotation?: (world: Point, tolWorld: number) => { viaId: string; x: number; y: number } | null;
  /** Live getter for the "Auto-via" pref. When enabled, clicking a vertex on
   *  an adjacent metal auto-places the via and connects. Default = off. */
  autoViaEnabled?: () => boolean;
}): WireTool {
  const {
    dispatcher,
    annotationLayer,
    annotations,
    viewportLive,
    wirePreviewLive,
    activeTool,
    setActiveTool,
    findNearestVia,
    findViaOnSegment,
    snapToViasEnabled,
    autoEndOnViaEnabled,
    getViaSizeWorld,
    findNearestTerminal,
    autoEndOnContactEnabled,
    findViaAnnotation,
    autoViaEnabled
  } = opts;
  // Mirror the snap providers into a ref so callbacks don't re-bind every
  // render (would invalidate downstream useEffects + churn React Query).
  const snapRef = useRef({
    findNearestVia,
    findViaOnSegment,
    snapToViasEnabled,
    autoEndOnViaEnabled,
    getViaSizeWorld,
    findNearestTerminal,
    findViaAnnotation,
    autoViaEnabled,
  });
  snapRef.current = {
    findNearestVia,
    findViaOnSegment,
    snapToViasEnabled,
    autoEndOnViaEnabled,
    getViaSizeWorld,
    findNearestTerminal,
    findViaAnnotation,
    autoViaEnabled,
  };

  /** Try the via-snap path: return the snapped point if the pref is on and
   *  a via lies within the (zoom-adjusted) via radius of `world`. Tolerance
   *  matches the rendered dot — see `viaSnapTolerance`.
   *
   *  Layer-aware: when a manual via annotation with a known layer is found,
   *  the snap only succeeds if the current wire metal is one of the via's
   *  connected metals. ML vias (no layer) are always allowed. */
  const viaSnap = useCallback((world: Point, zoom: number): Point | null => {
    const { findNearestVia, findViaAnnotation, snapToViasEnabled, getViaSizeWorld } = snapRef.current;
    if (!findNearestVia || !snapToViasEnabled?.()) return null;
    const worldR = getViaSizeWorld?.() ?? VIA_DEFAULT_SIZE;
    const tol = viaSnapTolerance(zoom, worldR);
    const snapped = findNearestVia(world, tol);
    if (!snapped) return null;

    const currentId = activeMetalId();
    if (!currentId) return snapped; // no active metal → legacy, allow

    // Check if this snapped point is a manual via with a known layer
    const ann = findViaAnnotation?.(snapped, 2); // tight tolerance to match exactly
    if (ann) {
      const stack = useSession.getState().metalStack ?? DEFAULT_METAL_STACK;
      const viaDef = stack.vias.find(v => v.id === ann.viaId);
      if (viaDef && viaDef.from !== currentId && viaDef.to !== currentId) {
        return null; // via's metals don't include current → reject
      }
    }
    // ML vias (no layer) or compatible via → allow
    return snapped;
  }, []);

  /** Auto-end-on-via probe: when the pref is on, return the first via lying on
   *  the projected (45°-snapped) segment from `last` toward `world`, or null.
   *  Shift bypasses (free wiring is never auto-ended). Used by both the click
   *  commit and the live preview so they show identical landing points. */
  const viaOnProjection = useCallback(
    (last: Point, world: Point, zoom: number, shift: boolean): Point | null => {
      const { findViaOnSegment, autoEndOnViaEnabled, getViaSizeWorld } =
        snapRef.current;
      if (shift || !findViaOnSegment || !autoEndOnViaEnabled?.()) return null;
      const end = snapTo45(last, world);
      if (end.x === last.x && end.y === last.y) return null;
      const tol = viaSnapTolerance(zoom, getViaSizeWorld?.() ?? VIA_DEFAULT_SIZE);
      return findViaOnSegment(last, end, tol);
    },
    []
  );

  /** Nearest cell terminal within the zoom-adjusted tolerance. Returns the
   *  terminal centre and its unique id so the overlay can paint the orange
   *  terminal halo instead of the blue vertex ring. Applied after vertex / 
   *  edge-split and before via — the user already sees the wire body via the
   *  virtual vertex marker, so a terminal under that wire doesn't confuse. */
  const resolveTerminalSnap = useCallback(
    (world: Point, zoom: number): TerminalSnapTarget | null => {
      // Only snap to device terminals when the bottom metal is selected.
      // Upper metals require a via to reach the contact — don't lure the user
      // into drawing an illegal connection.
      const stack = useSession.getState().metalStack ?? DEFAULT_METAL_STACK;
      const firstMetalLayer = stack.metals[0]?.layer;
      const layer = activeLayer();
      if (layer && firstMetalLayer && layer !== firstMetalLayer) return null;
      const { findNearestTerminal } = snapRef.current;
      if (!findNearestTerminal) return null;
      const tol = TERMINAL_SNAP_TOLERANCE_PX / zoom;
      return findNearestTerminal(world, tol);
    },
    []
  );

  const [draft, setDraft] = useState<WireDraft | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  // Each undone point remembers the layer of the segment that reached it, so
  // redo restores it exactly.
  const draftRedoRef = useRef<{ point: Point; layer: SegLayer }[]>([]);
  const netsRef = useRef<AnnotationNet[]>([]);
  netsRef.current = annotations?.nets ?? [];

  const nodeFromHit = useCallback(
    (hit: AnnotationHit | null): ResolvedNode | null => {
      if (!hit) return null;
      const parsed = parseNetPartId(hit.partId);
      if (!parsed || parsed.part !== "node" || !parsed.partId) return null;
      const net = netsRef.current.find((n) => n.id === parsed.netId);
      const node = net?.nodes.find((nd) => nd.id === parsed.partId);
      if (!net || !node) return null;
      return { netId: net.id, nodeId: node.id, x: node.x, y: node.y };
    },
    []
  );

  /** Closest committed net vertex within `tolWorld` of `p`. Scans net data
   *  directly (not via `hitTest`) so a vertex hidden under a higher-priority
   *  annotation — e.g. a via drawn on top of it — is still found. */
  const nearestNode = useCallback(
    (p: Point, tolWorld: number): ResolvedNode | null => {
      let best: ResolvedNode | null = null;
      let bestD = tolWorld;
      for (const net of netsRef.current) {
        for (const nd of net.nodes) {
          const d = Math.hypot(nd.x - p.x, nd.y - p.y);
          if (d <= bestD) {
            bestD = d;
            best = { netId: net.id, nodeId: nd.id, x: nd.x, y: nd.y };
          }
        }
      }
      return best;
    },
    []
  );

  /** Resolve an existing net vertex to snap to, enforcing "vertex beats via":
   *  when via snapping is on, the vertex search radius is widened to the via
   *  tolerance, and a vertex sitting under `via` (even one larger than the
   *  vertex dot) is caught too — so the wire joins the existing net instead of
   *  starting a disconnected one beside it. `widen` is false under Shift (free
   *  placement), where only an exact hit should connect.
   *
   *  Layer compatibility: if the current wire layer differs from the vertex's
   *  edge layers, the snap is rejected unless a via annotation (matching the
   *  two metals) lies within tolerance. When autoVia is enabled and the metals
   *  are adjacent, the snap is allowed and the caller is expected to place the
   *  via (the returned node carries `autoViaId`). */
  const snapNode = useCallback(
    (
      cursor: Point,
      via: Point | null,
      zoom: number,
      widen: boolean
    ): (ResolvedNode & { autoViaId?: string }) | null => {
      const hitTol = HIT_TOLERANCE_PX / zoom;
      if (!widen) return nearestNode(cursor, hitTol);
      const { snapToViasEnabled, getViaSizeWorld, findViaAnnotation, autoViaEnabled } = snapRef.current;
      const viaTol = snapToViasEnabled?.()
        ? viaSnapTolerance(zoom, getViaSizeWorld?.() ?? VIA_DEFAULT_SIZE)
        : 0;
      const searchTol = Math.max(hitTol, viaTol);
      const byCursor = nearestNode(cursor, searchTol);
      if (byCursor) return byCursor;
      return via ? nearestNode(via, viaTol) : null;
    },
    [nearestNode]
  );

  /** Check layer compatibility between the current wire metal and a vertex.
   *  Returns the vertex if compatible, or an autoVia marker, or null to reject.
   *  Separated so `addWirePoint` can use it before making the snap decision. */
  const checkLayerCompat = useCallback(
    (node: ResolvedNode, zoom: number): (ResolvedNode & { autoViaId?: string }) | null => {
      const currentId = activeMetalId();
      if (!currentId) return node; // null layer → legacy, allow
      const stack = useSession.getState().metalStack ?? DEFAULT_METAL_STACK;
      const vertexLayers = getEdgeLayersAtVertex(netsRef.current, node.netId, node.nodeId);
      if (vertexLayers.size === 0) return node; // no edges → legacy, allow
      if (vertexLayers.has(undefined)) return node; // legacy edge without layer

      // Find what metal ids these layers correspond to
      const vertexMetalIds = new Set<string>();
      for (const l of vertexLayers) {
        if (l) {
          const m = stack.metals.find(m => m.layer === l);
          if (m) vertexMetalIds.add(m.id);
        }
      }
      if (vertexMetalIds.has(currentId)) return node; // same metal → allow

      // Different metals: need a via
      const { findViaAnnotation, autoViaEnabled: autoVia } = snapRef.current;
      const autoOn = autoVia?.() ?? false;

      // Check if auto-via is possible (adjacent metals)
      for (const vId of vertexMetalIds) {
        const via = viaBetween(stack, currentId, vId);
        if (!via) continue;
        if (!areAdjacent(stack, currentId, vId)) continue;
        // Adjacent → check if existing via annotation nearby
        const viaTol = viaSnapTolerance(zoom, 15);
        const existing = findViaAnnotation?.(node, viaTol);
        if (existing) return node; // via already exists → allow
        if (autoOn) return { ...node, autoViaId: via.id }; // auto-via → allow + flag
      }
      return null; // no compatible via → reject
    },
    [],
  );

  const snapVertex = useCallback(
    (world: Point, zoom: number, via: Point | null): ResolvedNode | null =>
      snapNode(world, via, zoom, true),
    [snapNode]
  );

  /** Resolve a hit on a wire *body* to the point on that edge closest to the
   *  cursor (the future split vertex). Vertices are handled by `nodeFromHit`
   *  and win in `hitTest`, so this only fires on bare segments. */
  const edgeSplitFromHit = useCallback(
    (hit: AnnotationHit | null, world: Point): EdgeSplitTarget | null => {
      if (!hit) return null;
      const parsed = parseNetPartId(hit.partId);
      if (!parsed || parsed.part !== "edge" || !parsed.partId) return null;
      const net = netsRef.current.find((n) => n.id === parsed.netId);
      const edge = net?.edges.find((e) => e.id === parsed.partId);
      if (!net || !edge) return null;
      const a = net.nodes.find((n) => n.id === edge.from);
      const b = net.nodes.find((n) => n.id === edge.to);
      if (!a || !b) return null;
      const c = closestPointOnSegment(world, a, b);
      return {
        netId: net.id,
        edgeId: edge.id,
        at: { x: Math.round(c.x), y: Math.round(c.y) }
      };
    },
    []
  );

  const resolveWireSnap = useCallback(
    (world: Point): WireSnap | null => {
      const vp = viewportLive.get();
      if (!vp || !annotationLayer) return null;
      const hit = annotationLayer.hitTest(world, HIT_TOLERANCE_PX / vp.zoom);
      // Vertex beats via: an existing vertex wins even when it's beyond the
      // bare hit tolerance or hidden under a via, so the wire stays connected.
      const via = viaSnap(world, vp.zoom);
      const node = snapNode(world, via, vp.zoom, true);
      if (node) return { x: node.x, y: node.y, virtual: false };
      const edge = edgeSplitFromHit(hit, world);
      if (edge) return { x: edge.at.x, y: edge.at.y, virtual: true };
      // Cell terminal snap: before via so a terminal near a via gets the
      // terminal halo (orange) instead of the via halo (blue). The terminal
      // marks a deliberate connection point; the via is just passing through.
      const terminal = resolveTerminalSnap(world, vp.zoom);
      if (terminal) return { x: terminal.x, y: terminal.y, virtual: false, terminal };
      // Via snap is the lowest-priority preview: only kicks in when there's
      // no existing wire to anchor to. Flagged `via` so the overlay draws the
      // solid snap halo (same as the multi-wire tool), not the edge-split
      // dashed marker.
      if (via) return { x: via.x, y: via.y, virtual: true, via: true };
      return null;
    },
    [annotationLayer, viewportLive, edgeSplitFromHit, viaSnap, snapNode, resolveTerminalSnap]
  );

  /** Run a net-graph edit, transparently splitting the start edge first when
   *  the draft began on a wire body. The recorded change keeps the *original*
   *  (pre-split) net as `prev`, so a single undo restores everything. */
  const buildAction = useCallback(
    (
      d: WireDraft,
      build: (nets: AnnotationNet[], anchor: DrawAnchor | null) => NetChange[]
    ) => {
      const split = d.startSplit;
      if (split) {
        const orig = netsRef.current.find((n) => n.id === split.netId);
        const done = orig && splitEdgeAtPoint(orig, split.edgeId, split.at);
        if (orig && done) {
          const working = netsRef.current.map((n) =>
            n.id === orig.id ? done.net : n
          );
          const changes = build(working, {
            netId: orig.id,
            nodeId: done.nodeId
          }).map((c) =>
            c.prev && c.prev.id === orig.id ? { ...c, prev: orig } : c
          );
          return netChangesToAction(changes);
        }
      }
      return netChangesToAction(build(netsRef.current, d.anchor));
    },
    []
  );

  const clearDraft = useCallback(() => {
    draftRedoRef.current = [];
    wirePreviewLive.set(null);
    setDraft(null);
  }, [wirePreviewLive]);

  const commitWire = useCallback(
    (cfg?: { dropLast?: boolean }) => {
      const d = draftRef.current;
      if (d) {
        // double-click finish: the dbl-click's 2nd click added a spurious
        // (snap-45) point near the cursor — drop it (and its segment) first.
        const drop = cfg?.dropLast && d.points.length > 1;
        const pts = drop ? d.points.slice(0, -1) : d.points;
        const segs = drop ? d.segLayers.slice(0, -1) : d.segLayers;
        const action = buildAction(d, (nets, anchor) =>
          commitDraft(nets, pts, anchor, segs)
        );
        if (action) void dispatcher.dispatch(action);
      }
      clearDraft();
    },
    [dispatcher, clearDraft, buildAction]
  );

  const addWirePoint = useCallback(
    (world: Point, shift: boolean) => {
      const vp = viewportLive.get();
      if (!vp || !annotationLayer) return;
      const hit = annotationLayer.hitTest(world, HIT_TOLERANCE_PX / vp.zoom);
      const d = draftRef.current;
      // Layer active right now — applied to whatever segment(s) this click
      // creates, so switching layer mid-draw only affects new segments.
      const layer = activeLayer();

      if (!d) {
        draftRedoRef.current = [];
        // Vertex beats terminal beats via: snap the start to an existing
        // vertex (even one hidden under a via) so the new wire extends that
        // net.
        const via = viaSnap(world, vp.zoom);
        const rawNode = snapNode(world, via, vp.zoom, true);
        if (rawNode) {
          // Check layer compatibility (cross-metal via detection)
          const compat = checkLayerCompat(rawNode, vp.zoom);
          if (!compat) {
            // Start a separate disconnected wire
            const start = via
              ? { x: Math.round(via.x), y: Math.round(via.y) }
              : world;
            setDraft({ points: [start], anchor: null, segLayers: [] });
            return;
          }
          setDraft({
            points: [{ x: compat.x, y: compat.y }],
            anchor: { netId: compat.netId, nodeId: compat.nodeId },
            segLayers: []
          });
          // AutoVia: place via annotation at the snap point
          if (compat.autoViaId) {
            dispatcher.dispatch({
              kind: "upsertAnnotation",
              annotation: {
                id: uuid(), class: "point_via",
                layer: compat.autoViaId,
                geometry: { kind: "point", x: compat.x, y: compat.y },
                source: "human"
              },
              prevAnnotation: null
            });
          }
          return;
        }
        // Started on a wire body → a virtual vertex that splits that edge on
        // commit, so the new wire taps into the existing net.
        const split = edgeSplitFromHit(hit, world);
        if (split) {
          setDraft({
            points: [{ x: split.at.x, y: split.at.y }],
            anchor: null,
            segLayers: [],
            startSplit: split
          });
          return;
        }
        // Cell terminal: start the wire at the terminal centre. No net
        // anchor — the SPICE export matches the wire to the terminal by
        // distance. The wire node is placed right at the terminal centre so
        // the match is exact.
        const terminal = resolveTerminalSnap(world, vp.zoom);
        if (terminal) {
          setDraft({
            points: [{ x: terminal.x, y: terminal.y }],
            anchor: null,
            segLayers: []
          });
          return;
        }
        // No wire / vertex / terminal to anchor into → optionally pin the
        // start to a nearby via (ML or manual).
        const start = via
          ? { x: Math.round(via.x), y: Math.round(via.y) }
          : world;
        setDraft({ points: [start], anchor: null, segLayers: [] });
        return;
      }

      // Extend. The via search runs on the 45°-projected position so the user
      // can be slightly off-axis and still catch a via near it. The vertex
      // search (widened to the via radius unless Shift frees placement) then
      // takes precedence over that via.
      const last = d.points[d.points.length - 1];
      // Auto-end-on-via wins over both vertex and cursor-via snap when the
      // projected segment crosses a via — the user opted in to "snap to vias
      // I'm aiming past". The draft stays live so the next click continues
      // the wire from this via centre; Enter/dbl-click ends as usual.
      // (Multi-wire's auto-end batch-commits the bus because each wire only
      // gets one endpoint — here the user may want to chain more segments.)
      const autoEndVia = viaOnProjection(last, world, vp.zoom, shift);
      if (autoEndVia) {
        const point = {
          x: Math.round(autoEndVia.x),
          y: Math.round(autoEndVia.y)
        };
        draftRedoRef.current = [];
        setDraft({
          points: [...d.points, point],
          anchor: d.anchor,
          segLayers: [...d.segLayers, layer],
          startSplit: d.startSplit
        });
        return;
      }
      // Terminal snap: when auto-end-on-contact is on, snap the endpoint
      // to the terminal centre and commit. Otherwise fall through to
      // via/vertex/free placement.
      if (snapRef.current.autoEndOnViaEnabled?.()) {
        const terminal = resolveTerminalSnap(world, vp.zoom);
        if (terminal) {
          const point = { x: terminal.x, y: terminal.y };
          draftRedoRef.current = [];
          const action = buildAction(d, (nets, anchor) =>
            commitDraft(nets, [...d.points, point], anchor, [...d.segLayers, layer])
          );
          if (action) void dispatcher.dispatch(action);
          clearDraft();
          return;
        }
      }
      const snapped45 = snapTo45(last, world);
      const via = shift ? null : viaSnap(snapped45, vp.zoom);
      const rawNode = snapNode(world, via, vp.zoom, !shift);
      if (rawNode) {
        // Check layer compatibility (cross-metal via detection)
        const compat = checkLayerCompat(rawNode, vp.zoom);
        if (compat) {
          // Connect with an axis-aligned L (two 90° segments) into the vertex,
          // unless the free-wiring hotkey (Shift) bypasses it.
          let pts = d.points;
          let segs = d.segLayers;
          if (!shift) {
            const elbow = orthoElbow(last, { x: compat.x, y: compat.y });
            if (elbow) {
              pts = [...d.points, elbow];
              segs = [...d.segLayers, layer];
            }
          }
          const action = buildAction(d, (nets, anchor) =>
            connectToNode(
              nets,
              pts,
              anchor,
              compat.netId,
              compat.nodeId,
              segs,
              layer
            )
          );
          if (action) void dispatcher.dispatch(action);
          clearDraft();
          // AutoVia: place via annotation at the snap point
          if (compat.autoViaId) {
            dispatcher.dispatch({
              kind: "upsertAnnotation",
              annotation: {
                id: uuid(), class: "point_via",
                layer: compat.autoViaId,
                geometry: { kind: "point", x: compat.x, y: compat.y },
                source: "human"
              },
              prevAnnotation: null
            });
          }
          return;
        }
      }

      const point = shift
        ? world
        : via
          ? { x: Math.round(via.x), y: Math.round(via.y) }
          : snapped45;
      draftRedoRef.current = [];
      setDraft({
        points: [...d.points, point],
        anchor: d.anchor,
        segLayers: [...d.segLayers, layer],
        startSplit: d.startSplit
      });
    },
    [
      annotationLayer,
      dispatcher,
      clearDraft,
      edgeSplitFromHit,
      buildAction,
      viewportLive,
      viaSnap,
      viaOnProjection,
      snapNode,
      resolveTerminalSnap
    ]
  );

  const beginDraftAt = useCallback(
    (point: Point, anchor: DrawAnchor | null) => {
      // Always discard any in-flight preview / partial draft — the caller
      // explicitly invoked "start a wire here", so an abandoned partial isn't
      // what they want kept.
      draftRedoRef.current = [];
      wirePreviewLive.set(null);
      setDraft({
        points: [{ x: Math.round(point.x), y: Math.round(point.y) }],
        anchor,
        segLayers: []
      });
    },
    [wirePreviewLive]
  );

  const undoDraftPoint = useCallback(() => {
    const d = draftRef.current;
    if (!d) return;
    if (d.points.length <= 1) {
      clearDraft();
      return;
    }
    const point = d.points[d.points.length - 1];
    const layer = d.segLayers[d.segLayers.length - 1] ?? null;
    draftRedoRef.current = [{ point, layer }, ...draftRedoRef.current];
    setDraft({
      points: d.points.slice(0, -1),
      anchor: d.anchor,
      segLayers: d.segLayers.slice(0, -1),
      startSplit: d.startSplit
    });
  }, [clearDraft]);

  const redoDraftPoint = useCallback(() => {
    const d = draftRef.current;
    if (!d || draftRedoRef.current.length === 0) return;
    const [restored, ...rest] = draftRedoRef.current;
    draftRedoRef.current = rest;
    setDraft({
      points: [...d.points, restored.point],
      anchor: d.anchor,
      segLayers: [...d.segLayers, restored.layer],
      startSplit: d.startSplit
    });
  }, []);


  const computeWirePreview = useCallback(
    (world: Point, shiftKey: boolean, zoom: number) => {
      const d = draftRef.current;
      if (
        useDieViewerStore.getState().activeTool !== "wire" ||
        !d ||
        !annotationLayer
      ) {
        return;
      }
      // Mirror `addWirePoint`'s resolution exactly so the preview matches the
      // click: auto-end-on-via first, then 45°-project, find a via near it,
      // then let a vertex win.
      const last = d.points[d.points.length - 1];
      const autoEndVia = viaOnProjection(last, world, zoom, shiftKey);
      if (autoEndVia) {
        wirePreviewLive.set({
          x: Math.round(autoEndVia.x),
          y: Math.round(autoEndVia.y),
          onNode: false,
          onVia: true
        });
        return;
      }
      const snapped45 = snapTo45(last, world);
      const via = shiftKey ? null : viaSnap(snapped45, zoom);
      const rawNode = snapNode(world, via, zoom, !shiftKey);
      const node = rawNode ? checkLayerCompat(rawNode, zoom) : null;
      let preview: WirePreview;
      if (node) {
        const elbow = shiftKey ? null : orthoElbow(last, { x: node.x, y: node.y });
        preview = { x: node.x, y: node.y, onNode: true, elbow: elbow ?? undefined };
      } else if (shiftKey) {
        preview = { ...world, onNode: false };
      } else {
        // Cell terminal: before via so the orange terminal halo appears in
        // preference to the blue via halo — the terminal is a deliberate
        // connection target.
        const terminal = resolveTerminalSnap(world, zoom);
        if (terminal) {
          preview = {
            x: terminal.x,
            y: terminal.y,
            onNode: false,
            onTerminal: terminal
          };
        } else if (via) {
          preview = {
            x: Math.round(via.x),
            y: Math.round(via.y),
            onNode: false,
            onVia: true
          };
        } else {
          preview = { ...snapped45, onNode: false };
        }
      }
      wirePreviewLive.set(preview);
    },
    [annotationLayer, wirePreviewLive, viaSnap, viaOnProjection, snapNode, resolveTerminalSnap]
  );

  /**
   * Extend the draft with a free-placed point (no snapping).
   * The caller is responsible for creating a via annotation and
   * switching the wire layer. Returns the rounded point, or null
   * if no draft is active.
   */
  const insertDraftPoint = useCallback(
    (world: Point): Point | null => {
      const d = draftRef.current;
      if (!d) return null;
      const point = { x: Math.round(world.x), y: Math.round(world.y) };
      const layer = activeLayer();
      draftRedoRef.current = [];
      setDraft({
        points: [...d.points, point],
        anchor: d.anchor,
        segLayers: [...d.segLayers, layer],
        startSplit: d.startSplit,
      });
      return point;
    },
    []
  );

  // Leaving the wire tool abandons any uncommitted draft.
  useEffect(() => {
    if (activeTool !== "wire" && draftRef.current) clearDraft();
  }, [activeTool, clearDraft]);

  // While a draft is in progress, claim the global ⌘Z/⌘⇧Z so it does
  // per-point draw undo/redo instead of the action-level undo. Cleared the
  // moment the draft ends (commit / abort / tool change).
  const drafting = draft != null;
  const setUndoOverride = useDieViewerStore((s) => s.setUndoOverride);
  useEffect(() => {
    if (!drafting) return;
    setUndoOverride({ undo: undoDraftPoint, redo: redoDraftPoint });
    return () => setUndoOverride(null);
  }, [drafting, undoDraftPoint, redoDraftPoint, setUndoOverride]);

  // Keyboard: wire-draft shortcuts (Esc / Enter). ⌘Z is handled globally by
  // `useUndoRedoHotkeys` (via the override above); Delete by
  // `useSelectionDelete`.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;

      if (e.key === "Escape") {
        if (draftRef.current) {
          // Abort the whole in-progress wire — discard the partial draft.
          clearDraft();
        } else if (useDieViewerStore.getState().activeTool === "wire") {
          setActiveTool("select");
        } else if (useDieViewerStore.getState().selectedIds.size > 0) {
          useDieViewerStore.getState().clearSelection();
        }
        return;
      }

      if (e.key === "Enter" && draftRef.current) {
        e.preventDefault();
        commitWire();
      }
      // Delete/Backspace is handled by `useSelectionDelete` (kind-agnostic).
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [commitWire, clearDraft, setActiveTool]);

  return {
    beginDraftAt,
    draft,
    netsRef,
    nodeFromHit,
    resolveWireSnap,
    snapVertex,
    addWirePoint,
    commitWire,
    computeWirePreview,
    insertDraftPoint
  };
}
