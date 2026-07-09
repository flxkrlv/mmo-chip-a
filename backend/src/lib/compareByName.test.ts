/**
 * compareByName.test.ts — Tests for name-based LVS comparator.
 *
 * Run: cd backend && npx tsx --test src/lib/compareByName.test.ts
 */

import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { compareByName } from "./compareByName.js";

// ── HELPERS ─────────────────────────────────────────────────────

function run(layout: string, schematic: string) {
  return compareByName(layout, schematic);
}

function assertMatch(result: ReturnType<typeof compareByName>, msg?: string) {
  assert(result.matched, `Expected MATCH${msg ? ": " + msg : ""}`);
}

function assertMismatch(result: ReturnType<typeof compareByName>, msg?: string) {
  assert(!result.matched, `Expected MISMATCH${msg ? ": " + msg : ""}`);
}

// ══════════════════════════════════════════════════════════════
// CATEGORY 1: MATCH (identical netlists)
// ══════════════════════════════════════════════════════════════

describe("MATCH — identical netlists", () => {
  test("identical R Q C D", () => {
    const n = [
      ".SUBCKT test n1 n2 n3",
      "R1 n1 n2 1k",
      "Q1 n1 n2 n3 npn",
      "C1 n1 n2 1p",
      "D1 n1 n2 diode",
      ".ENDS",
    ].join("\n");
    assertMatch(run(n, n));
  });

  test("identical Spectre format", () => {
    const n = [
      ".SUBCKT test",
      "R1 (n1 n2) resistor r=1k",
      "Q1 (n1 n2 n3) npn m=3.6",
      "C1 (n1 n2) capacitor c=1p",
      "D1 (n1 n2) diode",
      ".ENDS",
    ].join("\n");
    assertMatch(run(n, n));
  });

  test("renamed nets — name-independent MATCH", () => {
    const layout = [
      ".SUBCKT test",
      "R1 (net_a net_b) resistor r=1k",
      "Q1 (net_a net_b net_c) npn m=3.6",
      ".ENDS",
    ].join("\n");
    const schematic = [
      ".SUBCKT test",
      "R1 (foo bar) resistor r=1k",
      "Q1 (foo bar baz) npn m=3.6",
      ".ENDS",
    ].join("\n");
    assertMatch(run(layout, schematic));
  });

  test("renamed device numbers — MISMATCH (name-based limitation)", () => {
    // Different names → can't match by name
    const r = run(
      ".SUBCKT test\nR1 (n1 n2) resistor r=1k\nQ1 (n1 n2 n3) npn m=3.6\n.ENDS",
      ".SUBCKT test\nR99 (n1 n2) resistor r=1k\nQ99 (n1 n2 n3) npn m=3.6\n.ENDS",
    );
    assertMismatch(r);
  });

  test("GLOBAL VCC GND MATCH", () => {
    const n = [
      ".GLOBAL VCC GND",
      ".SUBCKT test",
      "R1 (n1 VCC) resistor r=1k",
      "R2 (n2 GND) resistor r=1k",
      ".ENDS",
    ].join("\n");
    assertMatch(run(n, n));
  });
});

// ══════════════════════════════════════════════════════════════
// CATEGORY 2: TYPE MISMATCH
// ══════════════════════════════════════════════════════════════

describe("TYPE MISMATCH", () => {
  test("NPN vs PNP — same name, type differs", () => {
    const r = run(
      ".SUBCKT test\nQ1 (n1 n2 n3) npn m=3.6\n.ENDS",
      ".SUBCKT test\nQ1 (n1 n2 n3) pnp m=3.6\n.ENDS",
    );
    assertMismatch(r);
    assert(r.details.mismatchedDevices.some((d) => d.reason === "type"));
  });

  test("resistor vs capacitor — different names, unbalanced devices", () => {
    const r = run(
      ".SUBCKT test\nR1 (n1 n2) resistor r=1k\n.ENDS",
      ".SUBCKT test\nC1 (n1 n2) capacitor c=1p\n.ENDS",
    );
    assertMismatch(r);
    assert(r.unbalanced.some((u) => u.what === "device"));
  });

  test("same name R1, different explicit model type", () => {
    const r = run(
      ".SUBCKT test\nR1 (n1 n2) resistor r=1k\n.ENDS",
      ".SUBCKT test\nR1 (n1 n2) capacitor c=1p\n.ENDS",
    );
    assertMismatch(r);
    assert(r.details.mismatchedDevices.some((d) => d.reason === "type"));
  });
});

// ══════════════════════════════════════════════════════════════
// CATEGORY 3: PARAM CHANGED
// ══════════════════════════════════════════════════════════════

describe("PARAM CHANGED — topology MATCH, params differ", () => {
  test("resistor 1k vs 2k — topology MATCH with property_diffs", () => {
    const layout = ".SUBCKT test\nR1 (n1 n2) resistor r=1k\n.ENDS";
    const schematic = ".SUBCKT test\nR1 (n1 n2) resistor r=2k\n.ENDS";
    const r = run(layout, schematic);
    assertMatch(r);
    assert(r.property_diffs.length > 0);
  });

  test("BJT m= 3.6 vs 5.0 — topology MATCH", () => {
    const layout = ".SUBCKT test\nQ1 (n1 n2 n3) npn m=3.6\n.ENDS";
    const schematic = ".SUBCKT test\nQ1 (n1 n2 n3) npn m=5.0\n.ENDS";
    assertMatch(run(layout, schematic));
  });

  test("capacitor 1p vs 10p — topology MATCH", () => {
    const layout = ".SUBCKT test\nC1 (n1 n2) capacitor c=1p\n.ENDS";
    const schematic = ".SUBCKT test\nC1 (n1 n2) capacitor c=10p\n.ENDS";
    assertMatch(run(layout, schematic));
  });
});

// ══════════════════════════════════════════════════════════════
// CATEGORY 4: CONNECTION MISMATCH
// ══════════════════════════════════════════════════════════════

describe("CONNECTION MISMATCH", () => {
  test("resistor terminals swapped — symmetric, MATCH", () => {
    assertMatch(run(
      ".SUBCKT test\nR1 (n1 n2) resistor r=1k\n.ENDS",
      ".SUBCKT test\nR1 (n2 n1) resistor r=1k\n.ENDS",
    ));
  });

  // NOTE: For ordered devices with swapped pins that are the ONLY devices
  // on their terminals, net signature IS ambiguous — graph isomorphism
  // can't distinguish which net is which without a reference. This is
  // correct graph-theoretic behavior. Use vyges-lvs for pin-level check.
  test("diode pins swapped — ambiguous without reference net", () => {
    assertMatch(run(
      ".SUBCKT test\nD1 (n1 n2) diode\n.ENDS",
      ".SUBCKT test\nD1 (n2 n1) diode\n.ENDS",
    ));
  });

  test("BJT collector/emitter swapped — ambiguous without reference", () => {
    assertMatch(run(
      ".SUBCKT test\nQ1 (n1 n2 n3) npn\n.ENDS",
      ".SUBCKT test\nQ1 (n3 n2 n1) npn\n.ENDS",
    ));
  });

  test("Q7↔Q9 swapped — different types, MISMATCH", () => {
    const r = run(
      ".SUBCKT test\nQ7 (a b c 0) pnp\nQ9 (d e f 0) npn m=1.29\n.ENDS",
      ".SUBCKT test\nQ9 (a b c 0) pnp\nQ7 (d e f 0) npn m=1.29\n.ENDS",
    );
    assertMismatch(r);
    // Q7 on layout is pnp, but Q7 on schematic is npn → type mismatch
    // Q9 on layout is npn, but Q9 on schematic is pnp → type mismatch
    const typeM = r.details.mismatchedDevices.filter((d) => d.reason === "type");
    assert.equal(typeM.length, 2, "should detect Q7 and Q9 as type mismatches");
  });

  test("Q7↔Q9 swapped same type — MATCH (graph-isomorphic)", () => {
    assertMatch(run(
      ".SUBCKT test\nQ7 (a b c 0) npn m=1\nQ9 (d e f 0) npn m=1\n.ENDS",
      ".SUBCKT test\nQ9 (a b c 0) npn m=1\nQ7 (d e f 0) npn m=1\n.ENDS",
    ));
  });

  // ── Phase 2c edge cases (overlap-based pairing) ──

  test("Q10→Q100 one terminal renamed — MISMATCH via overlap", () => {
    const r = run(
      ".SUBCKT test\nQ10 (a b c 0) npn m=1\n.ENDS",
      ".SUBCKT test\nQ100 (a x c 0) npn m=1\n.ENDS",
    );
    assertMismatch(r);
    // 3/4 match by name → Phase 2c should pair as connection mismatch
  });

  test("Q10→Q100 all terminals different — L-only / S-only (no overlap)", () => {
    const r = run(
      ".SUBCKT test\nQ10 (a b c 0) npn\n.ENDS",
      ".SUBCKT test\nQ100 (x y z 0) npn\n.ENDS",
    );
    assertMismatch(r);
    // 0/4 match → no pairing, stays unbalanced
    assert(r.unbalanced.some((u) => u.what === "device" && u.a_count > 0 && u.b_count === 0), "Q10 should be L-only");
    assert(r.unbalanced.some((u) => u.what === "device" && u.a_count === 0 && u.b_count > 0), "Q100 should be S-only");
  });

  test("two random npn with 0 shared terms — no false pairing", () => {
    const r = run(
      ".SUBCKT test\nQ10 (a b c 0) npn\nQ12 (x y z 0) npn\n.ENDS",
      ".SUBCKT test\nQ10 (a b c 0) npn\nQ13 (p q r 0) npn\n.ENDS",
    );
    assertMismatch(r);
    // Q12 L-only, Q13 S-only — 0% overlap
    assert(r.unbalanced.some((u) => u.what === "device" && u.a.includes("q12")), "Q12 L-only");
    assert(r.unbalanced.some((u) => u.what === "device" && u.b.includes("q13")), "Q13 S-only");
  });

  test("Q10→Q100 with 2/4 overlap — no false pairing (<50%)", () => {
    const r = run(
      ".SUBCKT test\nQ10 (a b c d) npn\n.ENDS",
      ".SUBCKT test\nQ100 (a b x y) npn\n.ENDS",
    );
    assertMismatch(r);
    // 2/4 = 50% → NOT >50%, stays unbalanced (shouldn't pair at exactly 50%)
    assert(r.unbalanced.some((u) => u.what === "device" && u.a.length > 0), "should be unbalanced (50% not >50%)");
  });

  test("Phase 2c: resistor with renamed terminal — overlap pairing", () => {
    const r = run(
      ".SUBCKT test\nR1 (n1 n2) resistor r=1k\n.ENDS",
      ".SUBCKT test\nR10 (n1 n3) resistor r=1k\n.ENDS",
    );
    assertMismatch(r);
    // 1/2 = 50% → fails >50%, stays unbalanced
    // Only 2-terminal devices need >50% which means 2/2 must match (100%)
    // With 2 terminals, any rename breaks >50% — correct behavior
  });

  // ── Phase 3 cross-check edge cases ──

  test("Q7↔Q9 cross-swap different types — name-mismatch via cross-check", () => {
    const r = run(
      ".SUBCKT test\nQ7 (a b c 0) pnp\nQ9 (d e f 0) npn m=1\n.ENDS",
      ".SUBCKT test\nQ9 (a b c 0) pnp\nQ7 (d e f 0) npn m=1\n.ENDS",
    );
    assertMismatch(r);
    const typeM = r.details.mismatchedDevices.filter((d) => d.reason === "type");
    assert.equal(typeM.length, 2, "Q7 and Q9 are type mismatches by name");
  });

  test("real type mismatch — no false cross-check", () => {
    // Q7 layout pnp vs Q7 schematic npn, but no Q9 with matching pnp+terminals
    const r = run(
      ".SUBCKT test\nQ7 (a b c 0) pnp m=1\n.ENDS",
      ".SUBCKT test\nQ7 (x y z 0) npn m=1\n.ENDS",
    );
    assertMismatch(r);
    // Real type mismatch, no cross-swap
    const typeM = r.details.mismatchedDevices.filter((d) => d.reason === "type");
    assert.equal(typeM.length, 1, "Q7 is a real type mismatch");
  });

  test("R8/R9 cross-swapped — symmetric, MATCH", () => {
    assertMatch(run(
      ".SUBCKT test\nR8 (n1 n2) resistor r=1k\nR9 (n2 n3) resistor r=1k\n.ENDS",
      ".SUBCKT test\nR8 (n2 n1) resistor r=1k\nR9 (n3 n2) resistor r=1k\n.ENDS",
    ));
  });
});

// ══════════════════════════════════════════════════════════════
// CATEGORY 5: EXTRA / MISSING DEVICES
// ══════════════════════════════════════════════════════════════

describe("EXTRA / MISSING DEVICES", () => {
  test("extra resistor in layout (R2)", () => {
    const r = run(
      ".SUBCKT test\nR1 (n1 n2) resistor r=1k\nR2 (n2 n3) resistor r=1k\n.ENDS",
      ".SUBCKT test\nR1 (n1 n2) resistor r=1k\n.ENDS",
    );
    assertMismatch(r);
    assert(r.unbalanced.some((u) => u.what === "device" && u.a_count === 1 && u.b_count === 0));
  });

  test("missing capacitor in layout", () => {
    const r = run(
      ".SUBCKT test\nR1 (n1 n2) resistor r=1k\n.ENDS",
      ".SUBCKT test\nR1 (n1 n2) resistor r=1k\nC1 (n1 n2) capacitor c=1p\n.ENDS",
    );
    assertMismatch(r);
    assert(r.unbalanced.some((u) => u.what === "device" && u.a_count === 0 && u.b_count === 1));
  });

  test("extra BJT in schematic (Q33)", () => {
    const r = run(
      ".SUBCKT test\nR1 (n1 n2) resistor r=1k\nQ1 (n1 n2 n3) npn\n.ENDS",
      ".SUBCKT test\nR1 (n1 n2) resistor r=1k\nQ1 (n1 n2 n3) npn\nQ33 (n3 n1 n2) npn\n.ENDS",
    );
    assertMismatch(r);
    assert(r.unbalanced.some((u) => u.what === "device" && u.a_count === 0 && u.b_count === 1));
  });
});

// ══════════════════════════════════════════════════════════════
// CATEGORY 6: PARALLEL RESISTORS
// ══════════════════════════════════════════════════════════════

describe("PARALLEL RESISTORS — detected (vyges-lvs blind spot)", () => {
  test("R811 case — different names, detected as extra device", () => {
    const r = run(
      ".SUBCKT test\nR81 (n1 n2) resistor r=1k\nR811 (n1 n2) resistor r=1k\n.ENDS",
      ".SUBCKT test\nR81 (n1 n2) resistor r=1k\n.ENDS",
    );
    assertMismatch(r);
    assert(r.unbalanced.some((u) => u.what === "device" && u.a_count === 1));
  });

  test("extra parallel resistor different value", () => {
    const r = run(
      ".SUBCKT test\nR1 (n1 n2) resistor r=1k\nR2 (n1 n2) resistor r=2k\n.ENDS",
      ".SUBCKT test\nR1 (n1 n2) resistor r=1k\n.ENDS",
    );
    assertMismatch(r);
  });
});

// ══════════════════════════════════════════════════════════════
// CATEGORY 7: GLOBAL NETS
// ══════════════════════════════════════════════════════════════

describe("GLOBAL NETS", () => {
  test("MATCH with GLOBAL VCC GND", () => {
    const n = [
      ".GLOBAL VCC GND",
      ".SUBCKT test",
      "R1 (n1 VCC) resistor r=1k",
      "R2 (n2 GND) resistor r=1k",
      ".ENDS",
    ].join("\n");
    assertMatch(run(n, n));
  });
});

// ══════════════════════════════════════════════════════════════
// CATEGORY 8: SPECTRE SYNTAX
// ══════════════════════════════════════════════════════════════

describe("SPECTRE SYNTAX", () => {
  test("parenthesized ports MATCH", () => {
    const n = [
      ".subckt test (n1 n2 n3)",
      "R1 (n1 n2) resistor r=1k",
      "Q1 (n1 n2 n3) npn m=1",
      ".ends test",
    ].join("\n");
    assertMatch(run(n, n));
  });

  test("param changed r=1k to r=2k — topology MATCH", () => {
    const r = run(
      ".subckt test\nR1 (n1 n2) resistor r=1k\n.ends test",
      ".subckt test\nR1 (n1 n2) resistor r=2k\n.ends test",
    );
    assertMatch(r);
  });
});

// ══════════════════════════════════════════════════════════════
// CATEGORY 9: CDL POSITIONAL FORMAT
// ══════════════════════════════════════════════════════════════

describe("CDL POSITIONAL FORMAT", () => {
  test("CDL basic R Q C D MATCH", () => {
    const n = [
      ".SUBCKT test n1 n2 n3",
      "R1 n1 n2 1k",
      "Q1 n1 n2 n3 npn",
      "C1 n1 n2 1p",
      "D1 n1 n2 diode",
      ".ENDS",
    ].join("\n");
    assertMatch(run(n, n));
  });

  test("CDL renamed nets MATCH", () => {
    assertMatch(run(
      ".SUBCKT test\nR1 net_a net_b 1k\nQ1 net_a net_b net_c npn\n.ENDS",
      ".SUBCKT test\nR1 foo bar 1k\nQ1 foo bar baz npn\n.ENDS",
    ));
  });
});

// ══════════════════════════════════════════════════════════════
// CATEGORY 10: COMPLEX / REALISTIC
// ══════════════════════════════════════════════════════════════

describe("COMPLEX / REALISTIC", () => {
  const circuit = [
    ".SUBCKT lm2937_stud",
    "R1 (n1 VCC) resistor r=1k m=1",
    "R2 (n2 GND) resistor r=1k m=1",
    "Q1 (n1 n2 n3) npn m=3.6",
    "Q2 (n3 n1 GND) npn m=2.87",
    "C1 (n1 n3) capacitor c=10p",
    "D1 (n2 n1) diode",
    ".ENDS",
  ].join("\n");

  test("identical circuit MATCH", () => {
    assertMatch(run(circuit, circuit));
  });

  test("renamed nets MATCH", () => {
    assertMatch(run(
      [
        ".SUBCKT lm2937_stud",
        "R1 (net_a VCC) resistor r=1k m=1",
        "R2 (net_b GND) resistor r=1k m=1",
        "Q1 (net_a net_b net_c) npn m=3.6",
        "Q2 (net_c net_a GND) npn m=2.87",
        "C1 (net_a net_c) capacitor c=10p",
        "D1 (net_b net_a) diode",
        ".ENDS",
      ].join("\n"),
      [
        ".SUBCKT lm2937_stud",
        "R1 (x VCC) resistor r=1k m=1",
        "R2 (y GND) resistor r=1k m=1",
        "Q1 (x y z) npn m=3.6",
        "Q2 (z x GND) npn m=2.87",
        "C1 (x z) capacitor c=10p",
        "D1 (y x) diode",
        ".ENDS",
      ].join("\n"),
    ));
  });

  test("param mismatch in realistic — topology MATCH with property diffs", () => {
    const r = run(
      ".SUBCKT test\nR1 (n1 n2) resistor r=1k\nQ1 (n1 n2 n3) npn m=3.6\n.ENDS",
      ".SUBCKT test\nR1 (n1 n2) resistor r=1.5k\nQ1 (n1 n2 n3) npn m=3.6\n.ENDS",
    );
    assertMatch(r);
    assert(r.property_diffs.length > 0);
  });

  test("multiple mismatches", () => {
    const r = run(
      ".SUBCKT test\nR1 (n1 n2) resistor r=1k\nR2 (n1 n2) resistor r=2k\nQ1 (n1 n2 n3) npn m=3.6\n.ENDS",
      ".SUBCKT test\nR1 (n1 n2) resistor r=1k\nQ1 (n1 n2 n3) pnp m=3.6\nC1 (n1 n2) capacitor c=10p\n.ENDS",
    );
    assertMismatch(r);
    assert(r.unbalanced.length > 0);
    assert(r.details.mismatchedDevices.length > 0);
  });
});

// ══════════════════════════════════════════════════════════════
// CATEGORY 11: EDGE CASES
// ══════════════════════════════════════════════════════════════

describe("EDGE CASES", () => {
  test("empty netlists — MATCH", () => {
    assertMatch(run("", ""));
  });

  test("one empty side", () => {
    assertMismatch(run(
      ".SUBCKT test\nR1 (n1 n2) resistor r=1k\n.ENDS",
      "",
    ));
  });

  test("only directives, no devices — MATCH", () => {
    const n = ".GLOBAL VCC GND\n.SUBCKT top\n.ENDS top";
    assertMatch(run(n, n));
  });

  test("device count mismatch reported correctly", () => {
    const r = run(
      ".SUBCKT test\nR1 (n1 n2) resistor r=1k\nR2 (n1 n2) resistor r=2k\nR3 (n1 n2) resistor r=3k\n.ENDS",
      ".SUBCKT test\nR1 (n1 n2) resistor r=1k\n.ENDS",
    );
    assertMismatch(r);
    // Each extra device gets its own unbalanced entry
    const devUnbals = r.unbalanced.filter((u) => u.what === "device");
    assert.equal(devUnbals.length, 2);
    assert(devUnbals.every((u) => u.a_count === 1));
  });

  test("case insensitive device name matching", () => {
    assertMatch(run(
      ".SUBCKT test\nR1 (n1 n2) resistor r=1k\n.ENDS",
      ".SUBCKT test\nr1 (n1 n2) resistor r=1k\n.ENDS",
    ));
  });

  test("duplicate device names — MISMATCH (last instance overwrites)", () => {
    // Map stores last occurrence. Layout R1 connects (n1 n2), schematic R1 (last) connects (x y).
    // Q1 signatures force n1=n1, n2=n2 mapping. R1 mapped (n1 n2) ≠ schematic (x y) → MISMATCH.
    const layout = ".SUBCKT test\nR1 (n1 n2) resistor r=1k\nQ1 (n1 n2 n3) npn\n.ENDS";
    const schematic = ".SUBCKT test\nR1 (n1 n2) resistor r=1k\nR1 (x y) resistor r=2k\nQ1 (n1 n2 n3) npn\n.ENDS";
    assertMismatch(run(layout, schematic));
  });
});
