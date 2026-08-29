/// <reference types="node" />

/**
 * normalizeNetlist.ts — Normalize SPICE netlists for vyges-lvs.
 *
 * Vyges-lvs expects SPICE/CDL syntax (`.SUBCKT`/`.ENDS` with dots) and
 * POSITIONAL device parameters: `R1 n1 n2 1k` NOT `R1 (n1 n2) resistor r=1k`.
 * Spectre parenthesized format `(n1 n2)` and `keyword=value` params are
 * NOT parsed by vyges-lvs v0.1.11–v0.1.18 (values are silently ignored).
 *
 * This normalizer converts Spectre → CDL format before passing to vyges-lvs:
 *   R1 (n1 n2) resistor r=1k  →  R1 n1 n2 1k
 *   C1 (n1 n2) capacitor c=1p  →  C1 n1 n2 1p
 *   Q1 (c b e s) npn m=1    →  Q1 c b e s npn m=1  (parentheses only)
 */

/** Strip Spectre backslash escapes: `\X` → `X` for any character X.
 *  Spectre uses `\` to escape special chars in net names (e.g. `V\-` → `V-`).
 *  CDL format doesn't support backslash escapes. */
function stripEscapes(s: string): string {
  return s.replace(/\\(.)/g, "$1");
}

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
  /^parameters\b/i,
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
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (/^[A-Za-z_][A-Za-z0-9_]*\s/.test(trimmed)) {
    return true;
  }
  return false;
}

/**
 * Convert a Spectre-format device line to CDL (vyges-lvs-compatible) format.
 *
 * Spectre:  R1 (n1 n2) resistor r=1k
 * CDL:      R1 n1 n2 1k
 *
 * vyges-lvs v0.1.11–v0.1.18 ONLY parses value from positional tokens (CDL format).
 * Parentheses and keyword=value parameters (r=, c=, w=, l=) are silently
 * ignored, so we must convert before passing to vyges-lvs.
 */
function spectreToCdl(line: string): string {
  // Trim leading whitespace (preserved from trimEnd in the normalize loop)
  const trimmed = line.trimStart();
  // Match Spectre parenthesized format: DEVNAME (term1 term2 ...) rest...
  const m = trimmed.match(/^(\w+)\s+\(([^)]+)\)\s*(.*)$/);
  if (!m) return stripEscapes(line); // already CDL or unknown format — just unescape

  const devName = m[1];
  const terminals = stripEscapes(m[2].replace(/\s+/g, " ").trim());
  const rest = stripEscapes(m[3].trim());
  const prefix = devName[0].toUpperCase();

  // R, C, L — strip model keyword, convert keyword=value to positional
  if (prefix === "R" || prefix === "C" || prefix === "L") {
    let cleanRest = rest.replace(/^(resistor|capacitor|inductor)\s*/i, "").trim();
    // Extract value from keyword=value (r=1k, c=1p) → positional
    const valMatch = cleanRest.match(/^[a-zA-Z]+\s*=\s*(\S+)/);
    if (valMatch) {
      cleanRest = valMatch[1];
    }
    return `${devName} ${terminals} ${cleanRest}`.trim();
  }

  // Q, M, D, others — strip parentheses only, keep model + params as-is
  // BJT (Q): vyges-lvs expects 3 terminals (c,b,e). If the Spectre format
  // has 4 (c,b,e,sub), drop the 4th (substrate) so the model isn't eaten.
  if (prefix === "Q") {
    const terms = terminals.split(/\s+/);
    const cdlTerms = terms.length >= 4 ? terms.slice(0, 3).join(" ") : terminals;
    return `${devName} ${cdlTerms} ${rest}`.trim();
  }
  return `${devName} ${terminals} ${rest}`.trim();
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

  const globalsFromInput: string[] = [];

  // Phase 1: filter & collect — strip everything except devices + globals
  for (const raw of lines) {
    const trimmed = raw.trimEnd();
    if (isDiscardLine(trimmed)) continue;
    // Strip any existing subcircuit boundaries — we re-wrap identically below
    if (isSubcktLine(trimmed)) continue;

    // Collect .GLOBAL net names; vyges-lvs uses them to anchor power/ground
    if (/^\.?global\s+/i.test(trimmed)) {
      const nets = trimmed.replace(/^\.?global\s+/i, "").trim().split(/\s+/);
      globalsFromInput.push(...nets.filter(Boolean));
      continue;
    }

    if (isDeviceLine(trimmed)) {
      out.push(spectreToCdl(trimmed));
    }
    // Everything else is silently dropped.
  }

  // Merge: passed-in globals take precedence, then input globals
  const allGlobals = globalNets
    ? [...new Set([...globalNets, ...globalsFromInput])]
    : globalsFromInput;

  // Phase 2: always wrap — identical wrapping on both sides eliminates port diffs
  const name = moduleName || "top";
  const header = allGlobals.length > 0 ? `.GLOBAL ${allGlobals.join(" ")}\n` : "";
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
