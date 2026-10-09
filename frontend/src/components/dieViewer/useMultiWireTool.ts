import { useCallback, useEffect, useRef, useState } from "react";
import type { AnnotationNet, DieAnnotations } from "shared";
import type { ActionDispatcher, AnnotationAction } from "../../api/actions";
import { distancePointToSegment, type Point } from "../../lib/geometry";
import { constrainPoint } from "../../lib/angleConstraint";
import { currentAngleMode } from "../../state/angleMode";
import { isTypingTarget } from "../../lib/keyboard";
import type { DrawAnchor } from "../../lib/netGraph";
import { useDieViewerStore, type ToolKind } from "../../state/dieViewer";
import { useSession, DEFAULT_METAL_STACK } from "../../state/session";
import { uuid } from "../../lib/uuid";
import type { WireLayer } from "shared";

function activeLayer(): WireLayer | null {
  const stack = useSession.getState().metalStack ?? DEFAULT_METAL_STACK;
  const id = useDieViewerStore.getState().activeMetalId;
  if (!id) return null;
  const m = stack.metals.find(m => m.id === id);
  return (m?.layer ?? null) as WireLayer | null;
}

/** Phase-2 endpoint for the reference start point. Constrained to the wire
 *  angle mode (default 45° steps, see state/angleMode); `free` (Shift held)
 *  lets the bus take any angle. Every wire
 *  uses the same delta (end − ref) so they stay parallel. */
export function multiParallelEnd(
  ref: Point,
  world: Point,
  free = false
): Point {
  if (free) return { x: Math.round(world.x), y: Math.round(world.y) };
  return constrainPoint(ref, world, currentAngleMode("wire"));
}

/** Endpoint of a wire that starts at `start` and travels parallel to the bus
 *  direction (`ref` → `busEnd`), stopped at the common front line that runs
 *  perpendicular to that direction through `busEnd`. So every wire ends on the
 *  same aligned front regardless of how its start is staggered *along* the bus
 *  direction (lateral spacing is still preserved). */
export function multiWireEndpoint(
  start: Point,
  ref: Point,
  busEnd: Point
): Point {
  const dx = busEnd.x - ref.x;
  const dy = busEnd.y - ref.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return { x: start.x, y: start.y };
  const t = ((busEnd.x - start.x) * dx + (busEnd.y - start.y) * dy) / lenSq;
  return {
    x: Math.round(start.x + dx * t),
    y: Math.round(start.y + dy * t)
  };
}

/** A bend (or locked end) of one bus wire, with the metal layer that was
 *  active when the segment leading to it was drawn. */
export interface Vertex extends Point {
  layer: WireLayer | null;
}

export interface Draft {
  /** 1 = collecting start points, 2 = routing the bus. */
  phase: 1 | 2;
  points: Point[];
  /** `anchors[i]` = the existing net vertex `points[i]` snapped to (the new
   *  segment extends that net instead of making a fresh one), else null. */
  anchors: (DrawAnchor | null)[];
  /** Phase-2: committed vertices per wire after its start (completed turn
   *  rounds, then the via end if the wire was ended). */
  paths: Vertex[][];
  /** Phase-2: wire `i` has ended (on a via); it no longer follows the bus. */
  locked: boolean[];
  /** Phase-2, current turn round: corner already clicked for wire `i`. The
   *  round completes (corners join `paths`) once every running wire has one. */
  pending: (Vertex | null)[];
  /** Direction of the current round, fixed by its first click (null until
   *  then — the bus follows the cursor, 45°-snapped). */
  dir: Point | null;
  /** Last accepted phase-2 click (to ignore a double-click's second click). */
  lastClick: Point | null;
}
const EMPTY: Draft = {
  phase: 1,
  points: [],
  anchors: [],
  paths: [],
  locked: [],
  pending: [],
  dir: null,
  lastClick: null
};

/** Fresh phase-2 draft for these starts. */
function phase2(points: Point[], anchors: (DrawAnchor | null)[]): Draft {
  return {
    phase: 2,
    points,
    anchors,
    paths: points.map(() => []),
    locked: points.map(() => false),
    pending: points.map(() => null),
    dir: null,
    lastClick: null
  };
}

/** Current tip of wire `i` (last committed vertex, else its start). Pending
 *  corners of the running round are not tips yet. */
export function tipOf(d: Pick<Draft, "points" | "paths">, i: number): Point {
  const path = d.paths[i];
  return path && path.length > 0 ? path[path.length - 1] : d.points[i];
}

/** The wire the bus direction is measured from: the first one still running. */
function refIndex(d: Pick<Draft, "locked" | "points">): number {
  return d.points.findIndex((_, i) => !d.locked[i]);
}

/** Wire `i` still waits for its corner in the current round. */
function awaiting(d: Draft, i: number): boolean {
  return !d.locked[i] && !d.pending[i];
}

/** Direction of the current round: the locked one, else 45°-snapped (Shift:
 *  free) from the reference wire's tip toward the cursor. Null when degenerate. */
export function busDirection(d: Draft, cursor: Point, free: boolean): Point | null {
  if (d.dir) return d.dir;
  const r = refIndex(d);
  if (r < 0) return null;
  const ref = tipOf(d, r);
  const target = multiParallelEnd(ref, cursor, free);
  const dir = { x: target.x - ref.x, y: target.y - ref.y };
  return dir.x === 0 && dir.y === 0 ? null : dir;
}

/** Where `cursor` falls on the line leaving `tip` along `dir` (rounded). */
function projectOnto(tip: Point, dir: Point, cursor: Point): Point {
  const t = ((cursor.x - tip.x) * dir.x + (cursor.y - tip.y) * dir.y) / (dir.x * dir.x + dir.y * dir.y);
  return { x: Math.round(tip.x + dir.x * t), y: Math.round(tip.y + dir.y * t) };
}

/** Live end of each wire still awaiting its corner (null otherwise): the
 *  cursor projected onto the wire's line, so all previews meet the line
 *  through the cursor perpendicular to the bus — they stay parallel, and each
 *  click places one wire's corner exactly where its preview ends. */
export function previewEnds(d: Draft, cursor: Point, free: boolean): (Point | null)[] {
  const dir = d.phase === 2 ? busDirection(d, cursor, free) : null;
  return d.points.map((_, i) => (dir && awaiting(d, i) ? projectOnto(tipOf(d, i), dir, cursor) : null));
}

/** Corners of the current round join the paths; the next round starts. */
function completeRound(d: Draft): Draft {
  return {
    ...d,
    paths: d.paths.map((path, i) => (d.pending[i] ? [...path, d.pending[i]!] : path)),
    pending: d.points.map(() => null),
    dir: null
  };
}

/** If every running wire has its corner, close the round. */
function maybeCompleteRound(d: Draft): Draft {
  const running = d.points.map((_, i) => i).filter((i) => !d.locked[i]);
  return running.length > 0 && running.every((i) => d.pending[i]) ? completeRound(d) : d;
}

/** Phase-2 click (staggered turns): place the corner of the waiting wire
 *  whose live line is nearest the click, where the click falls on that line.
 *  The first click of a round fixes its direction; once every running wire
 *  has its corner the bus continues from them. Null (no-op) when nothing can
 *  be placed, the corner would be shorter than `minLen`, or the click is
 *  within `minLen` of the previous one (a double-click's second click). */
export function placeCorner(
  d: Draft,
  world: Point,
  free: boolean,
  minLen: number,
  layer: WireLayer | null
): Draft | null {
  if (d.phase !== 2) return null;
  const min = Math.max(1, minLen);
  if (d.lastClick && Math.hypot(world.x - d.lastClick.x, world.y - d.lastClick.y) < min) return null;
  const dir = busDirection(d, world, free);
  if (!dir) return null;
  const ends = previewEnds(d, world, free);
  let best = -1;
  let bestDist = Infinity;
  ends.forEach((end, i) => {
    if (!end) return;
    const dist = distancePointToSegment(world, tipOf(d, i), end);
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  });
  if (best < 0) return null;
  const corner = ends[best]!;
  const tip = tipOf(d, best);
  if (Math.hypot(corner.x - tip.x, corner.y - tip.y) < min) return null;
  const pending = d.pending.slice();
  pending[best] = { ...corner, layer };
  return maybeCompleteRound({ ...d, pending, dir, lastClick: { x: world.x, y: world.y } });
}

/** End running wires on vias (`picks`). A wire's corner already clicked in
 *  this round is kept before the via. A via already holding a wire's end is
 *  skipped — two wires on one via would short them. Null if nothing changed. */
export function endBusWires(
  d: Draft,
  picks: Array<{ endpoint: Point; lockIndex: number }>,
  layer: WireLayer | null
): Draft | null {
  if (d.phase !== 2) return null;
  const paths = d.paths.slice();
  const locked = d.locked.slice();
  const pending = d.pending.slice();
  const key = (p: Point) => `${p.x},${p.y}`;
  const taken = new Set(
    d.points.flatMap((_, i) => (locked[i] && paths[i].length > 0 ? [key(tipOf(d, i))] : []))
  );
  let changed = false;
  for (const pick of picks) {
    const i = pick.lockIndex;
    if (i < 0 || i >= d.points.length || locked[i]) continue;
    const end = { x: Math.round(pick.endpoint.x), y: Math.round(pick.endpoint.y) };
    if (taken.has(key(end))) continue;
    if (pending[i]) {
      paths[i] = [...paths[i], pending[i]!];
      pending[i] = null;
    }
    const tip = tipOf({ points: d.points, paths }, i);
    if (tip.x !== end.x || tip.y !== end.y) paths[i] = [...paths[i], { ...end, layer }];
    locked[i] = true;
    taken.add(key(end));
    changed = true;
  }
  return changed ? maybeCompleteRound({ ...d, paths, locked, pending }) : null;
}

/** Finish: corners already clicked in the unfinished round are kept. */
export function closeBus(d: Draft): Draft {
  return completeRound(d);
}

/** The annotation actions committing a bus: anchored starts extend their net
 *  (several wires into one net fold into one change), free starts become new
 *  nets named after `nets.length`. Wires that never left their start are
 *  dropped. Pending corners are ignored — `closeBus` first. */
export function busActions(
  d: Draft,
  nets: AnnotationNet[],
  uid: () => string
): AnnotationAction[] {
  const mkEdge = (from: string, to: string, layer: WireLayer | null) => ({
    id: uid(),
    from,
    to,
    ...(layer ? { layer } : {})
  });
  const origByNet = new Map<string, AnnotationNet>();
  const curByNet = new Map<string, AnnotationNet>();
  const newNets: AnnotationNet[] = [];
  d.points.forEach((p, i) => {
    const path = d.paths[i] ?? [];
    if (path.length === 0) return; // never left its start
    const nodes = path.map((v) => ({ id: uid(), x: v.x, y: v.y }));
    const anchor = d.anchors[i];
    const orig = anchor ? nets.find((n) => n.id === anchor.netId) : undefined;
    const startId = anchor && orig ? anchor.nodeId : uid();
    const edges = nodes.map((n, k) =>
      mkEdge(k === 0 ? startId : nodes[k - 1].id, n.id, path[k].layer)
    );
    if (anchor && orig) {
      if (!origByNet.has(orig.id)) origByNet.set(orig.id, orig);
      const cur = curByNet.get(orig.id) ?? orig;
      curByNet.set(orig.id, {
        ...cur,
        nodes: [...cur.nodes, ...nodes],
        edges: [...cur.edges, ...edges]
      });
    } else {
      newNets.push({
        id: uid(),
        name: `Net ${nets.length + newNets.length + 1}`,
        nodes: [{ id: startId, x: p.x, y: p.y }, ...nodes],
        edges
      });
    }
  });
  return [
    ...[...curByNet.entries()].map(([id, net]) => ({
      kind: "upsertNet" as const,
      net,
      prevNet: origByNet.get(id) ?? null
    })),
    ...newNets.map((net) => ({ kind: "upsertNet" as const, net, prevNet: null }))
  ];
}

export interface MultiWireTool {
  phase: 1 | 2;
  points: Point[];
  /** The whole draft (paths, pending corners, round direction…) — for the
   *  overlay and the via-snap helpers, via `previewEnds` / `tipOf`. */
  draft: Draft;
  /** Phase-1 click → add a start point (with optional net-vertex anchor). */
  addPoint: (world: Point, anchor: DrawAnchor | null) => void;
  /** Phase-2 plain click → staggered turn: places the corner of the waiting
   *  wire nearest the click (see `placeCorner`). Once every running wire has
   *  its corner the bus continues from them. `minLen` (world px) filters
   *  out a double-click's second click. `free` (Shift) unconstrains the angle. */
  placeCorner: (world: Point, free: boolean, minLen: number) => void;
  /** Phase-2 via snap: end wire `lockIndex` on `endpoint` (a via centre). It
   *  runs straight there from its tip and stops; the rest keep going. */
  endWire: (endpoint: Point, lockIndex: number) => void;
  /** Auto-end-on-via: end several running wires at once, each on its via. */
  endWires: (picks: Array<{ endpoint: Point; lockIndex: number }>) => void;
  /** Finish the bus (Enter / double-click): corners already placed in the
   *  current round are kept, other wires end at their last corner. Wires
   *  that never left their start are dropped. One batched undo. */
  finish: () => void;
  /** Open the bus directly in phase 2 with `starts` as the per-wire origin
   *  points (anchors optional — null = the wire will become a fresh net).
   *  Used by the context-menu "Start multi-wiring from selection" entry to
   *  skip the manual click-each-start-then-Enter dance. */
  beginPhase2: (
    starts: Array<{ point: Point; anchor: DrawAnchor | null }>
  ) => void;
}

/**
 * Multi-wire (bus): phase 1 collects N start points (click); Enter advances to
 * phase 2 where the cursor sweeps N parallel 45°-aligned segments. Turns are
 * staggered: a round of N clicks places one wire's corner each, then the bus
 * keeps routing from those corners; a via snap ends just that wire. Enter / double-click finishes the whole bus as one batched undo
 * (anchored starts extend their net, free starts become new nets).
 * Contextual ⌘Z/⌘⇧Z steps through points, turns and the phase change; Esc
 * aborts.
 */
export function useMultiWireTool(opts: {
  dispatcher: ActionDispatcher;
  annotations: DieAnnotations | undefined;
  activeTool: ToolKind;
  setActiveTool: (tool: ToolKind) => void;
}): MultiWireTool {
  const { dispatcher, annotations, activeTool, setActiveTool } = opts;
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const undoRef = useRef<Draft[]>([]);
  const redoRef = useRef<Draft[]>([]);
  const netsRef = useRef<AnnotationNet[]>([]);
  netsRef.current = annotations?.nets ?? [];
  const setUndoOverride = useDieViewerStore((s) => s.setUndoOverride);

  const reset = useCallback(() => {
    undoRef.current = [];
    redoRef.current = [];
    setDraft(EMPTY);
  }, []);
  const apply = useCallback((next: Draft) => {
    undoRef.current = [...undoRef.current, draftRef.current];
    redoRef.current = [];
    setDraft(next);
  }, []);
  const undo = useCallback(() => {
    if (undoRef.current.length === 0) return;
    const prev = undoRef.current[undoRef.current.length - 1];
    undoRef.current = undoRef.current.slice(0, -1);
    redoRef.current = [draftRef.current, ...redoRef.current];
    setDraft(prev);
  }, []);
  const redo = useCallback(() => {
    if (redoRef.current.length === 0) return;
    const [next, ...rest] = redoRef.current;
    redoRef.current = rest;
    undoRef.current = [...undoRef.current, draftRef.current];
    setDraft(next);
  }, []);

  const addPoint = useCallback(
    (world: Point, anchor: DrawAnchor | null) => {
      const d = draftRef.current;
      if (d.phase !== 1) return;
      apply({
        ...d,
        points: [...d.points, { x: Math.round(world.x), y: Math.round(world.y) }],
        anchors: [...d.anchors, anchor]
      });
    },
    [apply]
  );

  const enterPhase2 = useCallback(() => {
    const d = draftRef.current;
    if (d.phase === 1 && d.points.length >= 1) {
      apply(phase2(d.points, d.anchors));
    }
  }, [apply]);

  const finalize = useCallback(
    (d: Draft) => {
      const actions = busActions(d, netsRef.current, uuid);
      if (actions.length > 0) {
        void dispatcher.dispatch(
          actions.length === 1 ? actions[0] : { kind: "batch", actions }
        );
      }
      reset();
    },
    [dispatcher, reset]
  );

  /** Apply `next`; once every wire has ended, the bus is committed. */
  const applyOrFinish = useCallback(
    (next: Draft) => {
      if (next.locked.every(Boolean)) finalize(next);
      else apply(next);
    },
    [apply, finalize]
  );

  const placeCornerCb = useCallback(
    (world: Point, free: boolean, minLen: number) => {
      const next = placeCorner(draftRef.current, world, free, minLen, activeLayer());
      if (next) apply(next);
    },
    [apply]
  );

  const endWires = useCallback(
    (picks: Array<{ endpoint: Point; lockIndex: number }>) => {
      const next = endBusWires(draftRef.current, picks, activeLayer());
      if (next) applyOrFinish(next);
    },
    [applyOrFinish]
  );

  const endWire = useCallback(
    (endpoint: Point, lockIndex: number) => endWires([{ endpoint, lockIndex }]),
    [endWires]
  );

  const finish = useCallback(() => {
    const d = draftRef.current;
    if (d.phase !== 2) return;
    const closed = closeBus(d);
    if (closed.paths.every((path) => path.length === 0)) return; // nothing drawn yet
    finalize(closed);
  }, [finalize]);

  const beginPhase2 = useCallback(
    (starts: Array<{ point: Point; anchor: DrawAnchor | null }>) => {
      if (starts.length === 0) return;
      // Direct setDraft (no `apply`): the user invoked this from a menu, so
      // there's no per-step undo to step back through. Escape still aborts
      // the whole draft.
      undoRef.current = [];
      redoRef.current = [];
      setDraft(
        phase2(
          starts.map((s) => ({ x: Math.round(s.point.x), y: Math.round(s.point.y) })),
          starts.map((s) => s.anchor)
        )
      );
    },
    []
  );
  const cancel = useCallback(() => {
    if (draftRef.current.points.length > 0 || draftRef.current.phase === 2) {
      reset();
    } else {
      setActiveTool("select");
    }
  }, [reset, setActiveTool]);

  // Leaving the tool abandons the in-progress bus.
  useEffect(() => {
    if (
      activeTool !== "multiWire" &&
      (draftRef.current.points.length > 0 || draftRef.current.phase === 2)
    ) {
      reset();
    }
  }, [activeTool, reset]);

  // While a draft exists, ⌘Z/⌘⇧Z step through it (points, phase change, turns).
  const active = draft.points.length > 0;
  useEffect(() => {
    if (!active) return;
    setUndoOverride({ undo, redo });
    return () => setUndoOverride(null);
  }, [active, undo, redo, setUndoOverride]);

  // Keyboard: Enter advances phase 1 → 2, then finishes the bus; Esc aborts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (useDieViewerStore.getState().activeTool !== "multiWire") return;
      if (isTypingTarget(e.target)) return;
      if (e.key === "Enter") {
        e.preventDefault();
        if (draftRef.current.phase === 1) enterPhase2();
        else finish();
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enterPhase2, finish, cancel]);

  return {
    phase: draft.phase,
    points: draft.points,
    draft,
    addPoint,
    placeCorner: placeCornerCb,
    endWire,
    endWires,
    finish,
    beginPhase2
  };
}
