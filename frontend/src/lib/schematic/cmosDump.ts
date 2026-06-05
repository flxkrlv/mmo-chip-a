/**
 * Transistor-level (CMOS) text dump of a cell.
 *
 * Counterpart to `netlistDump.ts`. Where that one renders the cell
 * as a logic netlist (domains-as-gates, TGs as switches), this one
 * stays at the MOSFET level — every transistor with its type, gate,
 * source, drain, and structural role (PUN / PDN of which domain, TG
 * half, pass, dummy). The format is LLM-friendly: paste into a chat
 * and ask "is this NAND2 correctly extracted?" or "what does this
 * sequential cell look like at the transistor level?".
 *
 * Both dumps share the same `netName` resolver so user-labelled
 * inputs / outputs / rails appear by name; unlabeled nets fall back
 * to `netN`.
 */

import type { InferredCellExtraction, Transistor } from "../extraction";
import { formatBoolExpr } from "../extraction";
import { decompose, type SPEdge, type SPTree } from "./spTree";

export function dumpCmos(
  extraction: InferredCellExtraction,
  netName: (id: number) => string,
  activeDomainId?: string | null,
): string {
  const lines: string[] = [];
  const push = (s = "") => lines.push(s);

  const pmosCount = extraction.transistors.filter(
    (t) => t.type === "pmos",
  ).length;
  const nmosCount = extraction.transistors.filter(
    (t) => t.type === "nmos",
  ).length;

  push(`=== CMOS transistor-level dump ===`);
  push(
    `${extraction.transistors.length} transistors (${pmosCount} PMOS / ${nmosCount} NMOS) · ` +
      `${extraction.domains.length} domain(s) · ${extraction.transmissionGates.length} TG(s)`,
  );
  if (activeDomainId) {
    push(`Active domain in schematic view: ${activeDomainId}`);
  }
  push();

  // ── Nets ─────────────────────────────────────────────────
  push(`Nets:`);
  for (const n of [...extraction.nets].sort((a, b) => a.id - b.id)) {
    const tag = n.label ? `(label=${n.label})` : "";
    push(`  ${netName(n.id)} [${n.role ?? "?"}] ${tag}`.trimEnd());
  }
  push();

  // Pre-compute "which domain (or TG, pass) does each transistor
  // belong to?" so the transistor listing can show structural role.
  type Membership =
    | { kind: "domain"; domainId: string; side: "pun" | "pdn" }
    | { kind: "tg"; tgId: string }
    | { kind: "pass" }
    | { kind: "dummy" }
    | { kind: "unknown" }
    | { kind: "free" };
  const membership = new Map<string, Membership>();
  for (const d of extraction.domains) {
    for (const id of d.pmosTransistorIds) {
      membership.set(id, { kind: "domain", domainId: d.id, side: "pun" });
    }
    for (const id of d.nmosTransistorIds) {
      membership.set(id, { kind: "domain", domainId: d.id, side: "pdn" });
    }
  }
  for (const tg of extraction.transmissionGates) {
    membership.set(tg.pmosTransistorId, { kind: "tg", tgId: tg.id });
    membership.set(tg.nmosTransistorId, { kind: "tg", tgId: tg.id });
  }
  for (const t of extraction.transistors) {
    if (membership.has(t.id)) continue;
    if (t.role === "pass") membership.set(t.id, { kind: "pass" });
    else if (t.role === "dummy") membership.set(t.id, { kind: "dummy" });
    else if (t.role === "unknown") membership.set(t.id, { kind: "unknown" });
    else membership.set(t.id, { kind: "free" });
  }

  // ── Transistors (grouped P / N) ──────────────────────────
  const fmtMembership = (m: Membership): string => {
    switch (m.kind) {
      case "domain":
        return `${m.side.toUpperCase()} of ${m.domainId}`;
      case "tg":
        return `TG ${m.tgId}`;
      case "pass":
        return "pass";
      case "dummy":
        return "dummy";
      case "unknown":
        return "unknown";
      case "free":
        return "unclassified";
    }
  };
  const fmtTx = (t: Transistor) => {
    const m = membership.get(t.id) ?? { kind: "free" };
    return (
      `  ${t.id} [${fmtMembership(m)}]: ` +
      `gate=${netName(t.gate.netId)}, ` +
      `S=${netName(t.source.netId)}, ` +
      `D=${netName(t.drain.netId)}`
    );
  };
  const sortByMembershipThenId = (a: Transistor, b: Transistor): number => {
    const ma = membership.get(a.id)!;
    const mb = membership.get(b.id)!;
    const keyOf = (m: Membership): string => {
      switch (m.kind) {
        case "domain":
          return `0:${m.domainId}:${m.side}`;
        case "tg":
          return `1:${m.tgId}`;
        case "pass":
          return `2:pass`;
        case "dummy":
          return `3:dummy`;
        case "unknown":
          return `4:unknown`;
        case "free":
          return `5:free`;
      }
    };
    const ka = keyOf(ma);
    const kb = keyOf(mb);
    if (ka !== kb) return ka < kb ? -1 : 1;
    return a.id < b.id ? -1 : 1;
  };
  const pmosTx = extraction.transistors
    .filter((t) => t.type === "pmos")
    .sort(sortByMembershipThenId);
  const nmosTx = extraction.transistors
    .filter((t) => t.type === "nmos")
    .sort(sortByMembershipThenId);
  const unknownTx = extraction.transistors.filter((t) => t.type === "unknown");

  if (pmosTx.length > 0) {
    push(`PMOS transistors:`);
    for (const t of pmosTx) push(fmtTx(t));
    push();
  }
  if (nmosTx.length > 0) {
    push(`NMOS transistors:`);
    for (const t of nmosTx) push(fmtTx(t));
    push();
  }
  if (unknownTx.length > 0) {
    push(`Unknown-type transistors (parent diffusion couldn't be classified):`);
    for (const t of unknownTx) push(fmtTx(t));
    push();
  }

  // ── Domains with SP topology ─────────────────────────────
  if (extraction.domains.length > 0) {
    push(`Domains (CMOS combinational gates):`);
    const tById = new Map(extraction.transistors.map((t) => [t.id, t]));
    for (const d of extraction.domains) {
      const out = d.outputNetIds.map(netName).join(", ") || "(none)";
      push(`  ${d.id}:`);
      push(`    output:      ${out}`);
      push(
        `    PUN (PMOS):  [${d.pmosTransistorIds.join(", ")}]` +
          spTopologyLine(d.pmosTransistorIds, tById, d.outputNetIds[0], "pun"),
      );
      push(
        `    PDN (NMOS):  [${d.nmosTransistorIds.join(", ")}]` +
          spTopologyLine(d.nmosTransistorIds, tById, d.outputNetIds[0], "pdn"),
      );
      if (d.logic) {
        push(`    boolean:     ${out} = ${formatBoolExpr(d.logic, netName)}`);
      } else {
        push(`    boolean:     (non-SP — couldn't derive)`);
      }
    }
    push();
  }

  // ── Transmission gates ───────────────────────────────────
  if (extraction.transmissionGates.length > 0) {
    push(`Transmission gates (PMOS + NMOS bidirectional switch):`);
    for (const tg of extraction.transmissionGates) {
      push(`  ${tg.id}:`);
      push(`    PMOS half: ${tg.pmosTransistorId}`);
      push(`    NMOS half: ${tg.nmosTransistorId}`);
      push(
        `    ctrl_p (active-low):  ${netName(tg.controlPmosGateNetId)}`,
      );
      push(
        `    ctrl_n (active-high): ${netName(tg.controlNmosGateNetId)}`,
      );
      push(
        `    bridge: ${netName(tg.bridgedNetIds[0])} <-> ${netName(tg.bridgedNetIds[1])}`,
      );
    }
    push();
  }

  // ── Warnings ─────────────────────────────────────────────
  if (extraction.warnings.length > 0) {
    push(`Warnings (${extraction.warnings.length}):`);
    for (const w of extraction.warnings) {
      push(`  [${w.severity}] ${w.code}: ${w.message}`);
    }
    push();
  }

  return lines.join("\n");
}

/**
 * Run SP decomposition on a domain's PMOS or NMOS side and format
 * the resulting tree as a compact one-line topology string. Returns
 * the empty string when the side has fewer than 2 transistors (the
 * topology is trivial) or when the network isn't SP — the boolean
 * line above is the better reference there.
 */
function spTopologyLine(
  transistorIds: string[],
  tById: Map<string, Transistor>,
  outputNetId: number | undefined,
  side: "pun" | "pdn",
): string {
  if (transistorIds.length < 2 || outputNetId == null) return "";
  const ts = transistorIds
    .map((id) => tById.get(id))
    .filter((t): t is Transistor => !!t);
  // PUN sits between VCC (top) and the output; PDN between the
  // output and GND. We need (top, bottom) to call decompose. Detect
  // the rail by inspecting the transistor S/D nets — the net that
  // appears across all PMOS sources (in PUN) is VCC; same for NMOS
  // → GND in PDN. Cheap heuristic: pick the net id that's NOT the
  // output and appears most often.
  const counts = new Map<number, number>();
  for (const t of ts) {
    for (const n of [t.source.netId, t.drain.netId]) {
      if (n === outputNetId) continue;
      counts.set(n, (counts.get(n) ?? 0) + 1);
    }
  }
  let railNet: number | null = null;
  let best = -1;
  for (const [n, c] of counts) {
    if (c > best) {
      best = c;
      railNet = n;
    }
  }
  if (railNet == null) return "";
  const top = side === "pun" ? railNet : outputNetId;
  const bottom = side === "pun" ? outputNetId : railNet;
  const edges: SPEdge[] = ts.map((t) => ({
    id: t.id,
    a: t.source.netId,
    b: t.drain.netId,
  }));
  const tree = decompose(top, bottom, edges);
  if (!tree) return " — non-SP topology";
  return ` topology: ${flattenSP(tree)}`;
}

function flattenSP(tree: SPTree): string {
  switch (tree.kind) {
    case "leaf":
      return tree.transistorId;
    case "series":
      return `series(${tree.parts.map(flattenSP).join(", ")})`;
    case "parallel":
      return `parallel(${tree.branches.map(flattenSP).join(", ")})`;
  }
}
