/**
 * Compound boolean expression → tree of primitive logic gates,
 * then → placed-and-wired layout.
 *
 * Two phases, two pure functions:
 *
 *   1. `decomposeLogic(expr)`  ── recursive tree of primitive symbols
 *      Most leaves of recognition land here naturally — a recognised
 *      INV / AND / NAND / OR / NOR / XOR / XNOR returns a single gate
 *      node with literal leaves. AOI / OAI / AO / OA expand by groups
 *      (e.g. AOI21 → INV(OR(AND(A,B), C))). Anything still compound
 *      after that recurses by inspecting the raw `BoolExpr` operator.
 *
 *   2. `layoutLogicTree(tree, ctx)`  ── places everything in 2D
 *      Recursive depth-first left-to-right: leaves get vertical slots
 *      on the cell-input side, each gate sits to the right of its
 *      tallest child stack and vertically centered with them. Wires
 *      use straight horizontals when child output and gate input
 *      already align (the common case), and a 3-segment Manhattan
 *      jog otherwise.
 *
 * The layout output is pure data — wire endpoints, placed `RenderedSymbol`
 * instances from `logicSymbols.tsx`, and pin coordinates — so the canvas
 * component can pan/zoom/hover without re-running the layout.
 */

import type { BoolExpr } from "../extraction/cell";
import type { GateLit, GateMatch } from "../extraction/gates";
import { recognizeGate } from "../extraction/gates";
import { renderGateSymbol, type RenderedSymbol } from "./logicSymbols";

// ── Tree types ──────────────────────────────────────────────────────

/**
 * A primitive gate the layout knows how to draw as a single symbol.
 * `inputBubbles[i] === true` means draw a bubble on input pin i
 * (matches `GateLit.negated`).
 */
export interface PrimitiveGate {
  kind: "inv" | "and" | "nand" | "or" | "nor" | "xor" | "xnor";
  arity: number;
  inputBubbles: boolean[];
}

/**
 * Decomposed-expression tree. `gate` nodes carry the primitive symbol
 * + children (which in turn are gates or leaves). `leaf` nodes
 * terminate at a cell-input net; `const` ties to 0 or 1.
 */
export type LogicTree =
  | { kind: "leaf"; netId: number; negated: boolean }
  | { kind: "const"; value: 0 | 1 }
  | { kind: "gate"; primitive: PrimitiveGate; children: LogicTree[] };

// ── Decomposition ───────────────────────────────────────────────────

/**
 * Walk `expr` into a `LogicTree`. The strategy mirrors how a designer
 * reads a netlist:
 *
 *   - First try `recognizeGate` to see if the whole thing is one
 *     library cell (single primitive → single `gate` node).
 *   - For AOI / OAI / AO / OA, expand by `groups`: each group becomes
 *     a sub-gate (AND for AOI/AO, OR for OAI/OA) and the top is the
 *     opposite (OR / AND); the I suffix adds a wrapping INV.
 *   - For `compound`, fall through to the raw `BoolExpr` operator and
 *     recurse. NOT becomes an INV node wrapping the decomposed child;
 *     AND / OR become n-input gates with each arg decomposed
 *     independently.
 */
export function decomposeLogic(expr: BoolExpr): LogicTree {
  const match = recognizeGate(expr);

  switch (match.kind) {
    case "const":
      return { kind: "const", value: match.value };

    case "wire":
      return {
        kind: "leaf",
        netId: match.input.netId,
        negated: match.input.negated === true,
      };

    case "inv":
      return primitiveFromMatch("inv", [match.input], [
        { kind: "leaf", netId: match.input.netId, negated: false },
      ]);

    case "and":
    case "or":
    case "nand":
    case "nor":
      return primitiveFromMatch(
        match.kind,
        match.inputs,
        match.inputs.map((l) => leafFromLit(l)),
      );

    case "xor":
    case "xnor":
      return primitiveFromMatch(
        match.kind,
        match.inputs,
        match.inputs.map((l) => leafFromLit(l)),
      );

    case "aoi":
    case "oai":
    case "ao":
    case "oa":
      return expandGroups(match);

    case "compound":
      return decomposeRaw(match.expr);
  }
}

/**
 * Build a single-gate node. The input bubbles come from the literals'
 * `negated` flags, but the LEAF children we synthesise always have
 * `negated: false` — the bubble lives on the gate's input pin, not on
 * the leaf itself. That avoids "double bubble" rendering (one on the
 * leaf wire and one on the gate pin) for the same logical inversion.
 */
function primitiveFromMatch(
  kind: PrimitiveGate["kind"],
  inputs: GateLit[],
  children: LogicTree[],
): LogicTree {
  return {
    kind: "gate",
    primitive: {
      kind,
      arity: inputs.length,
      inputBubbles: inputs.map((l) => l.negated === true),
    },
    children,
  };
}

function leafFromLit(lit: GateLit): LogicTree {
  // The bubble belongs to the parent gate's pin; the leaf is just the
  // net. (See note in `primitiveFromMatch`.)
  return { kind: "leaf", netId: lit.netId, negated: false };
}

/**
 * Expand an AOI / OAI / AO / OA match into a small tree:
 *
 *   AO21:  groups [[A,B],[C]] → OR(AND(A,B), C)
 *   AOI21: groups [[A,B],[C]] → INV(OR(AND(A,B), C))
 *   OA21:  groups [[A,B],[C]] → AND(OR(A,B), C)
 *   OAI21: groups [[A,B],[C]] → INV(AND(OR(A,B), C))
 *
 * A group of size 1 collapses to a direct literal child of the top
 * gate (no sub-AND/OR wrapper); avoids drawing a 1-input AND box.
 */
function expandGroups(
  match: Extract<GateMatch, { kind: "aoi" | "oai" | "ao" | "oa" }>,
): LogicTree {
  const isInverted = match.kind === "aoi" || match.kind === "oai";
  const topKind = match.kind === "ao" || match.kind === "aoi" ? "or" : "and";
  const groupKind = topKind === "or" ? "and" : "or";

  // Each group becomes either a direct leaf (size 1) or a sub-gate.
  const topChildren: LogicTree[] = match.groups.map((group) => {
    if (group.length === 1) {
      // Single literal — bubble (if any) sits on the TOP gate's input
      // pin. The leaf itself stays non-negated.
      return { kind: "leaf", netId: group[0].netId, negated: false };
    }
    return primitiveFromMatch(
      groupKind,
      group,
      group.map((l) => leafFromLit(l)),
    );
  });

  // Top gate input bubbles: for a size-1 group, we propagate the
  // literal's `negated` flag (so an AO21 with `~C` shows a bubble on
  // the top OR's second input). Size>1 group: the sub-gate's output
  // feeds in non-bubbled; the sub-gate handled per-input bubbles.
  const topBubbles: boolean[] = match.groups.map((group) =>
    group.length === 1 ? group[0].negated === true : false,
  );

  const topNode: LogicTree = {
    kind: "gate",
    primitive: { kind: topKind, arity: topChildren.length, inputBubbles: topBubbles },
    children: topChildren,
  };

  if (!isInverted) return topNode;

  // Wrap in INV for AOI / OAI.
  return {
    kind: "gate",
    primitive: { kind: "inv", arity: 1, inputBubbles: [false] },
    children: [topNode],
  };
}

/**
 * Compound fallback: walk the raw `BoolExpr` recursively. We don't try
 * to be clever here — every AND / OR / NOT becomes its own gate node,
 * children decompose independently. Recognition gets re-tried on each
 * child (via `decomposeLogic`) so a recognised XOR or AOI nested deep
 * inside an unrecognised whole still surfaces as a clean symbol.
 */
function decomposeRaw(expr: BoolExpr): LogicTree {
  switch (expr.kind) {
    case "const":
      return { kind: "const", value: expr.value };
    case "net":
      return { kind: "leaf", netId: expr.net, negated: false };
    case "not":
      return {
        kind: "gate",
        primitive: { kind: "inv", arity: 1, inputBubbles: [false] },
        children: [decomposeLogic(expr.arg)],
      };
    case "and":
    case "or":
      return {
        kind: "gate",
        primitive: {
          kind: expr.kind,
          arity: expr.args.length,
          inputBubbles: expr.args.map(() => false),
        },
        children: expr.args.map(decomposeLogic),
      };
  }
}

// ── Layout ──────────────────────────────────────────────────────────

export interface Point {
  x: number;
  y: number;
}

export interface PlacedSymbol {
  /** Symbol top-left in cell-local coords. */
  x: number;
  y: number;
  rendered: RenderedSymbol;
}

export interface Wire {
  /** Polyline waypoints (already in cell-local coords). Start and end
   *  are included; intermediate points are present only for jogs. */
  points: Point[];
  /** Net id carried by this wire — populated wherever the source tree
   *  node knows it (leaf wires + intra-gate connections do; the top
   *  output wire does too). Used by future hover/highlight. */
  netId?: number;
}

export interface InputPort {
  x: number;
  y: number;
  netId: number;
  /** Label to draw to the left (typically the net name / role). */
  label: string;
  /** Bubble on this pin (the LEAF's own negation, if any). */
  negated: boolean;
}

export interface OutputPort {
  x: number;
  y: number;
  /** Net id this output represents — usually the cell's primary output. */
  netId?: number;
  label?: string;
}

export interface LogicLayout {
  symbols: PlacedSymbol[];
  wires: Wire[];
  inputs: InputPort[];
  output: OutputPort;
  /** Bounding box of the whole layout in its own local coords. */
  bbox: { x: number; y: number; width: number; height: number };
}

export interface LayoutContext {
  /** Pretty-print a net id for labels — usually a thin wrapper around
   *  `displayLabel(net.label) ?? "netN"`. */
  netName: (netId: number) => string;
  /** Optional net id for the very top output. When set, the output
   *  port's `netId` is populated and the label drawn. */
  outputNetId?: number;
  /** Skip the input-label column, the output stub wire, and the
   *  output label column. Used when the layout is embedded as a
   *  composite node inside a larger netlist (e.g. an AOI21 box in
   *  the ELK netlist view) — the outer view handles labeling and
   *  wire connection at the node's boundary, so the internal layout
   *  should sit flush against its bbox without decorations. */
  omitDecorations?: boolean;
}

// Visual constants. Tuned for ~12px font + the ~20px symbol heights
// in `logicSymbols.tsx`; bump if the symbols change scale.
const LEAF_HEIGHT = 20;
const VERTICAL_GAP = 6;
/** Baseline horizontal gap between the child stack and the parent
 *  gate. Grows automatically with arity (see `layoutNode`) so the
 *  per-wire vertical lanes have room to spread without crowding. */
const HORIZONTAL_GAP = 28;
/** Minimum horizontal spacing between adjacent wire vertical lanes.
 *  Each child→gate wire gets its own lane so verticals don't stack on
 *  top of each other (the bug NAND4 hit before this constant existed). */
const WIRE_LANE = 6;
const LABEL_RESERVE = 36; // space on the left for input-net labels

/**
 * Top-level layout entry point. Wraps `layoutNode` and adds the cell-
 * level frame: input labels on the left, output wire + label on the
 * right.
 */
export function layoutLogicTree(
  tree: LogicTree,
  ctx: LayoutContext,
): LogicLayout {
  const inner = layoutNode(tree, ctx);
  const omit = ctx.omitDecorations === true;
  // Without decorations the layout sits flush at (0, 0); with them we
  // reserve a left column for input labels and a right column for the
  // output stub + label.
  const dx = omit ? 0 : LABEL_RESERVE;
  const stub = omit ? 0 : 24;
  const rightReserve = omit ? 0 : LABEL_RESERVE;

  const symbols = inner.symbols.map((s) => ({ ...s, x: s.x + dx }));
  const wires = inner.wires.map((w) => ({
    ...w,
    points: w.points.map((p) => ({ x: p.x + dx, y: p.y })),
  }));
  const inputs = inner.inputPorts.map((p) => ({
    x: p.x + dx,
    y: p.y,
    netId: p.netId,
    negated: p.negated,
    label: omit ? "" : ctx.netName(p.netId),
  }));

  // Output: extend a short wire to the right past the rightmost symbol
  // so the label has somewhere to sit. Skipped when embedded.
  const outX = inner.outputPort.x + dx;
  const outY = inner.outputPort.y;
  if (stub > 0) {
    wires.push({
      points: [
        { x: outX, y: outY },
        { x: outX + stub, y: outY },
      ],
      netId: ctx.outputNetId,
    });
  }

  return {
    symbols,
    wires,
    inputs,
    output: {
      x: outX + stub,
      y: outY,
      netId: ctx.outputNetId,
      label:
        !omit && ctx.outputNetId != null
          ? ctx.netName(ctx.outputNetId)
          : undefined,
    },
    bbox: {
      x: 0,
      y: 0,
      width: dx + inner.width + stub + rightReserve,
      height: Math.max(inner.height, LEAF_HEIGHT),
    },
  };
}

/**
 * Recursive layout for one `LogicTree` node. Returns the placed
 * sub-tree in its own local frame:
 *
 *   - `outputPort` is where the parent gate should connect its input
 *     wire (the rightmost point of this sub-tree).
 *   - `inputPorts` collects every leaf-net entry point in canonical
 *     (top-to-bottom) order. Cell-level layout uses these to draw the
 *     input labels.
 *   - `width` / `height` are the sub-tree's bounding box.
 *
 * The vertical stacking math: children stack with `VERTICAL_GAP`
 * between them; the gate sits to the right of `maxChildWidth + GAP`,
 * vertically centered against the total child stack. Wires from each
 * child output to the gate's matching input pin use a straight line
 * when y-aligned and a 3-segment Manhattan jog otherwise.
 */
interface NodeLayout {
  symbols: PlacedSymbol[];
  wires: Wire[];
  inputPorts: Array<{ x: number; y: number; netId: number; negated: boolean }>;
  outputPort: Point;
  width: number;
  height: number;
}

function layoutNode(tree: LogicTree, ctx: LayoutContext): NodeLayout {
  if (tree.kind === "leaf") {
    // Leaf occupies its own vertical slot. Width 0 so the parent's
    // `maxChildWidth` math doesn't reserve a column for empty space.
    const y = LEAF_HEIGHT / 2;
    return {
      symbols: [],
      wires: [],
      inputPorts: [{ x: 0, y, netId: tree.netId, negated: tree.negated }],
      outputPort: { x: 0, y },
      width: 0,
      height: LEAF_HEIGHT,
    };
  }
  if (tree.kind === "const") {
    const rendered = renderGateSymbol({ kind: "const", value: tree.value });
    return {
      symbols: [{ x: 0, y: 0, rendered }],
      wires: [],
      inputPorts: [],
      outputPort: { x: rendered.width, y: rendered.output.y },
      width: rendered.width,
      height: rendered.height,
    };
  }

  // Gate node — recurse.
  const synth = synthesizeMatch(tree.primitive);
  const rendered = renderGateSymbol(synth);
  const childLayouts = tree.children.map((c) => layoutNode(c, ctx));
  const N = childLayouts.length;

  // Total vertical extent of stacked children.
  const totalChildH =
    childLayouts.reduce((acc, cl) => acc + cl.height, 0) +
    Math.max(0, N - 1) * VERTICAL_GAP;
  const maxChildW = childLayouts.reduce((acc, cl) => Math.max(acc, cl.width), 0);

  // Grow the horizontal gap so every child→gate wire gets its own
  // unique vertical lane. Without this NAND4 (and any other wide
  // gate) ends up with N wire jogs all sitting at the same midX and
  // visually stacking on top of each other. Lane spacing = WIRE_LANE
  // plus a half-lane margin on each side of the fan.
  const fanWidth = Math.max(0, (N - 1) * WIRE_LANE);
  const horizontalGap = Math.max(HORIZONTAL_GAP, fanWidth + 2 * WIRE_LANE);

  // Place each child stacked vertically. Vertically center the gate
  // against the children's total span.
  const totalH = Math.max(totalChildH, rendered.height);
  const childrenTop = (totalH - totalChildH) / 2;
  const gateY = (totalH - rendered.height) / 2;
  const gateX = maxChildW + horizontalGap;

  // Pre-compute each child's vertical origin so we can build wire
  // specs before emitting anything (we need all Δy values before
  // assigning lanes).
  const childOriginY: number[] = [];
  {
    let curY = childrenTop;
    for (let i = 0; i < N; i++) {
      childOriginY.push(curY);
      curY += childLayouts[i].height + VERTICAL_GAP;
    }
  }

  // Wire spec for each child: where it starts (child output port) and
  // where it ends (matching gate input pin), plus |Δy| so we can sort
  // by vertical travel below.
  interface WireSpec {
    i: number;
    fromX: number;
    fromY: number;
    toX: number;
    toY: number;
    deltaY: number;
  }
  const specs: WireSpec[] = childLayouts.map((cl, i) => {
    const fromX = cl.outputPort.x;
    const fromY = cl.outputPort.y + childOriginY[i];
    const pin = rendered.inputs[i];
    const toX = gateX + pin.x;
    const toY = gateY + pin.y;
    return { i, fromX, fromY, toX, toY, deltaY: Math.abs(fromY - toY) };
  });

  // Lane assignment by Δy descending. The wire that travels the
  // furthest vertically gets the lane CLOSEST to the gate (last to
  // bend); short-travel wires take lanes closer to the leaves (bend
  // first). This rule provably avoids the wire-crossings the naive
  // by-index lane order produces — long verticals would otherwise
  // pass through the y-range where shorter wires sit, intersecting
  // their horizontals.
  const sortedByDeltaY = [...specs].sort((a, b) => b.deltaY - a.deltaY);
  const lane = horizontalGap / (N + 1);
  const midXForChild = new Map<number, number>();
  sortedByDeltaY.forEach((spec, sortedIdx) => {
    // sortedIdx 0 (largest Δy) → k = N (largest midX, nearest gate)
    // sortedIdx N-1 (smallest Δy) → k = 1 (smallest midX, nearest leaves)
    const k = N - sortedIdx;
    midXForChild.set(spec.i, maxChildW + k * lane);
  });

  const symbols: PlacedSymbol[] = [];
  const wires: Wire[] = [];
  const inputPorts: NodeLayout["inputPorts"] = [];

  for (let i = 0; i < N; i++) {
    const cl = childLayouts[i];
    const offsetY = childOriginY[i];
    // Move child symbols / wires / ports down by offsetY.
    for (const s of cl.symbols) symbols.push({ ...s, y: s.y + offsetY });
    for (const w of cl.wires) {
      wires.push({
        netId: w.netId,
        points: w.points.map((p) => ({ x: p.x, y: p.y + offsetY })),
      });
    }
    for (const p of cl.inputPorts) {
      inputPorts.push({ ...p, y: p.y + offsetY });
    }

    // Wire child output → gate input pin i, routed through this
    // child's assigned lane.
    const spec = specs[i];
    const midX = midXForChild.get(i)!;
    const netId = pickWireNetId(tree.children[i]);
    wires.push({
      netId,
      points: manhattan(spec.fromX, spec.fromY, spec.toX, spec.toY, midX),
    });
  }

  symbols.push({ x: gateX, y: gateY, rendered });

  return {
    symbols,
    wires,
    inputPorts,
    outputPort: {
      x: gateX + rendered.output.x,
      y: gateY + rendered.output.y,
    },
    width: gateX + rendered.width,
    height: totalH,
  };
}

/** H/V/H Manhattan path from (x1,y1) to (x2,y2) using `lane` as the
 *  X of the vertical leg. Caller picks `lane` per-wire so multiple
 *  fans into the same gate don't share a vertical (see the lane
 *  assignment in `layoutNode`). When y1 == y2 the vertical leg
 *  collapses and we emit a straight 2-point line. */
function manhattan(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  lane: number,
): Point[] {
  if (y1 === y2) {
    return [
      { x: x1, y: y1 },
      { x: x2, y: y2 },
    ];
  }
  return [
    { x: x1, y: y1 },
    { x: lane, y: y1 },
    { x: lane, y: y2 },
    { x: x2, y: y2 },
  ];
}

/**
 * Heuristic: name the wire by the net it carries. For a leaf child
 * that's the leaf's net id; for a sub-gate child we don't have a net
 * (it's an anonymous intermediate signal) — return `undefined` so the
 * canvas can decide whether to show / hover the wire anonymously.
 */
function pickWireNetId(child: LogicTree): number | undefined {
  if (child.kind === "leaf") return child.netId;
  return undefined;
}

/** Build a synthetic `GateMatch` the renderer can consume. Net ids are
 *  sentinel `-1`s because at this level the net info has already been
 *  hoisted into the surrounding tree (gates know their own inputs by
 *  position; the renderer only reads `negated`). */
function synthesizeMatch(p: PrimitiveGate): GateMatch {
  const inputs: GateLit[] = p.inputBubbles.map((neg) => ({
    netId: -1,
    negated: neg,
  }));
  switch (p.kind) {
    case "inv":
      return { kind: "inv", input: inputs[0] ?? { netId: -1, negated: false } };
    case "xor":
    case "xnor":
      return {
        kind: p.kind,
        inputs: [
          inputs[0] ?? { netId: -1, negated: false },
          inputs[1] ?? { netId: -1, negated: false },
        ],
      };
    default:
      return { kind: p.kind, inputs };
  }
}
