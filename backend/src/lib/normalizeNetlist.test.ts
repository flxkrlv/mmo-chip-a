import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeForVyges } from "./normalizeNetlist.js";

function countDevices(norm: string): number {
  return norm.split("\n").filter(l =>
    /^[A-Za-z_]/.test(l.trim()) &&
    !/^\.(SUBCKT|ENDS|GLOBAL)/i.test(l.trim())
  ).length;
}

// ── parameters line ──────────────────────────────────────────

describe("parameters line", () => {
  const netlist = [
    `subckt test (a b)`,
    `  parameters ff=0.25e-15 Rpl=300`,
    `  R1 (a b) resistor r=1k`,
    `ends test`,
  ].join("\n");

  test("should NOT be counted as a device", () => {
    const norm = normalizeForVyges(netlist);
    const count = countDevices(norm);
    assert.equal(count, 1, `expected 1 device, got ${count}. Output:\n${norm}`);
  });

  test("should not appear in normalized output as device line", () => {
    const norm = normalizeForVyges(netlist);
    // parameters line should be discarded entirely
    assert.ok(!norm.includes("parameters"),
      `parameters line should be absent from normalized output`);
  });
});

// ── Backslash-escaped net names ──────────────────────────────

describe("backslash-escaped net names", () => {
  const netlist = [
    `subckt test (V\\- in\\+ Vbias 0)`,
    `  R1 (V\\- net1) resistor r=1k`,
    `  Q1 (net1 V\\- 0) npn m=1`,
    `  C1 (in\\+ net1) capacitor c=1p`,
    `ends test`,
  ].join("\n");

  test("should unescape V\\- to V-", () => {
    const norm = normalizeForVyges(netlist);
    const hasEscaped = norm.includes("V\\-");
    const hasUnescaped = norm.includes("V-");
    assert.ok(!hasEscaped, `V\\- should not appear; got:\n${norm}`);
    assert.ok(hasUnescaped, `V- should appear; got:\n${norm}`);
  });

  test("should unescape in\\+ to in+", () => {
    const norm = normalizeForVyges(netlist);
    const hasEscaped = norm.includes("in\\+");
    const hasUnescaped = norm.includes("in+");
    assert.ok(!hasEscaped, `in\\+ should not appear`);
    assert.ok(hasUnescaped, `in+ should appear`);
  });

  test("should produce valid CDL that vyges-lvs can parse (no backslash)", () => {
    const norm = normalizeForVyges(netlist);
    const backslashInNet = norm.match(/[A-Za-z_]+\\./);
    assert.equal(backslashInNet, null,
      `net names still have backslash escapes: ${backslashInNet?.[0]}`);
  });
});

// ── Real-world netlists ──────────────────────────────────────

describe("real-world test case (lm2937)", () => {
  const dir = join(import.meta.dirname, "..", "..", "..", "docs", "debug", "lvs", "test");

  // wrap in try-catch so tests don't crash if files aren't present
  let layoutRaw: string, schematicRaw: string;
  try {
    layoutRaw = readFileSync(join(dir, "layout.txt"), "utf-8");
    schematicRaw = readFileSync(join(dir, "schematic.txt"), "utf-8");
  } catch {
    layoutRaw = "";
    schematicRaw = "";
  }

  test("layout and schematic both parse to 23 devices", { skip: !layoutRaw }, () => {
    const layoutNorm = normalizeForVyges(layoutRaw, "top", ["0"]);
    const schematicNorm = normalizeForVyges(schematicRaw, "top", ["0"]);
    const lc = countDevices(layoutNorm);
    const sc = countDevices(schematicNorm);
    assert.equal(lc, 23, `layout should have 23 devices, got ${lc}`);
    assert.equal(sc, 23, `schematic should have 23 devices, got ${sc}`);
  });

  test("schematic should not have backslash-escaped net names after normalization", { skip: !schematicRaw }, () => {
    const schematicNorm = normalizeForVyges(schematicRaw, "top", ["0"]);
    const linesWithBackslash = schematicNorm.split("\n").filter(l =>
      /^[A-Za-z_]/.test(l.trim()) && l.includes("\\")
    );
    assert.equal(linesWithBackslash.length, 0,
      `device lines with backslash: ${JSON.stringify(linesWithBackslash)}`);
  });
});
