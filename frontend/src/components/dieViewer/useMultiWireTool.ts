import { useCallback, useEffect, useRef, useState } from "react";
import type { AnnotationNet, DieAnnotations } from "shared";
import type { ActionDispatcher, AnnotationAction } from "../../api/actions";
import {
  distancePointToSegment,
  snapTo45,
  type Point
} from "../../lib/geometry";
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

/** Phase-2 endpoint for the reference start point. 45°-snapped to the cursor
 *  by default; `free` (Shift held) lets the bus take any angle. Every wire
 *  uses the same delta (end − ref) so they stay parallel. */
export function multiParallelEnd(
  ref: Point,
  world: Point,
  free = false
): Point {
  if (free) return { x: Math.round(world.x), y: Math.round(world.y) };
  return snapTo45(ref, world);
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

interface Draft {
  /** 1 = collecting start points, 2 = sweeping the parallel ends. */
  phase: 1 | 2;
  points: Point[];
  /** `anchors[i]` = the existing net vertex `points[i]` snapped to (the new
   *  segment extends that net instead of making a fresh one), else null. */
  anchors: (DrawAnchor | null)[];
  /** Phase-2: `ends[i]` is the locked endpoint of wire `i` once its own click
   *  landed (null = still sweeping with the cursor). Empty in phase 1. */
  ends: (Point | null)[];
}
const EMPTY: Draft = { phase: 1, points: [], anchors: [], ends: [] };

export interface MultiWireTool {
  phase: 1 | 2;
  points: Point[];
  /** Phase-2: locked endpoint per start (null = still sweeping). */
  ends: (Point | null)[];
  /** Phase-1 click → add a start point (with optional net-vertex anchor). */
  addPoint: (world: Point, anchor: DrawAnchor | null) => void;
  /** Phase-2 click → lock the wire nearest the cursor at its current preview
   *  end; the rest keep sweeping. When the last one lands, all are committed
   *  in one batched undo (anchored starts extend their net, free starts
   *  become new nets). `free` (Shift) unconstrains the bus angle.
   *
   *  `override` is the snap-to-vias path: the caller has already resolved
   *  which wire to lock (`lockIndex`) and where to land its endpoint
   *  (`endpoint`, a via centre). The locked wire then runs straight from
   *  its start to that via, off the parallel front — each wire can reach
   *  its own via. Without `override` the wire is picked by nearest-preview
   *  and ends on the common bus front as usual. */
  endWire: (
    world: Point,
    free: boolean,
    override?: { endpoint: Point; lockIndex: number }
  ) => void;
  /** Auto-end-on-via path: lock several still-sweeping wires at once, each at
   *  its own via centre. Finalises if it lands every wire; otherwise leaves
   *  the rest sweeping. Duplicate / already-locked indices are ignored. */
  endWires: (picks: Array<{ endpoint: Point; lockIndex: number }>) => void;
  /** Open the bus directly in phase 2 with `starts` as the per-wire origin
   *  points (anchors optional — null = the wire will become a fresh net).
   *  Used by the context-menu "Start multi-wiring from selection" entry to
   *  skip the manual click-each-start-then-Enter dance. */
  beginPhase2: (
    starts: Array<{ point: Point; anchor: DrawAnchor | null }>
  ) => void;
}

/**
 * Multi-wire: phase 1 collects N bus start points (click); Enter advances to
 * phase 2 where the cursor sweeps N parallel 45°-aligned segments out of those
 * points; a click finishes them as N independent nets (one batched undo).
 * Contextual ⌘Z/⌘⇧Z steps through points and the phase change; Esc aborts.
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
        phase: 1,
        points: [
          ...d.points,
          { x: Math.round(world.x), y: Math.round(world.y) }
        ],
        anchors: [...d.anchors, anchor],
        ends: []
      });
    },
    [apply]
  );

  const enter = useCallback(() => {
    const d = draftRef.current;
    if (d.phase === 1 && d.points.length >= 1) {
      apply({
        phase: 2,
        points: d.points,
        anchors: d.anchors,
        ends: d.points.map(() => null)
      });
    }
  }, [apply]);

  const finalize = useCallback(
    (d: Draft, ends: Point[]) => {
      const layer = activeLayer();
      const nets = netsRef.current;
      const nameBase = nets.length;
      const uid = () => uuid();
      const mkEdge = (from: string, to: string) => ({
        id: uid(),
        from,
        to,
        ...(layer ? { layer } : {})
      });

      // Anchored starts extend their existing net (folded so several lines
      // anchoring into the same net compose into one change); free starts
      // become brand-new nets.
      const origByNet = new Map<string, AnnotationNet>();
      const curByNet = new Map<string, AnnotationNet>();
      const newNets: AnnotationNet[] = [];

      d.points.forEach((p, i) => {
        const e = ends[i];
        const endNode = { id: uid(), x: e.x, y: e.y };
        const anchor = d.anchors[i];
        const orig = anchor
          ? nets.find((n) => n.id === anchor.netId)
          : undefined;
        if (anchor && orig) {
          if (!origByNet.has(orig.id)) origByNet.set(orig.id, orig);
          const cur = curByNet.get(orig.id) ?? orig;
          curByNet.set(orig.id, {
            ...cur,
            nodes: [...cur.nodes, endNode],
            edges: [...cur.edges, mkEdge(anchor.nodeId, endNode.id)]
          });
        } else {
          const startNode = { id: uid(), x: p.x, y: p.y };
          newNets.push({
            id: uid(),
            name: `Net ${nameBase + newNets.length + 1}`,
            nodes: [startNode, endNode],
            edges: [mkEdge(startNode.id, endNode.id)]
          });
        }
      });

      const actions: AnnotationAction[] = [
        ...[...curByNet.entries()].map(([id, net]) => ({
          kind: "upsertNet" as const,
          net,
          prevNet: origByNet.get(id) ?? null
        })),
        ...newNets.map((net) => ({
          kind: "upsertNet" as const,
          net,
          prevNet: null
        }))
      ];
      if (actions.length > 0) {
        void dispatcher.dispatch(
          actions.length === 1 ? actions[0] : { kind: "batch", actions }
        );
      }
      reset();
    },
    [dispatcher, reset]
  );

  const endWire = useCallback(
    (
      world: Point,
      free: boolean,
      override?: { endpoint: Point; lockIndex: number }
    ) => {
      const d = draftRef.current;
      if (d.phase !== 2 || d.points.length === 0) return;
      const ref = d.points[0];

      let best: number;
      let lockedEnd: Point;
      if (override) {
        // Snap-to-vias path: the caller resolved which wire to lock and the
        // exact endpoint (a via centre). The locked wire runs straight from
        // its start to the via — it leaves the parallel front, which is
        // fine: via routing wants each wire on its own via.
        best = override.lockIndex;
        if (best < 0 || best >= d.points.length || d.ends[best]) return;
        lockedEnd = {
          x: Math.round(override.endpoint.x),
          y: Math.round(override.endpoint.y)
        };
      } else {
        const target = multiParallelEnd(ref, world, free);
        if (
          Math.round(target.x - ref.x) === 0 &&
          Math.round(target.y - ref.y) === 0
        )
          return;
        // Lock the still-sweeping wire whose parallel preview is nearest
        // the click; the others keep following the cursor.
        best = -1;
        let bestDist = Infinity;
        d.points.forEach((p, i) => {
          if (d.ends[i]) return;
          const dist = distancePointToSegment(
            world,
            p,
            multiWireEndpoint(p, ref, target)
          );
          if (dist < bestDist) {
            bestDist = dist;
            best = i;
          }
        });
        if (best < 0) return;
        lockedEnd = multiWireEndpoint(d.points[best], ref, target);
      }

      const nextEnds = d.ends.slice();
      nextEnds[best] = lockedEnd;
      if (nextEnds.some((e) => e === null)) {
        apply({ ...d, ends: nextEnds });
        return;
      }
      finalize(d, nextEnds as Point[]);
    },
    [apply, finalize]
  );

  const endWires = useCallback(
    (picks: Array<{ endpoint: Point; lockIndex: number }>) => {
      const d = draftRef.current;
      if (d.phase !== 2 || d.points.length === 0 || picks.length === 0) return;
      const nextEnds = d.ends.slice();
      let changed = false;
      for (const pick of picks) {
        if (pick.lockIndex < 0 || pick.lockIndex >= d.points.length) continue;
        if (nextEnds[pick.lockIndex]) continue;
        nextEnds[pick.lockIndex] = {
          x: Math.round(pick.endpoint.x),
          y: Math.round(pick.endpoint.y)
        };
        changed = true;
      }
      if (!changed) return;
      if (nextEnds.some((e) => e === null)) {
        apply({ ...d, ends: nextEnds });
        return;
      }
      finalize(d, nextEnds as Point[]);
    },
    [apply, finalize]
  );

  const beginPhase2 = useCallback(
    (starts: Array<{ point: Point; anchor: DrawAnchor | null }>) => {
      if (starts.length === 0) return;
      // Direct setDraft (no `apply`): the user invoked this from a menu, so
      // there's no per-step undo to step back through. Escape still aborts
      // the whole draft.
      undoRef.current = [];
      redoRef.current = [];
      setDraft({
        phase: 2,
        points: starts.map((s) => ({
          x: Math.round(s.point.x),
          y: Math.round(s.point.y)
        })),
        anchors: starts.map((s) => s.anchor),
        ends: starts.map(() => null)
      });
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

  // While a draft exists, ⌘Z/⌘⇧Z step through it (points + phase change).
  const active = draft.points.length > 0;
  useEffect(() => {
    if (!active) return;
    setUndoOverride({ undo, redo });
    return () => setUndoOverride(null);
  }, [active, undo, redo, setUndoOverride]);

  // Keyboard: Enter advances phase 1 → 2; Escape aborts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (useDieViewerStore.getState().activeTool !== "multiWire") return;
      if (isTypingTarget(e.target)) return;
      if (e.key === "Enter") {
        e.preventDefault();
        enter();
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enter, cancel]);

  return {
    phase: draft.phase,
    points: draft.points,
    ends: draft.ends,
    addPoint,
    endWire,
    endWires,
    beginPhase2
  };
}
