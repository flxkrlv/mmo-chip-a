/**
 * normalizeNetlist.ts — Normalize Spectre-format netlists for vyges-lvs.
 *
 * vyges-lvs expects SPICE/CDL syntax (`.SUBCKT`/`.ENDS` with dots) and
 * chokes on Cadence Spectre simulation directives (`simulatorOptions`,
 * `tran`, `save`, `modelParameter`, etc.).
 *
 * This normalizer:
 *   1. Strips non-device Spectre directives
 *   2. Preserves `.GLOBAL` net declarations (from input or via `globalNets` param)
 *   3. Strips any existing `.SUBCKT`/`.ENDS` boundaries (flat output)
 *   4. Preserves device instances and `parameters`/`.PARAM`
 *   5. Wraps everything in `.SUBCKT ${moduleName}` / `.ENDS ${moduleName}`
 *      without port declarations — both sides get identical wrapping
 *
 * Currently Spectre-only. Extend for CDL/HSPICE when needed.
 *
 * For hierarchical netlists with real I/O pin ports, pass `ioNetIds`
 * through to the generator (see docs/lvs-plan.md).
 */

// Lines that are definitely NOT device instances or subcircuit boundaries.
// These are Spectre simulation/analysis directives that vyges-lvs doesn't need.
const DISCARD_PATTERNS = [
  /^simulator\s+lang/i,
  /^simulatorOptions/i,
  /^modelParameter/i,
  /^element\b/i,
  /^outputParameter/i,
  /^designParamVals/i,
  /^primitives\b/i,
  /^subckts\b/i,
  /^finalTimeOP/i,
  /^(tran|dc|ac|op|pac|noise|sp|xf|pz|envlp|dcmatch)\b/i,
  /^save\b/i,
  /^saveOptions/i,
  /^ic\b/i,
  /^nodeset\b/i,
  /^include\b/i,
];

function isDiscardLine(raw: string): boolean {
  const line = raw.trim();
  if (!line) return true; // empty lines are collapsed later
  if (line.startsWith("//") || line.startsWith("*")) return true;
  for (const p of DISCARD_PATTERNS) {
    if (p.test(line)) return true;
  }
  return false;
}

function isSubcktLine(line: string): boolean {
  const l = line.trim();
  return /^\.?(subckt|SUBCKT)\b/.test(l) || /^\.?(ends|ENDS)\b/.test(l);
}

function isDeviceLine(line: string): boolean {
  // Heuristic: starts with a letter followed by identifier chars (device name),
  // then whitespace and more text (terminals + model + params).
  // This catches: R41 (n1 n2) resistor r=1k, Q37 (c b e 0) npn m=1, etc.
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (/^[A-Za-z_][A-Za-z0-9_]*\s/.test(trimmed)) {
    // Exclude lines that are device-like but are actually other keywords.
    // `parameters` and `.PARAM` are handled separately.
    if (/^(parameters|\.PARAM)\b/i.test(trimmed)) return true;
    // If it starts with a letter (like a device name), it's a device line.
    return true;
  }
  return false;
}

/**
 * Normalize a Spectre netlist string for vyges-lvs consumption.
 * Both sides get identical `.SUBCKT name` / `.ENDS name` wrapping.
 * Existing subcircuit boundaries are stripped; ports are not declared.
 *
 * vyges-lvs uses `.GLOBAL` to anchor VDD/GND and break the graph into
 * independent connected components. Without it, a single change cascades
 * through the entire design (1-WL limitation). Pass global nets extracted
 * from BOTH sides via the `globalNets` parameter for correct anchoring.
 *
 * @param input — raw Spectre netlist
 * @param moduleName — subcircuit name (defaults to "top")
 * @param globalNets — global net names to emit as `.GLOBAL` (e.g. `["0", "VCC"]`)
 */
export function normalizeForVyges(input: string, moduleName?: string, globalNets?: string[]): string {
  const lines = input.split("\n");
  const out: string[] = [];

  let hasParams = false;
  const globalsFromInput: string[] = [];

  // Phase 1: filter & collect — strip everything except devices + parameters + globals
  for (const raw of lines) {
    const trimmed = raw.trimEnd();
    if (isDiscardLine(trimmed)) continue;
    // Strip any existing subcircuit boundaries — we re-wrap identically below
    if (isSubcktLine(trimmed)) continue;

    if (/^parameters\b/i.test(trimmed)) {
      hasParams = true;
      out.push(trimmed);
      continue;
    }

    // Collect .GLOBAL net names; vyges-lvs uses them to anchor power/ground
    if (/^global\s+/i.test(trimmed)) {
      const nets = trimmed.replace(/^global\s+/i, "").trim().split(/\s+/);
      globalsFromInput.push(...nets.filter(Boolean));
      continue;
    }

    if (isDeviceLine(trimmed)) {
      out.push(trimmed);
    }
    // Everything else is silently dropped.
  }

  // Merge: passed-in globals take precedence, then input globals
  const allGlobals = globalNets
    ? [...new Set([...globalNets, ...globalsFromInput])]
    : globalsFromInput;

  // Phase 2: always wrap — identical wrapping on both sides eliminates port diffs
  const name = moduleName || "top";
  let header = "";
  if (allGlobals.length > 0) {
    header = `.GLOBAL ${allGlobals.join(" ")}\n`;
  }
  if (hasParams) {
    const paramIdx = out.findIndex((l) => /^parameters\b/i.test(l));
    if (paramIdx >= 0) {
      header += out.splice(paramIdx, 1)[0] + "\n";
    }
  }
  out.unshift(header + `.SUBCKT ${name}`);
  out.push(`.ENDS ${name}`);

  // Collapse multiple blank lines into one
  const result: string[] = [];
  let prevBlank = false;
  for (const line of out) {
    if (!line.trim()) {
      if (prevBlank) continue;
      prevBlank = true;
    } else {
      prevBlank = false;
    }
    result.push(line);
  }

  return result.join("\n");
}
