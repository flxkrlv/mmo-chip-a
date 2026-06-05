/**
 * Text dump of a cell's logic netlist.
 *
 * Produces a self-contained, LLM-friendly description of the cell —
 * I/O classification, per-domain boolean expressions, transmission
 * gates with their control + bridge nets, pass transistors, and a
 * per-net driver/consumer summary. The format is designed for two
 * audiences:
 *
 *   1. A human reading it to spot annotation issues at a glance.
 *   2. An LLM reasoning about what the cell implements (paste the
 *      dump into a chat and ask "what does this cell do?").
 *
 * Net naming follows the same `netName` resolver the schematic uses,
 * so user-labelled VDD / GND / explicit input names appear by name
 * while everything else falls back to `netN`.
 */

import type { InferredCellExtraction } from "../extraction";
import { formatBoolExpr } from "../extraction";

export function dumpNetlist(
  extraction: InferredCellExtraction,
  netName: (id: number) => string,
): string {
  const lines: string[] = [];
  const push = (s = "") => lines.push(s);

  // ── Header ─────────────────────────────────────────────────
  const passCount = extraction.transistors.filter((t) => t.role === "pass").length;
  push(`=== Cell logic dump ===`);
  push(
    `${extraction.transistors.length} transistors · ${extraction.domains.length} domain(s) · ` +
      `${extraction.transmissionGates.length} TG(s) · ${passCount} pass transistor(s)`,
  );
  push();

  // ── I/O classification ────────────────────────────────────
  const inputs: number[] = [];
  const outputs: number[] = [];
  const rails: Array<{ id: number; kind: "vcc" | "gnd" }> = [];
  const internals: number[] = [];
  const passNets: number[] = [];
  for (const n of extraction.nets) {
    switch (n.role) {
      case "input":
        inputs.push(n.id);
        break;
      case "output":
        outputs.push(n.id);
        break;
      case "vcc":
        rails.push({ id: n.id, kind: "vcc" });
        break;
      case "gnd":
        rails.push({ id: n.id, kind: "gnd" });
        break;
      case "internal":
        internals.push(n.id);
        break;
      case "pass":
        passNets.push(n.id);
        break;
      // "io", "unused", undefined — listed under "other" below
    }
  }
  push(`I/O:`);
  push(`  inputs:    ${inputs.map(netName).join(", ") || "(none)"}`);
  push(`  outputs:   ${outputs.map(netName).join(", ") || "(none)"}`);
  push(
    `  rails:     ` +
      (rails.length === 0
        ? "(none)"
        : rails
            .map((r) => `${netName(r.id)} (${r.kind.toUpperCase()})`)
            .join(", ")),
  );
  if (passNets.length > 0) {
    push(`  pass nets: ${passNets.map(netName).join(", ")}`);
  }
  if (internals.length > 0) {
    push(`  internal:  ${internals.map(netName).join(", ")}`);
  }
  push();

  // ── Cell-level expression (when single-output combinational) ─
  if (extraction.logic) {
    push(`Cell-level boolean (chained from domain logic):`);
    push(`  out = ${formatBoolExpr(extraction.logic, netName)}`);
    push();
  }

  // ── Domains (combinational gates) ─────────────────────────
  if (extraction.domains.length > 0) {
    push(`Domains (combinational gates):`);
    for (const d of extraction.domains) {
      const out = d.outputNetIds.map(netName).join(", ");
      const ins = d.inputNetIds.map(netName).join(", ");
      const exprText = d.logic
        ? `${out} = ${formatBoolExpr(d.logic, netName)}`
        : "(non-SP / no boolean form)";
      push(`  ${d.id}:`);
      push(`    inputs:  ${ins || "(none)"}`);
      push(`    output:  ${out || "(none)"}`);
      push(`    boolean: ${exprText}`);
      push(
        `    transistors: ${d.pmosTransistorIds.length} PMOS / ${d.nmosTransistorIds.length} NMOS`,
      );
    }
    push();
  }

  // ── Transmission gates ────────────────────────────────────
  if (extraction.transmissionGates.length > 0) {
    push(`Transmission gates (TGs are bidirectional — bridge direction is conventional):`);
    for (const tg of extraction.transmissionGates) {
      push(`  ${tg.id}:`);
      push(
        `    ctrl_p (PMOS, active-low):  ${netName(tg.controlPmosGateNetId)}`,
      );
      push(
        `    ctrl_n (NMOS, active-high): ${netName(tg.controlNmosGateNetId)}`,
      );
      push(
        `    bridge: ${netName(tg.bridgedNetIds[0])} <-> ${netName(tg.bridgedNetIds[1])}`,
      );
    }
    push();
  }

  // ── Pass transistors ──────────────────────────────────────
  const passTxs = extraction.transistors.filter((t) => t.role === "pass");
  if (passTxs.length > 0) {
    push(`Pass transistors:`);
    for (const t of passTxs) {
      push(`  ${t.id} (${t.type}):`);
      push(`    gate:   ${netName(t.gate.netId)}`);
      push(`    s/d:    ${netName(t.source.netId)} <-> ${netName(t.drain.netId)}`);
    }
    push();
  }

  // ── Per-net driver/consumer summary ───────────────────────
  //
  // Includes every net that participates in the extraction, with a
  // structural description of who drives it and who consumes it. This
  // is the most useful section for spotting orphans (consumers with
  // no driver) and multi-driver nets (e.g. MUX-style outputs).
  push(`Net connectivity:`);
  const tById = new Map(extraction.transistors.map((t) => [t.id, t]));
  // Build driver/consumer lists per net id.
  const drivers = new Map<number, string[]>();
  const consumers = new Map<number, string[]>();
  const addD = (n: number, desc: string) => {
    let l = drivers.get(n);
    if (!l) {
      l = [];
      drivers.set(n, l);
    }
    l.push(desc);
  };
  const addC = (n: number, desc: string) => {
    let l = consumers.get(n);
    if (!l) {
      l = [];
      consumers.set(n, l);
    }
    l.push(desc);
  };
  // Domains: gate inputs are consumers, output net is driver.
  for (const d of extraction.domains) {
    for (const ni of d.inputNetIds) addC(ni, `${d.id}.gate`);
    for (const no of d.outputNetIds) addD(no, `${d.id}.out`);
  }
  // TGs: controls are consumers; bridge sides are both (since the
  // model picks one consumer + one driver based on context).
  for (const tg of extraction.transmissionGates) {
    addC(tg.controlPmosGateNetId, `${tg.id}.ctrl_p`);
    addC(tg.controlNmosGateNetId, `${tg.id}.ctrl_n`);
    addC(tg.bridgedNetIds[0], `${tg.id}.bridge[0]`);
    addC(tg.bridgedNetIds[1], `${tg.id}.bridge[1]`);
  }
  // Pass txs.
  for (const t of passTxs) {
    addC(t.gate.netId, `${t.id}.gate`);
    addC(t.source.netId, `${t.id}.s`);
    addC(t.drain.netId, `${t.id}.d`);
  }
  // Cell-level boundaries: inputs are drivers, outputs are consumers
  // (from the cell's perspective the input drives signal into the
  // cell; the output net is "consumed" by whatever is outside).
  for (const id of inputs) addD(id, "<cell input>");
  for (const id of outputs) addC(id, "<cell output>");
  for (const r of rails) addD(r.id, `<rail ${r.kind.toUpperCase()}>`);

  // Emit one line per net, sorted by id for readability.
  const allNetIds = Array.from(
    new Set([
      ...extraction.nets.map((n) => n.id),
      ...drivers.keys(),
      ...consumers.keys(),
    ]),
  ).sort((a, b) => a - b);
  for (const id of allNetIds) {
    const net = extraction.nets.find((n) => n.id === id);
    const role = net?.role ?? "(unknown)";
    const ds = drivers.get(id) ?? [];
    const cs = consumers.get(id) ?? [];
    const orphan = cs.length > 0 && ds.length === 0;
    push(
      `  ${netName(id)} [${role}]${orphan ? " ⚠️ ORPHAN (consumed but no driver)" : ""}`,
    );
    push(`    driven by:   ${ds.join(", ") || "(none)"}`);
    push(`    consumed by: ${cs.join(", ") || "(none)"}`);
  }

  push();

  // ── Warnings (extraction diagnostics) ────────────────────
  if (extraction.warnings.length > 0) {
    push(`Warnings (${extraction.warnings.length}):`);
    for (const w of extraction.warnings) {
      push(`  [${w.severity}] ${w.code}: ${w.message}`);
    }
    push();
  }

  // Silence unused-var lint — tById is reserved for future per-
  // transistor enrichment (S/D net resolution beyond what the
  // `pass transistors` block already shows).
  void tById;

  return lines.join("\n");
}
