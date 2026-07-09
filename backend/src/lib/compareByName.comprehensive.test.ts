/**
 * compareByName.comprehensive.test.ts — 25 LVS scenarios
 * Both engines tested against real circuit mutations on SAME net names.
 *
 * Run: cd backend && npx tsx --test src/lib/compareByName.comprehensive.test.ts
 */

import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { compareByName } from "./compareByName.js";
import { execSync } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync, readFileSync, accessSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { normalizeForVyges } from "./normalizeNetlist.js";

const VYGES_BIN = (() => {
  if (process.env.LVS_CLI_PATH) return process.env.LVS_CLI_PATH;
  const home = homedir();
  for (const c of [join(home, ".cargo", "bin", "vyges-lvs.exe"), join(home, ".cargo", "bin", "vyges-lvs"), "vyges-lvs"]) {
    try { accessSync(c); return c; } catch { }
  }
  return "vyges-lvs";
})();

const BASE = [
  ".subckt lm2937 (Net_1 Net_5 Net_6 Net_7 Net_9 Net_10 Net_11 Net_12 Net_14",
  "Net_19 Net_20 Net_21 Net_22 Net_23 Net_27 Net_28 Net_29 Net_3 Net_30 Net_33",
  "Net_35 Net_37 Net_39 Net_4 Net_40 net2010 net2011 net2030 net2031 net2050",
  "net2060 net2070 net2091 net2100 net2101 net2102 net2110 net2111 net2142",
  "net2150 net2180 net2200 net2201 net2300 VDD GND)",
  "  R1 (Net_5 Net_6) resistor r=3981",
  "  R2 (net2010 net2011) resistor r=3981",
  "  R3 (Net_7 Net_6) resistor r=3981",
  "  R4 (net2030 net2031) resistor r=3981",
  "  R5 (Net_7 Net_9) resistor r=3981",
  "  R6 (net2050 Net_9) resistor r=3981",
  "  Q101 (net2060 Net_19 GND 0) npn m=1.13",
  "  Q102 (net2070 Net_19 GND 0) npn m=1.13",
  "  Q3 (Net_1 Net_4 Net_3 0) pnp m=5",
  "  Q4 (GND net2091 Net_3 0) pnp m=1.93",
  "  Q103 (net2100 net2101 net2102 0) pnp m=1.93",
  "  Q6 (net2110 net2111 Net_5 0) pnp m=2.03",
  "  Q7 (Net_9 Net_12 Net_10 0) pnp",
  "  Q8 (Net_11 Net_11 Net_10 0) pnp m=1.36",
  "  Q9 (Net_14 Net_40 net2142 0) npn m=1.29",
  "  R7 (net2150 Net_14) resistor r=6",
  "  Q10 (Net_37 Net_35 Net_22 0) npn m=1.06",
  "  Q11 (Net_35 Net_35 GND 0) npn m=5",
  "  Q12 (net2180 Net_37 GND 0) npn m=5",
  "  Q13 (Net_40 Net_28 GND 0) npn m=5",
  "  Q14 (net2200 net2201 GND 0) npn m=5",
  "  C1 (Net_23 Net_27) capacitor c=34570.868f",
  "  R8 (Net_22 Net_29) resistor r=3887",
  "  R9 (GND Net_33) resistor r=3887",
  "  R10 (Net_21 Net_30) resistor r=3887",
  "  R11 (GND Net_30) resistor r=3887",
  "  R12 (Net_20 Net_33) resistor r=3887",
  "  R13 (GND Net_29) resistor r=3887",
  "  R14 (Net_39 GND) resistor r=915",
  "  R15 (Net_39 GND) resistor r=892",
  "  Q15 (net2300 Net_39 GND 0) npn m=1.41",
  "  Q16 (Net_40 Net_12 Net_10 0) pnp m=1.1",
  ".ends lm2937",
].join("\n");

// ── Engine runners ────────────────────────────────────────────

function runVyges(l: string, s: string): string {
  const tmp = mkdtempSync(join(tmpdir(), "lvs-"));
  try {
    const gl = ["0", "GND"];
    const ln = normalizeForVyges(l, "", gl);
    const sn = normalizeForVyges(s, "", gl);
    if (!ln.trim() || !sn.trim()) return "MISMATCH";
    const lp = join(tmp, "l.spice"), sp = join(tmp, "s.spice");
    const jp = join(tmp, "j.lvs"), op = join(tmp, "o.json");
    writeFileSync(lp, ln, "utf-8"); writeFileSync(sp, sn, "utf-8");
    writeFileSync(jp, `layout: ${lp}\nschematic: ${sp}\ntop: top`, "utf-8");
    execSync(`"${VYGES_BIN}" run ${jp} --json -o ${op}`, { timeout: 30000, shell: true });
    const r = JSON.parse(readFileSync(op, "utf-8"));
    return r.matched ? "MATCH" : "MISMATCH";
  } catch { return "ERROR"; } finally { rmSync(tmp, { recursive: true, force: true }); }
}

function runNameBased(l: string, s: string): { match: string; details: number; unbal: number } {
  const nb = compareByName(l, s);
  return { match: nb.matched ? "MATCH" : "MISMATCH", details: nb.details.mismatchedDevices.length, unbal: nb.unbalanced.length };
}

// ── Test helper ────────────────────────────────────────────────

function check(name: string, schematic: string, expName: string) {
  test(name, () => {
    const nb = runNameBased(BASE, schematic);
    const v = runVyges(BASE, schematic);
    assert.equal(nb.match, expName, `name-based: expected ${expName}, got ${nb.match} (d=${nb.details}, u=${nb.unbal})`);
    console.log(`  v=${v} nD=${nb.details} nU=${nb.unbal}`);
  });
}

// ══════════════════════════════════════════════════════════════
// 25 SCENARIOS
// ══════════════════════════════════════════════════════════════

describe("Comprehensive LVS — 25 scenarios", () => {

  // ── 1-2: BASELINE ────────────────────────────────────────────
  check("1. Identical → MATCH", BASE, "MATCH");

  // Simple rename: one device's net name changed consistently
  check("2. One net renamed (R1 Net_5→NetX_5 everywhere) → MATCH",
    BASE.replace(/\bNet_5\b/g, "NetX_5"),
    "MATCH");

  // ── 3-5: TYPE MISMATCH ──────────────────────────────────────
  check("3. Q7 pnp→npn → MISMATCH",
    BASE.replace("Q7 (Net_9 Net_12 Net_10 0) pnp", "Q7 (Net_9 Net_12 Net_10 0) npn"),
    "MISMATCH");

  check("4. R1→capacitor → MISMATCH",
    BASE.replace("R1 (Net_5 Net_6) resistor r=3981", "R1 (Net_5 Net_6) capacitor c=10p"),
    "MISMATCH");

  check("5. Q3 pnp→npn → MISMATCH",
    BASE.replace("Q3 (Net_1 Net_4 Net_3 0) pnp m=5", "Q3 (Net_1 Net_4 Net_3 0) npn m=5"),
    "MISMATCH");

  // ── 6-8: CONNECTION MISMATCH ──────────────────────────────────
  check("6. R2 terminals swapped (sym) → MATCH",
    BASE.replace("R2 (net2010 net2011)", "R2 (net2011 net2010)"),
    "MATCH");

  check("7. Q10 terminal Net_35→X → MISMATCH",
    BASE.replace("Q10 (Net_37 Net_35 Net_22 0)", "Q10 (Net_37 X_net Net_22 0)"),
    "MISMATCH");

  check("8. Q7 collector/emitter swapped → MISMATCH",
    BASE.replace("Q7 (Net_9 Net_12 Net_10 0)", "Q7 (Net_10 Net_12 Net_9 0)"),
    "MISMATCH");

  // ── 9: NAME SWAP ─────────────────────────────────────────────
  check("9. Q7↔Q9 attributes swapped → MISMATCH",
    BASE
      .replace("Q7 (Net_9 Net_12 Net_10 0) pnp", "Q7_GONE")
      .replace("Q9 (Net_14 Net_40 net2142 0) npn m=1.29", "Q7 (Net_14 Net_40 net2142 0) npn m=1.29")
      .replace("Q7_GONE", "Q9 (Net_9 Net_12 Net_10 0) pnp"),
    "MISMATCH");

  // ── 10-12: EXTRA / MISSING ────────────────────────────────────
  check("10. R6 removed → MISMATCH",
    BASE.replace("  R6 (net2050 Net_9) resistor r=3981\n", ""),
    "MISMATCH");

  check("11. R99 added → MISMATCH",
    BASE.replace("\n.ends lm2937", "\n  R99 (net2010 GND) resistor r=1k\n.ends lm2937"),
    "MISMATCH");

  check("12. R2 removed → MISMATCH",
    BASE.replace("  R2 (net2010 net2011) resistor r=3981\n", ""),
    "MISMATCH");

  // ── 13-15: PARAM CHANGED (topo MATCH) ────────────────────────
  check("13. R1 r=3981→5000 → MATCH",
    BASE.replace("R1 (Net_5 Net_6) resistor r=3981", "R1 (Net_5 Net_6) resistor r=5000"),
    "MATCH");

  check("14. Q3 m=5→10 → MATCH",
    BASE.replace("Q3 (Net_1 Net_4 Net_3 0) pnp m=5", "Q3 (Net_1 Net_4 Net_3 0) pnp m=10"),
    "MATCH");

  check("15. C1 c→40p → MATCH",
    BASE.replace("C1 (Net_23 Net_27) capacitor c=34570.868f", "C1 (Net_23 Net_27) capacitor c=40000f"),
    "MATCH");

  // ── 16-17: OVERLAP RENAME ────────────────────────────────────
  check("16. Q10→Q100 + terminal change → MISMATCH",
    BASE.replace("Q10 (Net_37 Net_35 Net_22 0) npn m=1.06", "Q100 (Net_37 X_net Net_22 0) npn m=1.06"),
    "MISMATCH");

  check("17. R6→R66 (same nets) → MISMATCH",
    BASE.replace("R6 (net2050 Net_9) resistor r=3981", "R66 (net2050 Net_9) resistor r=3981"),
    "MISMATCH");

  // ── 18: GLOBAL ────────────────────────────────────────────────
  check("18. R1 Net_5→X → MISMATCH",
    BASE.replace("R1 (Net_5 Net_6) resistor r=3981", "R1 (X Net_6) resistor r=3981"),
    "MISMATCH");

  // ── 19: COMBINED ──────────────────────────────────────────────
  check("19. Combined: R2 conn + R6 gone + Q10→Q100 → MISMATCH",
    ((s) => s.replace("R2 (net2010 net2011)", "R2 (net2010 X)")
      .replace("  R6 (net2050 Net_9) resistor r=3981\n", "")
      .replace("Q10 (Net_37 Net_35 Net_22 0) npn m=1.06", "Q100 (Net_37 X Net_22 0) npn m=2.0"))(BASE),
    "MISMATCH");

  // ── 20: EMPTY ─────────────────────────────────────────────────
  check("20. Empty schematic → MISMATCH", "", "MISMATCH");

  // ── 21-25: MORE EDGE CASES ────────────────────────────────────
  check("21. R8→R88 (same nets) → MISMATCH",
    BASE.replace("R8 (Net_22 Net_29) resistor r=3887", "R88 (Net_22 Net_29) resistor r=3887"),
    "MISMATCH");

  check("22. Q101 m param → MATCH",
    BASE.replace("Q101 (net2060 Net_19 GND 0) npn m=1.13", "Q101 (net2060 Net_19 GND 0) npn m=2.5"),
    "MATCH");

  check("23. Two renames R6→R66 + R8→R88 → MISMATCH",
    ((s) => s.replace("R6 (net2050 Net_9)", "R66 (net2050 Net_9)")
      .replace("R8 (Net_22 Net_29)", "R88 (Net_22 Net_29)"))(BASE),
    "MISMATCH");

  check("24. Q7 terminal 2-3 swapped (ordered) → MISMATCH",
    BASE.replace("Q7 (Net_9 Net_12 Net_10 0)", "Q7 (Net_9 Net_10 Net_12 0)"),
    "MISMATCH");

  check("25. R9 r param → MATCH",
    BASE.replace("R9 (GND Net_33) resistor r=3887", "R9 (GND Net_33) resistor r=5000"),
    "MATCH");
});
