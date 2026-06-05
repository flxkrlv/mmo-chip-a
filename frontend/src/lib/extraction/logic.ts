/**
 * Boolean extraction for inferred cells.
 *
 *   per-domain logic:   walk PDN's SP-tree → f_pdn (AND/OR over gate-net
 *                       literals); output = NOT(f_pdn). For verification,
 *                       walk PUN the same way with negated leaves and
 *                       check it canonicalises to the same expression.
 *
 *   cell-level logic:   chain the domain expressions by substituting
 *                       inter-domain wires until only primary-input nets
 *                       remain. On a feedback cycle, give up — the
 *                       Verilog generator already handles "not trivial"
 *                       by falling back to module instantiation.
 *
 * Lives alongside the rest of the extraction pipeline rather than in
 * `cell.ts` to keep that file from growing further; `cell.ts` just calls
 * the two `extract*Logic` entry points.
 *
 * BoolExpr is the same shape used by the Verilog emitter (`verilog.ts`)
 * — once a cell's `logic` field is populated here, `isTrivialCell()`
 * returns true and the emitter inlines the cell as an `assign` instead
 * of a module instance.
 */

import type { CmosDomain, BoolExpr, ExtractionWarning, Transistor } from "./cell";
import { decompose, type SPEdge, type SPTree } from "../schematic/spTree";

// ── BoolExpr utilities ────────────────────────────────────────────

/**
 * Structural simplification. Operates locally — does NOT push NOTs down
 * via De Morgan, so the display form stays readable (NAND2 surfaces as
 * `~(A & B)` rather than `~A | ~B`). Equivalence checks rely on
 * `canonicalKey` instead, which internally normalises NOT-of-compound
 * during fingerprinting only.
 *
 * What this DOES do:
 *   - flatten n-ary AND/OR (and-of-ands → one AND; same for OR)
 *   - constant folding (AND with 0 → 0, OR with 1 → 1, identities drop)
 *   - double-negation elimination (¬¬x → x)
 *   - dedup commutative children by canonical key (x ∧ x → x)
 *   - x ∧ ¬x → 0 and x ∨ ¬x → 1
 *   - sort children deterministically so identical inputs produce
 *     identical outputs across runs
 */
export function simplifyBoolExpr(e: BoolExpr): BoolExpr {
  switch (e.kind) {
    case "const":
    case "net":
      return e;
    case "not":
      return simplifyNot(simplifyBoolExpr(e.arg));
    case "and":
      return simplifyAndOr("and", e.args.map(simplifyBoolExpr));
    case "or":
      return simplifyAndOr("or", e.args.map(simplifyBoolExpr));
  }
}

/** Double-negation elimination + constant flipping. AND / OR children
 *  remain wrapped: we deliberately don't De Morgan-push so the visible
 *  shape matches the conventional CMOS gate reading. */
function simplifyNot(arg: BoolExpr): BoolExpr {
  switch (arg.kind) {
    case "const":
      return { kind: "const", value: arg.value === 1 ? 0 : 1 };
    case "not":
      return arg.arg; // ¬¬x = x
    case "and":
    case "or":
    case "net":
      return { kind: "not", arg };
  }
}

/**
 * Like `simplifyBoolExpr` but pushes NOTs down to literals via De Morgan.
 * Used as a recognition-only fallback when the readable form ends up as
 * `compound` — multi-domain chains often produce nested NOT-of-AND-of-
 * NOT-of-… shapes that look opaque but are really standard AO/OA/AND/OR
 * cells in disguise.
 *
 * The output is uglier to read (`A | ~B | ~C` instead of `A | ~(B & C)`)
 * which is why the everyday simplifier stays lazy. We only reach for
 * this when the recognizer needs the canonical AND-or-OR-of-literals
 * form to pattern-match against the cell library.
 */
export function simplifyAggressive(e: BoolExpr): BoolExpr {
  switch (e.kind) {
    case "const":
    case "net":
      return e;
    case "not":
      return aggressiveNot(simplifyAggressive(e.arg));
    case "and":
      return simplifyAndOr("and", e.args.map(simplifyAggressive));
    case "or":
      return simplifyAndOr("or", e.args.map(simplifyAggressive));
  }
}

/** De Morgan-aware NOT: pushes negation into AND/OR by flipping the
 *  connective and recursively negating children. Combined with the
 *  flatten/dedup logic in `simplifyAndOr`, this turns nested NOT shapes
 *  into a canonical AND-or-OR-of-literals form. */
function aggressiveNot(arg: BoolExpr): BoolExpr {
  switch (arg.kind) {
    case "const":
      return { kind: "const", value: arg.value === 1 ? 0 : 1 };
    case "not":
      return arg.arg;
    case "and":
      return simplifyAndOr("or", arg.args.map(aggressiveNot));
    case "or":
      return simplifyAndOr("and", arg.args.map(aggressiveNot));
    case "net":
      return { kind: "not", arg };
  }
}

/**
 * Flatten + dedup + identity rules for a single AND or OR node, given its
 * already-simplified children.
 *
 * Identities applied:
 *   AND: 0 absorbs, 1 drops, no args → 1, single arg → that arg, x∧x = x,
 *        x∧¬x = 0.
 *   OR:  1 absorbs, 0 drops, no args → 0, single arg → that arg, x∨x = x,
 *        x∨¬x = 1.
 */
function simplifyAndOr(kind: "and" | "or", children: BoolExpr[]): BoolExpr {
  const flat: BoolExpr[] = [];
  for (const c of children) {
    if (c.kind === kind) flat.push(...c.args);
    else flat.push(c);
  }
  // Constant folding.
  const absorb = kind === "and" ? 0 : 1;
  const ident = kind === "and" ? 1 : 0;
  const filtered: BoolExpr[] = [];
  for (const c of flat) {
    if (c.kind === "const") {
      if (c.value === absorb) return { kind: "const", value: absorb };
      // identity → drop
      continue;
    }
    filtered.push(c);
  }
  // Dedup by canonical key. Sorted so identical input expressions produce
  // identical keys — required for the PUN vs ¬PDN equivalence check.
  const byKey = new Map<string, BoolExpr>();
  for (const c of filtered) {
    byKey.set(canonicalKey(c), c);
  }
  // x ∧ ¬x = 0 (and dual).
  const keys = Array.from(byKey.keys());
  for (const k of keys) {
    const negK = k.startsWith("~") ? k.slice(1) : `~${k}`;
    if (byKey.has(negK)) return { kind: "const", value: absorb };
  }
  const out = Array.from(byKey.values()).sort((a, b) =>
    canonicalKey(a) < canonicalKey(b) ? -1 : 1,
  );
  if (out.length === 0) return { kind: "const", value: ident };
  if (out.length === 1) return out[0];
  return kind === "and" ? { kind: "and", args: out } : { kind: "or", args: out };
}

/**
 * Stable structural fingerprint used for equivalence checks (PUN vs ¬PDN
 * dual verify) AND for dedup inside the simplifier.
 *
 * Critically, the key computation normalises NOTs down to literals via De
 * Morgan internally — even though the stored expression keeps NOTs at
 * the top of compound subtrees (for readability). That way ¬(A ∧ B) and
 * ¬A ∨ ¬B both hash to `|(~nA|~nB)`, so the dual check fires correctly
 * and dedup catches both forms when they appear as children of a wider
 * AND/OR.
 *
 * Encoding: `0`/`1` for constants, `nN` for net N, `~nN` for ¬N, and
 * `&(…|…)` / `|(…|…)` for AND/OR with `|`-separated sorted child keys.
 */
export function canonicalKey(e: BoolExpr): string {
  return keyOf(e, false);
}

function keyOf(e: BoolExpr, negated: boolean): string {
  switch (e.kind) {
    case "const": {
      const v = negated ? (e.value === 1 ? 0 : 1) : e.value;
      return v === 1 ? "1" : "0";
    }
    case "net":
      return negated ? `~n${e.net}` : `n${e.net}`;
    case "not":
      return keyOf(e.arg, !negated);
    case "and": {
      // ¬(a∧b…) ≡ ¬a∨¬b… → swap connective + negate children when the
      // accumulated negation flag is on.
      const op = negated ? "|" : "&";
      const keys = e.args.map((c) => keyOf(c, negated)).sort();
      return `${op}(${keys.join("|")})`;
    }
    case "or": {
      const op = negated ? "&" : "|";
      const keys = e.args.map((c) => keyOf(c, negated)).sort();
      return `${op}(${keys.join("|")})`;
    }
  }
}

/**
 * Pretty-print for the right panel + status bar. `netName(id)` resolves a
 * net id to whatever label the caller wants (raw `net42`, or the user's
 * VCC/GND/OUTPUT label, etc.).
 *
 * Standard precedence: NOT binds tightest, then AND, then OR. Parens
 * appear only when needed by the parent's precedence to keep the output
 * compact (e.g. `~a & b | c` instead of `((~a) & b) | c`).
 */
export function formatBoolExpr(
  e: BoolExpr,
  netName: (netId: number) => string,
): string {
  return printAt(e, 0, netName);
}

const PREC: Record<BoolExpr["kind"], number> = {
  const: 3,
  net: 3,
  not: 3,
  and: 2,
  or: 1,
};

function printAt(
  e: BoolExpr,
  parentPrec: number,
  netName: (netId: number) => string,
): string {
  const myPrec = PREC[e.kind];
  let out: string;
  switch (e.kind) {
    case "const":
      out = e.value === 1 ? "1" : "0";
      break;
    case "net":
      out = netName(e.net);
      break;
    case "not":
      out = `~${printAt(e.arg, PREC.not, netName)}`;
      break;
    case "and":
      out = e.args.map((c) => printAt(c, PREC.and, netName)).join(" & ");
      break;
    case "or":
      out = e.args.map((c) => printAt(c, PREC.or, netName)).join(" | ");
      break;
  }
  return myPrec < parentPrec ? `(${out})` : out;
}

// ── Domain logic extraction ───────────────────────────────────────

/**
 * Build the Boolean expression of `domain`'s output net by walking its
 * pull-down network's SP-tree. The pull-up network is walked too as a
 * cross-check — the PUN-active expression should canonicalise to the
 * same value as NOT(f_PDN) by De Morgan duality.
 *
 * Returns a `{ logic, warnings }` pair; `logic` is undefined when:
 *   - the PDN isn't series-parallel (we'd need a BDD to handle bridge
 *     topologies, deferred for now)
 *   - the domain has no transistors on the side we need (single-rail
 *     "domain" — already warned about upstream)
 *
 * Walk rules:
 *   PDN: leaf = lit(gate), series = AND, parallel = OR. NMOS conducts
 *        when gate=1, so an "is on" path stack gives f_PDN(g…).
 *   PUN: leaf = NOT(lit(gate)), series = AND, parallel = OR. PMOS
 *        conducts when gate=0, so its "is on" path collapses to a
 *        product of ¬g terms.
 */
export interface DomainLogicResult {
  /** The output's boolean function, already simplified. Undefined when
   *  extraction couldn't proceed (non-SP, missing PDN, etc.). */
  logic?: BoolExpr;
  warnings: ExtractionWarning[];
}

export function extractDomainLogic(
  domain: CmosDomain,
  transistorsById: Map<string, Transistor>,
  vccNetId: number,
  gndNetId: number,
): DomainLogicResult {
  const warnings: ExtractionWarning[] = [];
  // Only one output net is supported; multi-output domains are flagged
  // upstream as MERGED_DOMAINS and we don't try to derive their function.
  if (domain.outputNetIds.length !== 1) {
    return { warnings };
  }
  const outputNetId = domain.outputNetIds[0];

  const pdnTs = collectTransistors(domain.nmosTransistorIds, transistorsById);
  const punTs = collectTransistors(domain.pmosTransistorIds, transistorsById);
  const pdnEdges = transistorsToEdges(pdnTs);
  const punEdges = transistorsToEdges(punTs);

  // Either side can fail individually (non-SP, empty stack). We try both
  // and use whichever gives us a definitive answer — preferring PDN
  // because its walk yields f_pdn directly and is the standard CMOS form.
  const pdnTree = pdnEdges.length > 0 ? decompose(outputNetId, gndNetId, pdnEdges) : null;
  const punTree = punEdges.length > 0 ? decompose(vccNetId, outputNetId, punEdges) : null;
  const gateOf = (tid: string) => transistorsById.get(tid)?.gate.netId ?? -1;

  const pdnExpr = pdnTree
    ? walkSp(pdnTree, (tid) => ({ kind: "net", net: gateOf(tid) }))
    : null;
  const punExpr = punTree
    ? walkSp(punTree, (tid) => ({
        kind: "not",
        arg: { kind: "net", net: gateOf(tid) },
      }))
    : null;

  if (!pdnExpr && !punExpr) {
    // Neither side is SP — likely a bridge/XOR-via-passes topology. We
    // already render those as "non-SP" in the schematic; mirror that
    // here without re-warning (the schematic message is enough; this
    // pass would just duplicate it).
    return { warnings };
  }

  // Cross-check: simplify(NOT(pdn)) should equal simplify(pun). When one
  // side wasn't available we trust the other side blindly; the check
  // only fires when both succeeded.
  const outputFromPdn = pdnExpr ? simplifyBoolExpr({ kind: "not", arg: pdnExpr }) : null;
  const outputFromPun = punExpr ? simplifyBoolExpr(punExpr) : null;
  let logic: BoolExpr | undefined;
  if (outputFromPdn && outputFromPun) {
    if (canonicalKey(outputFromPdn) !== canonicalKey(outputFromPun)) {
      warnings.push({
        severity: "warning",
        code: "PUN_PDN_MISMATCH",
        message:
          `domain output net${outputNetId}: PUN and PDN imply different functions ` +
          `(PDN → ${formatBoolExpr(outputFromPdn, (n) => `net${n}`)}; ` +
          `PUN → ${formatBoolExpr(outputFromPun, (n) => `net${n}`)})`,
        refs: { netIds: [outputNetId] },
      });
      // Prefer the PDN-derived expression — it's the conventional
      // analysis form and the dual mismatch is more often a layout bug
      // (missing PMOS branch) than a PDN issue.
      logic = outputFromPdn;
    } else {
      logic = outputFromPdn;
    }
  } else {
    logic = outputFromPdn ?? outputFromPun ?? undefined;
  }
  return { logic, warnings };
}

function collectTransistors(
  ids: string[],
  by: Map<string, Transistor>,
): Transistor[] {
  const out: Transistor[] = [];
  for (const id of ids) {
    const t = by.get(id);
    if (t) out.push(t);
  }
  return out;
}

function transistorsToEdges(ts: Transistor[]): SPEdge[] {
  return ts.map((t) => ({ id: t.id, a: t.source.netId, b: t.drain.netId }));
}

/** Generic SP-tree walker. The leaf callback receives the transistor id
 *  and returns the expression that leaf contributes (a literal for PDN,
 *  a negated literal for PUN). Series → AND, parallel → OR. */
function walkSp(
  tree: SPTree,
  leaf: (transistorId: string) => BoolExpr,
): BoolExpr {
  switch (tree.kind) {
    case "leaf":
      return leaf(tree.transistorId);
    case "series":
      return { kind: "and", args: tree.parts.map((p) => walkSp(p, leaf)) };
    case "parallel":
      return { kind: "or", args: tree.branches.map((b) => walkSp(b, leaf)) };
  }
}

// ── Cell-level chain ──────────────────────────────────────────────

/**
 * Build the boolean expression for the cell's primary output by chaining
 * the per-domain expressions: any net id in a domain's expression that
 * itself is the output of another domain is recursively substituted with
 * that other domain's expression.
 *
 * Returns `null` when:
 *   - There isn't exactly one primary output net (multi-output cells
 *     don't have a single `cell.logic` — the Verilog generator still
 *     uses each domain individually).
 *   - That output isn't the output of any domain.
 *   - The dependency graph has a cycle (sequential feedback) — leaves
 *     `cell.logic` unset so `isTrivialCell` returns false and the
 *     Verilog generator falls back to module instantiation. This is the
 *     "we don't need real sequential detection" path discussed
 *     elsewhere: cycle = sequential = not-trivial = instance, no further
 *     analysis required.
 */
export function chainCellLogic(
  domains: CmosDomain[],
  primaryOutputNetId: number | null,
): BoolExpr | null {
  if (primaryOutputNetId == null) return null;

  // Index domains by their single output net so substitution is O(1).
  // Domains with multi-output (MERGED_DOMAINS) are skipped — their
  // ambiguity would force-stop the chain anyway.
  const byOutput = new Map<number, CmosDomain>();
  for (const d of domains) {
    if (d.outputNetIds.length === 1 && d.logic) {
      byOutput.set(d.outputNetIds[0], d);
    }
  }

  const root = byOutput.get(primaryOutputNetId);
  if (!root || !root.logic) return null;

  // DFS substitution with cycle detection. `inProgress` catches feedback
  // loops (the storage loop of a latch / flop will trip this).
  const inProgress = new Set<number>();
  let cycleHit = false;

  const subst = (expr: BoolExpr): BoolExpr => {
    if (cycleHit) return expr;
    switch (expr.kind) {
      case "const":
        return expr;
      case "net": {
        const sub = byOutput.get(expr.net);
        if (!sub || !sub.logic) return expr; // primary input — leave as net leaf
        if (inProgress.has(expr.net)) {
          cycleHit = true;
          return expr;
        }
        inProgress.add(expr.net);
        const replaced = subst(sub.logic);
        inProgress.delete(expr.net);
        return replaced;
      }
      case "not":
        return { kind: "not", arg: subst(expr.arg) };
      case "and":
        return { kind: "and", args: expr.args.map(subst) };
      case "or":
        return { kind: "or", args: expr.args.map(subst) };
    }
  };

  inProgress.add(primaryOutputNetId);
  const chained = subst(root.logic);
  inProgress.delete(primaryOutputNetId);
  if (cycleHit) return null;
  return simplifyBoolExpr(chained);
}
