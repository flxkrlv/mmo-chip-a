/**
 * Schematic-symbol primitives for the standard logic gates we recognise.
 *
 * Each renderer returns a `RenderedSymbol` — pure data describing:
 *   - the SVG content to drop inside a `<g transform="translate(x,y)">`,
 *   - the local-frame bounding box,
 *   - input + output pin coordinates in that local frame.
 *
 * Layout consumers (Phase 1 = right-panel preview; Phase 2 = single-cell
 * composition view; Phase 3 = full netlist) can place the symbol
 * anywhere and route wires by reading the pin coords back. No layout
 * decisions live here.
 *
 * Conventions:
 *   - Local origin (0, 0) is the top-left of the bounding box.
 *   - Input pins lie on the left edge (x = 0). Output pin on the right
 *     edge (x = width).
 *   - Bubbles count as part of the bounding box, so a NAND has output
 *     pin at `(width, height/2)` past the bubble's outer edge.
 *   - `GateLit.negated` becomes an input-side bubble (small circle just
 *     inside the input pin).
 *   - We deliberately use IEC/ANSI shapes (curved AND/OR), not the
 *     rectangular IEC blocks — they're more readable at a glance, which
 *     matters more here than international standards compliance.
 */

import type { ReactNode } from "react";
import type { GateLit, GateMatch } from "../extraction/gates";
import { gateLabel } from "../extraction/gates";

// ── Theme + sizing ──────────────────────────────────────────────────

/** Background fill — matches the CMOS-schematic canvas so symbols sit
 *  flush on either tab without a colour pop. */
const FILL = "var(--canvas-bg)";
const STROKE = "var(--ink2)";
const LINE_W = 1.5;
/** Output-bubble + input-bubble radius. Small enough to read as a
 *  marker, big enough to land click hit-tests later. */
const BUBBLE_R = 3;
/** Tiny stub inside the input pin so an input bubble (when present)
 *  doesn't overlap with whatever wire connects from the left. */
const PIN_INSET = BUBBLE_R * 2;

/** Inverter / buffer triangle. Compact — these symbols are visually
 *  simpler so we don't need much room. */
const INV_BODY_W = 18;
const INV_H = 16;

/** Body height for the n-input D-shape (AND/NAND/OR/NOR/XOR/XNOR).
 *  Grows with input count so pins don't crowd. */
const D_BODY_W = 28;
const D_MIN_H = 20;
const D_H_PER_INPUT = 7;

// ── Public types ────────────────────────────────────────────────────

export interface SymbolPin {
  x: number;
  y: number;
  /** Bubble at this pin (input-side: inverted input on AND/NAND/etc.;
   *  output-side: implicit for NAND/NOR/XNOR/INV — not set by the
   *  caller, the renderer draws those itself). */
  negated?: boolean;
}

export interface RenderedSymbol {
  /** SVG content positioned in the symbol's local frame. Caller wraps
   *  it in a `<g transform="translate(x, y)">` to place. */
  svg: ReactNode;
  /** Bounding box width — includes any output-side bubble or extra
   *  curve overhang so the caller can spacing-pack symbols by adding
   *  width + gap. */
  width: number;
  height: number;
  /** Input pin coordinates in canonical order (matches the order in
   *  the source `GateMatch.inputs` / flattened `groups`). */
  inputs: SymbolPin[];
  output: SymbolPin;
}

// ── Top-level dispatch ──────────────────────────────────────────────

/**
 * Render the recognised gate as a single SVG symbol. Compound /
 * AOI / OAI / AO / OA fall through to a labelled placeholder rect for
 * now — Phase 2 will recursively decompose them into trees of the
 * primitives below.
 */
export function renderGateSymbol(gate: GateMatch): RenderedSymbol {
  switch (gate.kind) {
    case "const":
      return renderConst(gate.value);
    case "wire":
      return renderWire(gate.input);
    case "inv":
      return renderInv(gate.input);
    case "and":
      return renderDGate("and", gate.inputs);
    case "nand":
      return renderDGate("nand", gate.inputs);
    case "or":
      return renderDGate("or", gate.inputs);
    case "nor":
      return renderDGate("nor", gate.inputs);
    case "xor":
      return renderDGate("xor", gate.inputs);
    case "xnor":
      return renderDGate("xnor", gate.inputs);
    // AOI / OAI / AO / OA + compound: placeholder until Phase 2.
    case "aoi":
    case "oai":
    case "ao":
    case "oa":
    case "compound":
      return renderPlaceholder(gate);
  }
}

// ── Primitive renderers ────────────────────────────────────────────

function renderInv(input: GateLit): RenderedSymbol {
  const W = INV_BODY_W + 2 * BUBBLE_R;
  const H = INV_H;
  const tipX = INV_BODY_W;
  // Input bubble is rare on INV but possible (negated `GateLit`). If
  // present, slide the triangle right to leave room.
  const triLeft = input.negated ? PIN_INSET : 0;
  return {
    svg: (
      <>
        {input.negated && (
          <circle
            cx={BUBBLE_R}
            cy={H / 2}
            r={BUBBLE_R}
            fill={FILL}
            stroke={STROKE}
            strokeWidth={LINE_W}
          />
        )}
        <polygon
          points={`${triLeft},0 ${triLeft},${H} ${tipX},${H / 2}`}
          fill={FILL}
          stroke={STROKE}
          strokeWidth={LINE_W}
          strokeLinejoin="round"
        />
        <circle
          cx={tipX + BUBBLE_R}
          cy={H / 2}
          r={BUBBLE_R}
          fill={FILL}
          stroke={STROKE}
          strokeWidth={LINE_W}
        />
      </>
    ),
    width: W,
    height: H,
    inputs: [{ x: 0, y: H / 2, negated: input.negated }],
    output: { x: W, y: H / 2, negated: true },
  };
}

/** Plain triangle without the inversion bubble. Used when Phase 2 starts
 *  emitting BUFFER (post-detection); leaving the entry here so the
 *  renderer is symmetric. */
function renderBuffer(input: GateLit): RenderedSymbol {
  const H = INV_H;
  const W = INV_BODY_W;
  const triLeft = input.negated ? PIN_INSET : 0;
  return {
    svg: (
      <>
        {input.negated && (
          <circle
            cx={BUBBLE_R}
            cy={H / 2}
            r={BUBBLE_R}
            fill={FILL}
            stroke={STROKE}
            strokeWidth={LINE_W}
          />
        )}
        <polygon
          points={`${triLeft},0 ${triLeft},${H} ${W},${H / 2}`}
          fill={FILL}
          stroke={STROKE}
          strokeWidth={LINE_W}
          strokeLinejoin="round"
        />
      </>
    ),
    width: W,
    height: H,
    inputs: [{ x: 0, y: H / 2, negated: input.negated }],
    output: { x: W, y: H / 2 },
  };
}

type DKind = "and" | "nand" | "or" | "nor" | "xor" | "xnor";

/**
 * D-shaped multi-input gate (AND/NAND/OR/NOR/XOR/XNOR). The body shape
 * depends on family:
 *   - AND/NAND: flat back, semicircular front. Simple.
 *   - OR/NOR/XOR/XNOR: curved (concave) back + pointed-front shield.
 *
 * Inversion (NAND/NOR/XNOR): tiny circle just past the front tip;
 * output pin moves out by `2*BUBBLE_R` to clear it.
 *
 * XOR/XNOR: extra arc drawn behind the back at small offset (the
 * "XOR back curve" in IEEE convention).
 *
 * Input bubbles (per `GateLit.negated`): drawn entirely OUTSIDE the
 * body — IEEE convention. The bubble sits flush against the body's
 * left edge from the outside, with the input wire arriving at the
 * bubble's outer rim. To make room we reserve `2*BUBBLE_R` on the left
 * of the bounding box whenever any input is bubbled, shift the body
 * right by that reserve, and place each bubble centered just outside
 * the body. Non-bubbled pins in the same gate get a stub of equal
 * length so they line up visually.
 */
function renderDGate(kind: DKind, inputs: GateLit[]): RenderedSymbol {
  const arity = inputs.length;
  const family = kind === "and" || kind === "nand" ? "and"
    : kind === "or" || kind === "nor" ? "or"
    : "xor";
  const inverted = kind === "nand" || kind === "nor" || kind === "xnor";

  const H = Math.max(D_MIN_H, arity * D_H_PER_INPUT);
  const bodyW = D_BODY_W;
  // XOR/XNOR add a small offset for the extra back curve.
  const backOffset = family === "xor" ? 5 : 0;
  const bubbleW = inverted ? 2 * BUBBLE_R : 0;
  // Input-side reserve when any input is bubbled. Same width as a
  // bubble's diameter so the bubble fits between the pin (at x=0) and
  // the body's left edge.
  const hasInputBubble = inputs.some((l) => l.negated === true);
  const inputReserve = hasInputBubble ? 2 * BUBBLE_R : 0;
  const W = inputReserve + backOffset + bodyW + bubbleW;

  // Body path origin sits at (inputReserve + backOffset, 0). Output
  // point of the body (before any bubble) lands at (..+ bodyW, H/2).
  const bodyOriginX = inputReserve + backOffset;
  const bodyTipX = bodyOriginX + bodyW;

  // Build the body path.
  const body = family === "and"
    ? andPath(bodyOriginX, bodyW, H)
    : orPath(bodyOriginX, bodyW, H);

  // Input pin positions. Distributed evenly on the body's left edge.
  // For OR/XOR families the "left edge" is the concave back, so pins
  // sit slightly inside the body curve at their y-position.
  const pinY = (i: number) =>
    arity === 1 ? H / 2 : (H * (i + 1)) / (arity + 1);

  // Input pins are at x=0 (outermost left, so wires can connect from
  // off the symbol). Two cases per pin:
  //  - bubbled: open circle whose right rim touches the body edge
  //    at the pin's y. For AND-family this is at bodyOriginX (flat
  //    left edge); for OR-family it's deeper-in because the back
  //    curve is concave (see `orBackXAt`).
  //  - non-bubbled: a stub from (0, y) to (touchX, y) where touchX
  //    is the same right-rim x. AND-family stubs collapse to
  //    bodyOriginX (= 0 with no input reserve), invisible. OR-family
  //    stubs reach the actual back curve so there's no visible gap
  //    between the wire end and the body.
  const orBackXAt = (y: number): number => {
    // Cubic Bezier back curve from (x0, H) to (x0, 0) with control
    // points (x0+0.25*bodyW, 0.7H) and (x0+0.25*bodyW, 0.3H). The
    // x-coord of a point on the curve simplifies to
    //   x(t) = x0 + 3*(backX − x0)*t*(1−t)
    //        = x0 + 0.75*bodyW*t*(1−t)
    // The y(t) mapping is approximately linear (y/H ≈ 1−t to within
    // a couple percent over t ∈ [0,1] for these control points), so
    // we approximate with t = 1 − y/H:
    //   x ≈ x0 + 0.75*bodyW*(y/H)*(1 − y/H)
    // Good enough that the stub end visually meets the curve at all
    // pin positions; the small mismatch at quarter-points is below
    // a pixel.
    const ny = y / H;
    return bodyOriginX + 0.75 * bodyW * ny * (1 - ny);
  };
  const touchX = (y: number): number =>
    family === "and" ? bodyOriginX : orBackXAt(y);

  const stubs: ReactNode[] = [];
  const bubbles: ReactNode[] = [];
  const pinList: SymbolPin[] = [];
  for (let i = 0; i < arity; i++) {
    const y = pinY(i);
    const neg = inputs[i].negated === true;
    const tx = touchX(y);
    if (neg) {
      const bubbleCx = tx - BUBBLE_R;
      bubbles.push(
        <circle
          key={`bub-${i}`}
          cx={bubbleCx}
          cy={y}
          r={BUBBLE_R}
          fill={FILL}
          stroke={STROKE}
          strokeWidth={LINE_W}
        />,
      );
      // For OR-family the bubble sits deep enough that a small stub
      // is still needed between the pin (x=0) and the bubble's outer
      // rim. For AND-family with input reserve the stub is 0-length
      // (pin + bubble fill the reserve exactly); without input
      // reserve there's no bubble case here anyway.
      const stubX2 = bubbleCx - BUBBLE_R;
      if (stubX2 > 0) {
        stubs.push(
          <line
            key={`stub-${i}`}
            x1={0}
            y1={y}
            x2={stubX2}
            y2={y}
            stroke={STROKE}
            strokeWidth={LINE_W}
          />,
        );
      }
    } else {
      stubs.push(
        <line
          key={`stub-${i}`}
          x1={0}
          y1={y}
          x2={tx}
          y2={y}
          stroke={STROKE}
          strokeWidth={LINE_W}
        />,
      );
    }
    pinList.push({ x: 0, y, negated: neg });
  }

  // Output bubble for NAND/NOR/XNOR.
  const outBubble = inverted ? (
    <circle
      cx={bodyTipX + BUBBLE_R}
      cy={H / 2}
      r={BUBBLE_R}
      fill={FILL}
      stroke={STROKE}
      strokeWidth={LINE_W}
    />
  ) : null;

  // XOR/XNOR back curve — a second concave arc just behind the body
  // back, offset to the left by `backOffset`. We anchor it at
  // `bodyOriginX − backOffset` (instead of a hard-coded 0) so that an
  // input-bubble shift on the main body also shifts the second arc by
  // the same amount; the two stay parallel either way.
  const xorBack = family === "xor" ? (
    <path
      d={orBackOnly(bodyOriginX - backOffset, bodyW, H)}
      fill="none"
      stroke={STROKE}
      strokeWidth={LINE_W}
    />
  ) : null;

  return {
    svg: (
      <>
        {stubs}
        {xorBack}
        <path
          d={body}
          fill={FILL}
          stroke={STROKE}
          strokeWidth={LINE_W}
          strokeLinejoin="round"
        />
        {bubbles}
        {outBubble}
      </>
    ),
    width: W,
    height: H,
    inputs: pinList,
    output: { x: W, y: H / 2, negated: inverted },
  };
}

/** Closed AND/NAND body path: rectangle on the left, semicircle on the
 *  right. Width `bodyW`, height `H`, semicircle radius = H/2 (so the
 *  rect portion is `bodyW − H/2` wide). Origin offset by `x0` so XOR-
 *  style families can leave room for an external back curve. */
function andPath(x0: number, bodyW: number, H: number): string {
  const r = H / 2;
  const rectW = bodyW - r;
  return [
    `M ${x0} 0`,
    `L ${x0 + rectW} 0`,
    `A ${r} ${r} 0 0 1 ${x0 + rectW} ${H}`,
    `L ${x0} ${H}`,
    `Z`,
  ].join(" ");
}

/** Closed OR/NOR/XOR/XNOR body path. Concave back on the left, pointed
 *  front on the right meeting at `(x0 + bodyW, H/2)`. Constructed from
 *  three cubic Beziers (top edge, bottom edge, back edge). Control
 *  points eyeballed against the standard IEEE OR shape; tweak the 0.45
 *  / 0.55 factors to taste. */
function orPath(x0: number, bodyW: number, H: number): string {
  const tipX = x0 + bodyW;
  const backX = x0 + bodyW * 0.25;
  return [
    `M ${x0} 0`,
    // Top edge curves outward to the front tip.
    `C ${x0 + bodyW * 0.55} 0, ${x0 + bodyW * 0.85} ${H * 0.2}, ${tipX} ${H / 2}`,
    // Bottom edge curves back inward to the bottom-left corner.
    `C ${x0 + bodyW * 0.85} ${H * 0.8}, ${x0 + bodyW * 0.55} ${H}, ${x0} ${H}`,
    // Back edge curves inward (concave) to close back at top-left.
    `C ${backX} ${H * 0.7}, ${backX} ${H * 0.3}, ${x0} 0`,
    `Z`,
  ].join(" ");
}

/** Just the back curve of an OR shape — used for the XOR/XNOR extra
 *  arc that sits offset to the left of the main body. Open path, not
 *  closed. */
function orBackOnly(x0: number, bodyW: number, H: number): string {
  const backX = x0 + bodyW * 0.25;
  return [
    `M ${x0} 0`,
    `C ${backX} ${H * 0.3}, ${backX} ${H * 0.7}, ${x0} ${H}`,
  ].join(" ");
}

// ── Specials ─────────────────────────────────────────────────────────

/** Constant tie: a triangle wedge with the value next to it. Useful for
 *  outputs hard-tied to 0 or 1 (rare but possible in test cells). */
function renderConst(value: 0 | 1): RenderedSymbol {
  const W = 24;
  const H = 16;
  return {
    svg: (
      <>
        <line x1={0} y1={H / 2} x2={W - 8} y2={H / 2} stroke={STROKE} strokeWidth={LINE_W} />
        <line x1={W - 8} y1={4} x2={W - 8} y2={H - 4} stroke={STROKE} strokeWidth={LINE_W} />
        <text
          x={W - 4}
          y={H / 2 + 4}
          fontFamily="var(--mono, ui-monospace)"
          fontSize={11}
          fill="var(--ink2)"
        >
          {value}
        </text>
      </>
    ),
    width: W,
    height: H,
    inputs: [],
    output: { x: 0, y: H / 2 },
  };
}

/** Bare wire — a passthrough net. Shown as a short line with a tiny
 *  hollow circle marker so the user knows there's no logic gate here,
 *  just connectivity. */
function renderWire(input: GateLit): RenderedSymbol {
  const W = 20;
  const H = 8;
  return {
    svg: (
      <>
        <line x1={0} y1={H / 2} x2={W} y2={H / 2} stroke={STROKE} strokeWidth={LINE_W} />
        {input.negated && (
          <circle cx={BUBBLE_R + 1} cy={H / 2} r={BUBBLE_R} fill={FILL} stroke={STROKE} strokeWidth={LINE_W} />
        )}
      </>
    ),
    width: W,
    height: H,
    inputs: [{ x: 0, y: H / 2, negated: input.negated }],
    output: { x: W, y: H / 2 },
  };
}

/**
 * Placeholder for shapes Phase 1 doesn't draw yet (AOI / OAI / AO / OA /
 * compound). Draws a plain rectangle with the gate label inside —
 * functional for visual confirmation that the matcher fired, just
 * unstyled compared to the proper symbols. Phase 2 replaces this with
 * a recursive composition.
 */
function renderPlaceholder(gate: GateMatch): RenderedSymbol {
  const label = gateLabel(gate);
  // Rough width based on label length — mono ~7px per glyph at fontSize 11.
  const W = Math.max(40, label.length * 7 + 12);
  // Approximate arity for height: AOI/OAI/AO/OA flatten groups; compound
  // we just guess.
  const arity =
    gate.kind === "aoi" || gate.kind === "oai" || gate.kind === "ao" || gate.kind === "oa"
      ? gate.groups.reduce((acc, g) => acc + g.length, 0)
      : 3;
  const H = Math.max(D_MIN_H, arity * D_H_PER_INPUT);
  return {
    svg: (
      <>
        <rect
          x={0}
          y={0}
          width={W}
          height={H}
          rx={3}
          fill={FILL}
          stroke={STROKE}
          strokeWidth={LINE_W}
          strokeDasharray={gate.kind === "compound" ? "3 2" : undefined}
        />
        <text
          x={W / 2}
          y={H / 2 + 4}
          textAnchor="middle"
          fontFamily="var(--mono, ui-monospace)"
          fontSize={10.5}
          fill="var(--ink2)"
        >
          {label}
        </text>
      </>
    ),
    width: W,
    height: H,
    inputs: Array.from({ length: arity }, (_, i) => ({
      x: 0,
      y: arity === 1 ? H / 2 : (H * (i + 1)) / (arity + 1),
    })),
    output: { x: W, y: H / 2 },
  };
}

// ── Switches (TG + pass transistor) ────────────────────────────────

/** Half-width of each triangle's base. Total switch width =
 *  `4 * SWITCH_TRI_HALF_W` so the triangle bases sit exactly on the
 *  bounding box's left + right edges (allows WEST/EAST signal ports
 *  to be placed AT the box edge with no internal stubs). */
const SWITCH_TRI_HALF_W = 6;
/** Half-height of each triangle. */
const SWITCH_TRI_HALF_H = 4;
/** Smaller bubble for the gate-side input — sits flush against the
 *  bowtie tip rather than at the top of the bounding box. The default
 *  `BUBBLE_R` is sized for the wider AND/NAND output bubble; on the
 *  narrower TG/pass symbols a smaller one reads cleaner. */
const SWITCH_BUBBLE_R = 2;
/** Wire length from the top port down to either the PMOS bubble's
 *  outer rim or (NMOS case) directly to the bowtie tip. Picked so the
 *  bubble case (wire + bubble = 4 + 4 = 8) and the no-bubble case
 *  (wire alone = 8) both put the bowtie tip at the same y. */
const SWITCH_TOP_WIRE = 4;

/**
 * Transmission gate symbol: PMOS bowtie stacked above an NMOS bowtie,
 * sharing source/drain on the left and right (the canonical TG
 * parallel-MOSFET topology). Four small triangle OUTLINES total — two
 * per bowtie — meeting at the centerline; no surrounding rectangle.
 *
 * Geometry highlights:
 *   - Triangle bases sit exactly on the bounding-box left (x=0) and
 *     right (x=W) edges. The PMOS-to-NMOS parallel-connection
 *     verticals run along those same edges, so the left + right
 *     outlines read as one continuous wire from the top base of the
 *     PMOS triangle down through the NMOS one. WEST + EAST signal
 *     ports land on those verticals at sig-y (the midpoint between
 *     the bowtie centers), no internal stubs.
 *   - Each control wire (top + bottom) extends right to the bowtie
 *     tip (the X-meeting point of the two triangles) — no gap.
 *   - PMOS gate has a small bubble whose bottom touches the PMOS
 *     bowtie tip (IEEE convention for an active-low input). NMOS
 *     gate is bare wire.
 *
 * `inputs` order matches the netlist module's TG port code:
 * [ctrl_p (NORTH), signal_a (WEST), ctrl_n (SOUTH)], output =
 * signal_b (EAST).
 */
export function renderTGSymbol(): RenderedSymbol {
  const triHW = SWITCH_TRI_HALF_W;
  const triHH = SWITCH_TRI_HALF_H;
  const br = SWITCH_BUBBLE_R;
  const W = 4 * triHW; // 24
  const cx = W / 2; // 12
  // Top reserve: wire (SWITCH_TOP_WIRE) + bubble diameter (2*br).
  // Both PMOS and NMOS use the same vertical offset so the bowtie
  // tips line up at y = `topReserve` regardless of bubble presence.
  const topReserve = SWITCH_TOP_WIRE + 2 * br; // 4 + 4 = 8
  const pmosTipY = topReserve;
  // Distance between the PMOS triangle's BOTTOM-base vertex and the
  // NMOS triangle's TOP-base vertex. Tight enough that the symbol
  // doesn't sprawl vertically, loose enough that the parallel
  // connection reads as a separate segment.
  const sigGap = 6;
  const nmosTipY = pmosTipY + triHH + sigGap + triHH;
  // Bottom reserve mirrors the top so the overall symbol is roughly
  // symmetric — wire from NMOS tip down to port.
  const bottomReserve = topReserve;
  const H = nmosTipY + bottomReserve;
  // Signal port y: midway between the two bowtie tips — sits on the
  // parallel-connection vertical that joins the triangle bases.
  const sigY = (pmosTipY + nmosTipY) / 2;

  // Outlined triangle at the bowtie position. The base sits on the
  // x-coord supplied (0 for left, W for right); the tip is at the
  // bowtie's center y on the centerline.
  const triangle = (baseX: number, tipX: number, tipY: number): ReactNode => (
    <polygon
      points={`${baseX},${tipY - triHH} ${tipX},${tipY} ${baseX},${tipY + triHH}`}
      fill="none"
      stroke={STROKE}
      strokeWidth={LINE_W}
      strokeLinejoin="miter"
    />
  );

  return {
    svg: (
      <>
        {/* PMOS control wire from top port to bubble's outer top. */}
        <line
          x1={cx}
          y1={0}
          x2={cx}
          y2={SWITCH_TOP_WIRE}
          stroke={STROKE}
          strokeWidth={LINE_W}
        />
        {/* PMOS bubble — bottom touches the bowtie tip. */}
        <circle
          cx={cx}
          cy={SWITCH_TOP_WIRE + br}
          r={br}
          fill={FILL}
          stroke={STROKE}
          strokeWidth={LINE_W}
        />
        {/* PMOS bowtie. */}
        {triangle(0, cx, pmosTipY)}
        {triangle(W, cx, pmosTipY)}
        {/* Parallel-connection verticals from PMOS bottom-base to NMOS
            top-base on both edges. With the triangle bases at x=0/W
            these wires extend the triangle outlines into a continuous
            left + right edge from the top of the PMOS bowtie to the
            bottom of the NMOS bowtie. The WEST/EAST signal ports sit
            on these verticals at sig-y. */}
        <line
          x1={0}
          y1={pmosTipY + triHH}
          x2={0}
          y2={nmosTipY - triHH}
          stroke={STROKE}
          strokeWidth={LINE_W}
        />
        <line
          x1={W}
          y1={pmosTipY + triHH}
          x2={W}
          y2={nmosTipY - triHH}
          stroke={STROKE}
          strokeWidth={LINE_W}
        />
        {/* NMOS bowtie. */}
        {triangle(0, cx, nmosTipY)}
        {triangle(W, cx, nmosTipY)}
        {/* NMOS control wire from bowtie tip down to bottom port. */}
        <line
          x1={cx}
          y1={nmosTipY}
          x2={cx}
          y2={H}
          stroke={STROKE}
          strokeWidth={LINE_W}
        />
      </>
    ),
    width: W,
    height: H,
    inputs: [
      { x: cx, y: 0, negated: true }, // ctrl_p (NORTH)
      { x: 0, y: sigY }, // signal_a (WEST)
      { x: cx, y: H }, // ctrl_n (SOUTH)
    ],
    output: { x: W, y: sigY }, // signal_b (EAST)
  };
}

/**
 * Pass-transistor symbol: a single bowtie (two outlined triangles
 * meeting at the centerline). Same geometry conventions as the TG —
 * triangle bases sit on x=0/W so the WEST/EAST signal ports land
 * directly on the base midpoints with no internal stubs, control
 * wire extends all the way to the bowtie tip, and PMOS bubble (when
 * present) sits flush against the tip.
 *
 * Input pin order: [gate (NORTH), source (WEST)].
 */
export function renderPassSymbol(type: "pmos" | "nmos"): RenderedSymbol {
  const triHW = SWITCH_TRI_HALF_W;
  const triHH = SWITCH_TRI_HALF_H;
  const br = SWITCH_BUBBLE_R;
  const W = 4 * triHW; // 24
  const cx = W / 2; // 12
  const isPmos = type === "pmos";
  // Both variants reserve the same top space so symbol heights match
  // — PMOS spends it on (wire + bubble), NMOS on (wire alone).
  const topReserve = SWITCH_TOP_WIRE + 2 * br; // 8
  const tipY = topReserve;
  const H = tipY + triHH;
  return {
    svg: (
      <>
        {/* Gate control wire. For PMOS: stops at the bubble's outer
            top. For NMOS: runs all the way to the bowtie tip. */}
        <line
          x1={cx}
          y1={0}
          x2={cx}
          y2={isPmos ? SWITCH_TOP_WIRE : tipY}
          stroke={STROKE}
          strokeWidth={LINE_W}
        />
        {isPmos && (
          <circle
            cx={cx}
            cy={SWITCH_TOP_WIRE + br}
            r={br}
            fill={FILL}
            stroke={STROKE}
            strokeWidth={LINE_W}
          />
        )}
        {/* Bowtie — two outlined triangles. Bases at x=0/W; tips meet
            at (cx, tipY). */}
        <polygon
          points={`0,${tipY - triHH} ${cx},${tipY} 0,${tipY + triHH}`}
          fill="none"
          stroke={STROKE}
          strokeWidth={LINE_W}
          strokeLinejoin="miter"
        />
        <polygon
          points={`${W},${tipY - triHH} ${cx},${tipY} ${W},${tipY + triHH}`}
          fill="none"
          stroke={STROKE}
          strokeWidth={LINE_W}
          strokeLinejoin="miter"
        />
      </>
    ),
    width: W,
    height: H,
    inputs: [
      { x: cx, y: 0, negated: isPmos }, // gate (NORTH)
      { x: 0, y: tipY }, // source (WEST) — at midpoint of left base
    ],
    output: { x: W, y: tipY }, // drain (EAST) — at midpoint of right base
  };
}

// Suppress unused-export linter — renderBuffer is wired up for the
// future BUFFER detection pass (the symbol exists so the dispatch
// table is complete the moment we add it).
void renderBuffer;
