/**
 * Gate-shape recognition for a single domain's `BoolExpr`.
 *
 * Takes the simplified boolean expression and labels it as one of the
 * standard CMOS combinational gates (INV, NAND, NOR, AND, OR, XOR, XNOR,
 * AOI, OAI) — or `compound` when the shape doesn't fit a single library
 * cell and needs a recursive sub-tree render.
 *
 * Per-domain only. Cell-level recognition (e.g. NAND+INV chain → AND2)
 * runs later, on the chained `cell.logic`. Buffer detection is
 * intentionally absent here: a buffer is two physical inverters →
 * two domains, and the boolean form of each domain individually is just
 * INV. The "buffer" label belongs to the cell-level pass.
 *
 * Pattern set + names below; see README/specs for the dispatch rules.
 */

import type { BoolExpr } from "./cell";
import { simplifyAggressive } from "./logic";

/**
 * One input pin of a recognized gate. `negated: true` means draw a
 * bubble on that pin — equivalent to feeding the gate from an INV but
 * collapsed visually into a single symbol, which is how standard cell
 * libraries draw it.
 */
export interface GateLit {
  netId: number;
  negated: boolean;
}

/**
 * Recognized gate label for one domain's logic.
 *
 * Naming conventions:
 *   - simple gates (and/or/nand/nor/xor/xnor): n-input, no arity in the
 *     `kind` — the consumer reads it from `inputs.length`.
 *   - AOI / OAI: `groups[i]` is the i-th sub-network (an AND group for
 *     AOI, an OR group for OAI). Single-literal groups represent inputs
 *     that bypass the inner network (so AOI21 has groups
 *     `[[A,B], [C]]`). Display name is built from group sizes sorted
 *     descending: AOI21, AOI22, AOI211, AOI31, …
 *   - compound: carries the raw expression for recursive rendering.
 */
export type GateMatch =
  | { kind: "const"; value: 0 | 1 }
  | { kind: "wire"; input: GateLit }
  | { kind: "inv"; input: GateLit }
  | { kind: "and" | "or" | "nand" | "nor"; inputs: GateLit[] }
  | { kind: "xor" | "xnor"; inputs: [GateLit, GateLit] }
  | { kind: "aoi" | "oai"; groups: GateLit[][] }
  /** And-Or / Or-And (no final invert). The dual of AOI / OAI without
   *  the outer NOT, i.e. what `chainCellLogic` produces when an AOIxy
   *  domain is followed by an INV domain (AOI + INV = AO; OAI + INV =
   *  OA). Same `groups[][]` shape. Names: AO21, AO22, AO211, OA31, … */
  | { kind: "ao" | "oa"; groups: GateLit[][] }
  | { kind: "compound"; expr: BoolExpr };

// ── Recognizer ──────────────────────────────────────────────────────

/**
 * Pattern-match `expr` against the standard cell library. Pure function
 * — call it on demand or store the result alongside the expression.
 *
 * Two-stage strategy:
 *   1. Try the expression as-is. This works for everything that's
 *      already in a clean shape (single-domain cells; multi-domain
 *      chains whose readable simplified form happens to be flat).
 *   2. If stage 1 returns `compound`, re-run against the aggressively
 *      De Morgan-pushed form. Multi-domain chains like NAND→NAND or
 *      NAND→NOR→NAND produce nested NOT-of-AND-of-NOT shapes that look
 *      opaque to the readable simplifier but are real AO/OA/AND/OR
 *      cells in disguise — the aggressive form exposes them.
 *
 * Order inside the dispatcher matters: we try the most specific
 * patterns first (INV / NAND / NOR / XOR) before falling through to
 * compound, so a real NAND2 doesn't get caught by the general arm.
 */
export function recognizeGate(expr: BoolExpr): GateMatch {
  const first = dispatch(expr);
  if (first.kind !== "compound") return first;
  // Fallback: try with De Morgan pushed all the way down. We don't
  // touch the caller's stored expression — the recognised label is the
  // only thing that improves; display continues to read off the
  // original (readable) form.
  const aggressive = simplifyAggressive(expr);
  const second = dispatch(aggressive);
  if (second.kind !== "compound") return second;
  // Both forms compound — carry the ORIGINAL expression so the UI shows
  // the readable shape, not the De Morgan-exploded one.
  return { kind: "compound", expr };
}

/** The actual structural matcher. Stateless; both passes share it. */
function dispatch(expr: BoolExpr): GateMatch {
  switch (expr.kind) {
    case "const":
      return { kind: "const", value: expr.value };
    case "net":
      // A bare net leaf at the domain level is unusual — would mean
      // "output = input directly" with no transistor work, which CMOS
      // doesn't realise. Emit as a wire so the UI surfaces the
      // pass-through rather than crashing.
      return { kind: "wire", input: { netId: expr.net, negated: false } };
    case "not":
      return recognizeNot(expr.arg, expr);
    case "and": {
      const lits = allLiterals(expr.args);
      if (lits) return { kind: "and", inputs: lits };
      // OA: top-level AND of OR-groups or literals — the cell-level
      // shape of OAIxy + INV after the chain collapses the double-NOT.
      const groups = expr.args.map((c) => asLitGroup(c, "or"));
      if (groups.every((g) => g != null)) {
        return { kind: "oa", groups: groups as GateLit[][] };
      }
      return { kind: "compound", expr };
    }
    case "or": {
      // XOR / XNOR before plain OR — both surface as top-level OR after
      // simplification, but the structural fingerprint is specific.
      const xx = tryXorXnor(expr);
      if (xx) return xx;
      const lits = allLiterals(expr.args);
      if (lits) return { kind: "or", inputs: lits };
      // AO: top-level OR of AND-groups or literals — the cell-level
      // shape of AOIxy + INV after the chain collapses the double-NOT.
      const groups = expr.args.map((c) => asLitGroup(c, "and"));
      if (groups.every((g) => g != null)) {
        return { kind: "ao", groups: groups as GateLit[][] };
      }
      return { kind: "compound", expr };
    }
  }
}

/** Dispatcher for the NOT-of-X family: INV, NAND, NOR, AOI, OAI. */
function recognizeNot(inner: BoolExpr, full: BoolExpr): GateMatch {
  // ~net → INV. (The simplifier already collapsed ~~net to net, so we
  // know `inner` isn't another NOT here.)
  if (inner.kind === "net") {
    return { kind: "inv", input: { netId: inner.net, negated: false } };
  }
  if (inner.kind === "const") {
    // ~0 → const 1, ~1 → const 0. The simplifier already folds this,
    // but guard anyway in case a caller skips simplification.
    return { kind: "const", value: inner.value === 1 ? 0 : 1 };
  }
  if (inner.kind === "and") {
    // ~AND(literals) → NAND. ~AND(OR-groups or literals) → OAI.
    const lits = allLiterals(inner.args);
    if (lits) return { kind: "nand", inputs: lits };
    const groups = inner.args.map((c) => asLitGroup(c, "or"));
    if (groups.every((g) => g != null)) {
      return { kind: "oai", groups: groups as GateLit[][] };
    }
    return { kind: "compound", expr: full };
  }
  if (inner.kind === "or") {
    // ~OR(literals) → NOR. ~OR(AND-groups or literals) → AOI.
    const lits = allLiterals(inner.args);
    if (lits) return { kind: "nor", inputs: lits };
    const groups = inner.args.map((c) => asLitGroup(c, "and"));
    if (groups.every((g) => g != null)) {
      return { kind: "aoi", groups: groups as GateLit[][] };
    }
    return { kind: "compound", expr: full };
  }
  // ~~X already collapsed by simplifier; anything else falls through.
  return { kind: "compound", expr: full };
}

/**
 * Detect a 2-input XOR or XNOR after simplification leaves it as the
 * canonical sum-of-products form:
 *   XOR(A,B)  = (A ∧ ¬B) ∨ (¬A ∧ B)   — each AND has exactly one ¬
 *   XNOR(A,B) = (A ∧ B) ∨ (¬A ∧ ¬B)    — one AND has 0, the other has 2
 *
 * Both have:
 *   - exactly 2 OR-children, each a 2-literal AND,
 *   - 2 distinct nets total across the 4 literals.
 *
 * The negation distribution discriminates XOR from XNOR.
 */
function tryXorXnor(expr: BoolExpr): GateMatch | null {
  if (expr.kind !== "or" || expr.args.length !== 2) return null;
  const [a, b] = expr.args;
  if (a.kind !== "and" || b.kind !== "and") return null;
  if (a.args.length !== 2 || b.args.length !== 2) return null;
  const aLits = allLiterals(a.args);
  const bLits = allLiterals(b.args);
  if (!aLits || !bLits) return null;
  const nets = new Set<number>();
  for (const l of [...aLits, ...bLits]) nets.add(l.netId);
  if (nets.size !== 2) return null;
  // Each distinct net must appear exactly twice across the four
  // literals — otherwise it's not the canonical XOR/XNOR shape.
  const occur = new Map<number, number>();
  for (const l of [...aLits, ...bLits]) {
    occur.set(l.netId, (occur.get(l.netId) ?? 0) + 1);
  }
  for (const c of occur.values()) if (c !== 2) return null;

  const negA = aLits.filter((l) => l.negated).length;
  const negB = bLits.filter((l) => l.negated).length;
  const [n1, n2] = Array.from(nets).sort((x, y) => x - y);
  const inputs: [GateLit, GateLit] = [
    { netId: n1, negated: false },
    { netId: n2, negated: false },
  ];

  if (negA === 1 && negB === 1) {
    // XOR — confirm each net is negated exactly once across the 4 literals.
    const negCounts = new Map<number, number>();
    for (const l of [...aLits, ...bLits]) {
      if (l.negated) {
        negCounts.set(l.netId, (negCounts.get(l.netId) ?? 0) + 1);
      }
    }
    for (const c of negCounts.values()) if (c !== 1) return null;
    return { kind: "xor", inputs };
  }
  if ((negA === 0 && negB === 2) || (negA === 2 && negB === 0)) {
    // XNOR — the all-negated AND must negate each distinct net exactly once.
    const fullyNeg = negA === 2 ? aLits : bLits;
    const negSet = new Set(fullyNeg.map((l) => l.netId));
    if (negSet.size !== 2) return null;
    return { kind: "xnor", inputs };
  }
  return null;
}

// ── Literal helpers ──────────────────────────────────────────────────

/** A literal is `net N` or `¬net N`. Anything else (compound subtree,
 *  nested AND/OR, constant) returns null. */
function asLit(e: BoolExpr): GateLit | null {
  if (e.kind === "net") return { netId: e.net, negated: false };
  if (e.kind === "not" && e.arg.kind === "net") {
    return { netId: e.arg.net, negated: true };
  }
  return null;
}

/** Convert a list of expressions to literals all-or-nothing. */
function allLiterals(args: BoolExpr[]): GateLit[] | null {
  const out: GateLit[] = [];
  for (const a of args) {
    const l = asLit(a);
    if (!l) return null;
    out.push(l);
  }
  return out;
}

/**
 * For AOI/OAI group matching: returns the literals inside `e` if it's
 * already an AND-or-OR of literals (`op` = the connective expected), or
 * `[e-as-literal]` if `e` is itself a literal (= a single-input group).
 * Anything else (nested compound) returns null and forces the caller to
 * fall back to `compound`.
 */
function asLitGroup(e: BoolExpr, op: "and" | "or"): GateLit[] | null {
  const lit = asLit(e);
  if (lit) return [lit];
  if (e.kind === op) return allLiterals(e.args);
  return null;
}

// ── Display ─────────────────────────────────────────────────────────

/**
 * Short human-readable label — what shows up as a chip in the right
 * panel. Examples: "INV", "NAND2", "NAND2B1", "NOR3", "XOR",
 * "AOI21", "AOI21B1", "AOI221", "OAI22", "compound".
 *
 * AOI / OAI / AO / OA group-size suffix: sorted descending so different
 * orderings of the same shape produce the same label. e.g. groups
 * [[A], [B,C]] and [[B,C], [A]] both render as "AOI21".
 *
 * "Bn" suffix: standard cell-library convention for n inverted (bubbled)
 * inputs — `~(A & ~B) → NAND2B1`, `(A & ~B) | ~C → AO21B2`. Surfaces
 * the bubble count so the label conveys the actual function rather
 * than letting the bubbles only appear in the rendered symbol.
 */
export function gateLabel(g: GateMatch): string {
  switch (g.kind) {
    case "const":
      return `CONST${g.value}`;
    case "wire":
      return "WIRE";
    case "inv":
      // INV's "bubble" is the output inversion; an input-side bubble
      // is the rare double-negation case the simplifier already
      // collapses, so we don't expect to see one here. Keep the label
      // as bare "INV" either way.
      return "INV";
    case "and":
    case "or":
    case "nand":
    case "nor":
      return `${g.kind.toUpperCase()}${g.inputs.length}${bubbleSuffix(g.inputs)}`;
    case "xor":
    case "xnor":
      return `${g.kind.toUpperCase()}${bubbleSuffix(g.inputs)}`;
    case "aoi":
    case "oai":
    case "ao":
    case "oa": {
      const sizes = g.groups
        .map((grp) => grp.length)
        .sort((a, b) => b - a)
        .join("");
      // Bubbles across all groups — an AOI21 with one ~A literal in
      // the size-2 group and a clean C in the size-1 group still
      // counts as "B1" regardless of group membership.
      const allLits = g.groups.flat();
      return `${g.kind.toUpperCase()}${sizes}${bubbleSuffix(allLits)}`;
    }
    case "compound":
      return "compound";
  }
}

/** `"B<n>"` when at least one literal is negated, else empty. The
 *  count is the number of bubbled inputs (regardless of which); enough
 *  for users to spot the shape without spelling out positions. */
function bubbleSuffix(lits: ReadonlyArray<GateLit>): string {
  let n = 0;
  for (const l of lits) if (l.negated) n++;
  return n > 0 ? `B${n}` : "";
}

/**
 * The arity of a gate (number of distinct net inputs across all pins).
 * Useful for sizing schematic symbols. For AOI/OAI we sum the group
 * sizes since each pin is a separate net (the matcher already rejected
 * shared inputs by reading literals out of the AST as-is).
 */
export function gateArity(g: GateMatch): number {
  switch (g.kind) {
    case "const":
      return 0;
    case "wire":
    case "inv":
      return 1;
    case "and":
    case "or":
    case "nand":
    case "nor":
    case "xor":
    case "xnor":
      return g.inputs.length;
    case "aoi":
    case "oai":
    case "ao":
    case "oa":
      return g.groups.reduce((acc, grp) => acc + grp.length, 0);
    case "compound":
      // Best-effort: count distinct net leaves in the expression.
      return countNets(g.expr).size;
  }
}

function countNets(e: BoolExpr, into: Set<number> = new Set()): Set<number> {
  switch (e.kind) {
    case "net":
      into.add(e.net);
      return into;
    case "const":
      return into;
    case "not":
      return countNets(e.arg, into);
    case "and":
    case "or":
      for (const a of e.args) countNets(a, into);
      return into;
  }
}
