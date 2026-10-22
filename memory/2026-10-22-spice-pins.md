# 2026-10-22 (evening) — SPICE handoff round 5: measured nets as pins

## Symptom reported by the user

In the card-dialog agent chat everything simulates fine. But after
"Go to SPICE results" the SPICE Simulation page showed no graph for `ref`:
`.measure tran vref_final find v(ref) at=2m` returned a number, while the
plot stayed empty. Adding `ref` to the port list by hand made it appear.

The composed netlist was:

```
.subckt chip VCC OUT
  … whole chip …
.ends chip
Xchip VCC OUT chip
* ── Directives ──
.tran 1u 2m
.measure tran vref_final find v(ref) at=2m
```

## Root cause

ngspice keeps only the **top-level** nodes of a subcircuit in the raw file and
drops the internal ones. `.measure` still evaluates against an internal node
(hence the number), but there is nothing left to draw — the trace filter then
finds no `v(ref)` vector and shows nothing.

`wrapFlatDut` inferred the pins from the testbench's **device lines** only:

```ts
for (const raw of testbench.split(/\r?\n/)) {
  const line = raw.trim();
  if (!line || line.startsWith("*") || line.startsWith(".")) continue;  // ← directives skipped
  for (const node of nodesOfDeviceLine(line)) { … }
}
```

`.measure` / `.print` / `.save` / `.plot` all start with a dot, so they were
skipped, and a net that the testbench only *senses* never became a pin.

Note this is NOT a `.measure tran` parsing gap — `VECTOR_IN_EXPR_RE` already
catches `v(ref)` in `.measure tran`, so `requestedSignals` did list it. The
vector was requested; it simply did not exist at top level to be saved.

## Fix

`wrapFlatDut` now takes its pins from what the testbench drives **and** from
what it senses. After the device-line pass it reads `requestedSignals(testbench)`
and pulls the node out of every `v(...)`:

```ts
for (const signal of requestedSignals(testbench)) {
  const node = /^v(?:m|p|r|s)?\s*\(\s*([^()]+?)\s*\)$/i.exec(signal.trim())?.[1];
  if (node) addPin(node);
}
```

`requestedSignals` returns [] when the netlist asks for nothing, so a testbench
that only drives the DUT still gains no stray pins — verified by a control case.

`buildTestbenchViewNetlist` delegates to `wrapFlatDut`, so the testbench tab's
rectangle gains the same pin and the picture matches the netlist.

Verified with `.tools/agent-probe/sense-pin-probe.mts`: ports come out
`vcc OUT ref`, the block header is `.subckt chip vcc OUT ref`, and the
drive-only control still yields `vcc OUT`.

## The user's main question: why does a card chat simulate the WHOLE die?

Because the discuss endpoint deliberately hands the SPICE tool the full
extracted netlist. Traced the chain:

- `AssistantPanel.tsx:1098` passes `devices` — the whole die's devices, not the
  card's fragment.
- `buildDiscussRequest` → `buildAssistantCircuitSnapshot(input.devices, …)`.
- `backend/src/api/assistant.ts:143` → `discussFindingWithLlm(…, body.circuit, …)`.
- `llmGraphAnalysis.ts:946`: `const dutNetlist = buildSimulationNetlist(snapshot.devices, snapshot.namedNets);`
- `llmGraphAnalysis.ts:1365`: `if (!args.netlist && !args.dutNetlist) args.dutNetlist = dutNetlist;`

The comment at `llmGraphAnalysis.ts:815-817` states the intent:

> The discussion has access to the FULL extracted netlist so the model can
> reason about adjacent components (e.g. a resistor the user mentions that is
> outside the finding's immediate fragment). The finding only sets the focus.

So `finding.deviceUuids` is used only to build `focusInstances`, which appears
in the prompt as text (`The finding under discussion is focused on these
devices: …`). It never narrows what is simulated. The card's fragment is a
**conversational focus**, not a simulation scope.

### Why this is a real problem, not just untidy

A "bandgap hypothesis" card that covers 6 transistors drags the entire chip —
the LDO, the protection, everything — into the simulation. Consequences:

- The supply the model picks must suit the whole die, not the fragment.
- The `.tran` has to settle a much larger circuit, so it is slower and the
  fragment's own dynamics are a rounding error on it.
- A floating or mis-biased block elsewhere in the die can zero the whole run,
  and the tool then reports "every node voltage is 0" for reasons that have
  nothing to do with the card.
- The `.print`/trace filter gets a netlist with hundreds of nodes.
- The user's mental model ("simulate my hypothesis") and the tool's behaviour
  ("simulate the chip") quietly disagree.

### What is needed (not yet implemented)

`llmGraphAnalysis.ts:946` should build the DUT from the finding's devices when
the finding has any, with the boundary nets becoming ports. The infrastructure
for that already exists: `emitSubcircuitSpice(snapshot.devices, snapshot.namedNets, deviceUuids)`
in `backend/src/assistant/subcircuitExtract.ts` does exactly this for the LVS
check — boundary nets that also touch unselected devices become ports, power
and ground become `.GLOBAL`. The SPICE tool would need to accept a `.subckt`
DUT plus its port list so the model's testbench connects to the ports instead
of to die-level nets.

The LLM *context* should stay full — the model must still see the surrounding
circuit to reason about it. Only what goes into ngspice should narrow.

Left undone deliberately: this is a scope decision, not a one-line fix, and
the user should confirm the intended default before the discuss flow changes.
