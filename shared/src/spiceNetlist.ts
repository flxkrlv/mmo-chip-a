/**
 * spiceNetlist.ts — Spectre/CDL → ngspice conversion and analysis helpers.
 *
 * The extraction pipeline emits Spectre syntax:
 *   Q10 (Net_35 Net_35 GND 0) npn m=3.47
 *   R1 (Net_5 Net_6) resistor r=16.8*250
 *   .subckt bandgap (GND_1 net230 ref VCC GND)
 *
 * ngspice needs plain SPICE:
 *   Q10 Net_35 Net_35 GND 0 npn m=3.47
 *   R1 Net_5 Net_6 4200
 *   .subckt bandgap GND_1 net230 ref VCC GND
 *
 * Two hard ngspice facts drive everything here:
 *   1. A parenthesised node list breaks BJT lines ("could not find a valid
 *      modelname") — the parens must go.
 *   2. A bare arithmetic value ("16.8*250") is rejected ("unknown parameter (*)")
 *      — it must be a number, or a brace expression "{16.8*250}".
 *
 * Shared by the frontend netlist converter and the backend SPICE agent tool.
 */

/** Result of a netlist conversion: the fixed netlist plus human-readable notes. */
export interface NetlistConversion {
  netlist: string;
  /** What was changed — surfaced to the LLM so it knows what was actually run. */
  notes: string[];
}

/** Model cards injected when the netlist references a model but defines none. */
export const DEFAULT_MODEL_CARDS: Record<string, string> = {
  npn: ".MODEL npn NPN (BF=200 IS=1e-16 VAF=50)",
  pnp: ".MODEL pnp PNP (BF=100 IS=1e-16 VAF=50)",
  diode: ".MODEL diode D (IS=1e-14 N=1)",
  zener: ".MODEL zener D (IS=1e-14 BV=5.6 N=1)",
  schottky: ".MODEL schottky D (IS=1e-10 N=1.05)",
  nmos: ".MODEL nmos NMOS (VTO=0.7 KP=1e-4 LAMBDA=0.1)",
  pmos: ".MODEL pmos PMOS (VTO=-0.7 KP=1e-4 LAMBDA=0.1)",
  njf: ".MODEL njf NJF (VTO=-2 BETA=1e-3)",
  pjf: ".MODEL pjf PJF (VTO=2 BETA=1e-3)",
};

/** Spectre type keywords that may follow a device's node list. */
const TYPE_KEYWORDS = new Set([
  "resistor", "capacitor", "inductor", "npn", "pnp", "nmos", "pmos", "njf", "pjf",
  "diode", "zener", "schottky", "mosfet", "bjt", "jfet", "res", "cap", "ind",
]);

/** Node counts per device letter (positional SPICE form). */
const NODE_COUNTS: Record<string, number> = {
  R: 2, C: 2, L: 2, V: 2, D: 2, M: 4, J: 3, Q: 3, I: 1, X: 0,
};

/** Analysis directives that make ngspice actually run something. */
const ANALYSIS_DIRECTIVE_RE = /^\s*\.(op|dc|tran|ac|noise|tf|disto|pz|sens)\b/i;
/** Analysis commands that may appear inside a .control block. */
const CONTROL_ANALYSIS_RE = /^(op|dc|tran|ac|noise|tf|disto|pz)\b/i;
/** Measurement directives (.meas / .measure). */
const MEASURE_RE = /^\s*\.(meas|measure)\b/i;

// ── arithmetic ───────────────────────────────────────────────────

/**
 * Evaluate a pure arithmetic expression ("16.8*250", "2.5*3.4/2").
 * Returns null when the text is not plain arithmetic (so callers can fall
 * back to a brace expression). Implemented as a tiny recursive-descent parser
 * — never eval(), the netlist is untrusted model output.
 */
export function evaluateNumericExpression(expr: string): number | null {
  const text = expr.trim();
  if (!text || !/\d/.test(text)) return null;
  if (!/^[\d\s+\-*/().]+$/.test(text)) return null;

  let pos = 0;
  const skipWs = () => { while (pos < text.length && /\s/.test(text[pos])) pos += 1; };

  const parseFactor = (): number | null => {
    skipWs();
    const c = text[pos];
    if (c === "-") { pos += 1; const v = parseFactor(); return v === null ? null : -v; }
    if (c === "+") { pos += 1; return parseFactor(); }
    if (c === "(") {
      pos += 1;
      const v = parseExpr();
      skipWs();
      if (text[pos] !== ")") return null;
      pos += 1;
      return v;
    }
    const m = /^\d*\.?\d+/.exec(text.slice(pos));
    if (!m) return null;
    pos += m[0].length;
    return Number(m[0]);
  };

  const parseTerm = (): number | null => {
    let left = parseFactor();
    if (left === null) return null;
    for (;;) {
      skipWs();
      const c = text[pos];
      if (c !== "*" && c !== "/") return left;
      pos += 1;
      const right = parseFactor();
      if (right === null) return null;
      if (c === "*") left *= right;
      else {
        if (right === 0) return null;
        left /= right;
      }
    }
  };

  function parseExpr(): number | null {
    let left = parseTerm();
    if (left === null) return null;
    for (;;) {
      skipWs();
      const c = text[pos];
      if (c !== "+" && c !== "-") return left;
      pos += 1;
      const right = parseTerm();
      if (right === null) return null;
      left = c === "+" ? left + right : left - right;
    }
  }

  const value = parseExpr();
  if (value === null || !Number.isFinite(value)) return null;
  skipWs();
  if (pos !== text.length) return null;
  return value;
}

/** Format a number for a SPICE value field (kills 4200.000000000001). */
export function formatNumeric(value: number): string {
  return String(Number(value.toPrecision(12)));
}

/**
 * Normalise one passive value ("16.8*250", "10*Rpoly", "2.5n") into something
 * ngspice accepts. Returns the value plus an optional note.
 */
export function normalizePassiveValue(raw: string): { value: string; note?: string } {
  const value = raw.trim();
  if (!value) return { value };
  // Plain number, optionally with a SPICE suffix (1k, 2.5n, 1meg, 1e3).
  if (/^\d*\.?\d+(?:[eE][+-]?\d+)?(?:meg|mil|[kKmMuUnNpPfFgGtT])?$/.test(value)) {
    return { value };
  }
  // Pure arithmetic → evaluate it.
  const numeric = evaluateNumericExpression(value);
  if (numeric !== null) {
    return { value: formatNumeric(numeric), note: `evaluated "${value}" → ${formatNumeric(numeric)}` };
  }
  // Expression with identifiers → ngspice wants it in braces.
  if (/^[{]/.test(value)) return { value };
  if (/[A-Za-z_]/.test(value) && /[+\-*/]/.test(value)) {
    return {
      value: `{${value}}`,
      note: `"${value}" references a parameter — wrapped as {${value}}; define it with .param or use a numeric value`,
    };
  }
  return { value };
}

// ── device lines ────────────────────────────────────────────────

/** Strip Spectre backslash escapes: `\X` → `X`. */
function stripEscapes(text: string): string {
  return text.replace(/\\(.)/g, "$1");
}

/** Split "R8 (ref Net_29) resistor r=4858" into its parts. */
function splitDeviceLine(line: string): { name: string; nodes: string; rest: string } | null {
  const paren = /^([A-Za-z]\w*)\s*\(([^)]*)\)\s*(.*)$/.exec(line);
  if (paren) {
    return {
      name: paren[1],
      nodes: stripEscapes(paren[2].trim().replace(/\s+/g, " ")),
      rest: stripEscapes(paren[3].trim()),
    };
  }
  const positional = /^([A-Za-z]\w*)\s+(.*)$/.exec(line);
  if (!positional) return null;
  const letter = positional[1][0].toUpperCase();
  const tokens = positional[2].trim().split(/\s+/);
  const count = NODE_COUNTS[letter] ?? 0;
  if (count === 0 || tokens.length <= count) {
    return { name: positional[1], nodes: tokens.join(" "), rest: "" };
  }
  // A 4th BJT node is the substrate — only if the next token is not a model name.
  let nodeCount = count;
  if (letter === "Q" && tokens.length > count && !TYPE_KEYWORDS.has(tokens[count].toLowerCase())) {
    nodeCount = count + 1;
  }
  return {
    name: positional[1],
    nodes: tokens.slice(0, nodeCount).join(" "),
    rest: tokens.slice(nodeCount).join(" "),
  };
}

/** Convert one device line to plain ngspice syntax. */
function convertDeviceLine(line: string, notes: string[]): { line: string; model: string } {
  const parts = splitDeviceLine(line);
  if (!parts) return { line, model: "" };

  const { name, nodes, rest } = parts;
  const letter = name[0].toUpperCase();

  // Strip a leading Spectre type keyword ("resistor", "npn", "diode", …).
  let tail = rest;
  const typeMatch = /^([A-Za-z]+)\b\s*(.*)$/.exec(rest);
  let typeKeyword = "";
  if (typeMatch && TYPE_KEYWORDS.has(typeMatch[1].toLowerCase())) {
    typeKeyword = typeMatch[1];
    tail = typeMatch[2].trim();
  }

  // Passives: value goes positional.
  if (letter === "R" || letter === "C" || letter === "L") {
    const key = letter === "R" ? "r" : letter === "C" ? "c" : "l";
    const kv = new RegExp(`\\b${key}\\s*=\\s*(\\S+)`, "i").exec(tail);
    let rawValue = kv ? kv[1] : (tail.split(/\s+/)[0] ?? "");
    if (kv) {
      // drop the key=value token from the tail
      tail = tail.replace(kv[0], "").trim();
    } else if (tail.split(/\s+/).length === 1) {
      tail = "";
    }
    const normalized = normalizePassiveValue(rawValue);
    if (normalized.note) notes.push(`${name}: ${normalized.note}`);
    // ngspice has no models for passives — keep only the parameters it knows
    // ("RES_GEN" and friends would otherwise become a bogus extra token).
    const params = tail
      .split(/\s+/)
      .filter((token) => /^(m|ac|tc1|tc2|tce|dtemp|scale|noisy|temp|l|w)\s*=/i.test(token))
      .join(" ");
    const value = normalized.value;
    return { line: [name, nodes, value, params].filter(Boolean).join(" "), model: "" };
  }

  // Active devices: keep the model token and its parameters.
  let modelToken = "";
  let params = "";
  if (typeKeyword && TYPE_KEYWORDS.has(typeKeyword.toLowerCase())) {
    // The type keyword IS the model name ("npn", "diode", …); the rest are
    // device parameters such as m=2.5.
    modelToken = typeKeyword;
    params = tail;
  } else {
    const tokens = tail.split(/\s+/);
    modelToken = tokens[0] ?? "";
    params = tokens.slice(1).join(" ");
  }
  if (!modelToken) return { line: [name, nodes].filter(Boolean).join(" "), model: "" };
  const extra = [modelToken, params].filter(Boolean).join(" ");
  return { line: [name, nodes, extra].filter(Boolean).join(" "), model: modelToken.toLowerCase() };
}

// ── whole-netlist conversion ────────────────────────────────────

/**
 * Convert a Spectre/CDL netlist into plain ngspice syntax.
 *
 * - parenthesised node lists → positional
 * - Spectre type keywords → dropped (or kept as the model name)
 * - passive values → numeric (arithmetic evaluated) or {braced}
 * - .subckt port lists → positional
 * - missing model cards → generic ones are added
 * - a title line is guaranteed (SPICE eats line 1, so a leading .model would
 *   otherwise be swallowed and every device would report a missing model)
 */
export function convertNetlistToNgspice(input: string): NetlistConversion {
  const notes: string[] = [];
  /** Per-device value rewrites — summarised into one note at the end. */
  const valueNotes: string[] = [];
  const lines = input.split(/\r?\n/);
  const out: string[] = [];
  const modelRefs = new Set<string>();
  const definedModels = new Set<string>();
  let hadParens = false;
  let titleAdded = false;

  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed) { out.push(""); continue; }
    if (trimmed.startsWith("*") || trimmed.startsWith("//")) { out.push(trimmed); continue; }

    // .subckt — strip the port-list parentheses.
    if (/^\.subckt\b/i.test(trimmed)) {
      const fixed = stripEscapes(trimmed.replace(/[()]/g, " ").replace(/\s+/g, " ").trim());
      if (fixed !== trimmed) hadParens = true;
      out.push(fixed);
      continue;
    }
    if (/^\.ends\b/i.test(trimmed)) { out.push(trimmed); continue; }

    // .model — remember the name so we do not inject a duplicate.
    const model = /^\.model\s+(\S+)/i.exec(trimmed);
    if (model) {
      definedModels.add(model[1].toLowerCase());
      out.push(trimmed);
      continue;
    }

    // Other directives pass through untouched.
    if (trimmed.startsWith(".")) { out.push(trimmed); continue; }

    // Device line.
    const converted = convertDeviceLine(trimmed, valueNotes);
    if (converted.line !== trimmed) hadParens = hadParens || /\(/.test(trimmed);
    if (converted.model && DEFAULT_MODEL_CARDS[converted.model]) modelRefs.add(converted.model);
    out.push(converted.line);
  }

  // SPICE swallows line 1 as the title: a leading directive would be lost.
  const firstMeaningful = out.find((l) => l.trim() && !l.trim().startsWith("*"));
  if (firstMeaningful && firstMeaningful.trim().startsWith(".")) {
    out.unshift("* ngspice netlist");
    titleAdded = true;
  }
  if (titleAdded) notes.push("added a title comment (SPICE treats line 1 as the title)");

  // Generic model cards for models the netlist uses but does not define.
  const missing = [...modelRefs].filter((m) => !definedModels.has(m));
  if (missing.length > 0) {
    const cards = missing.map((m) => DEFAULT_MODEL_CARDS[m]);
    // The cards must live at the top level — before the first .subckt — so the
    // models are visible both inside the subcircuit and to its instantiation.
    let insertAt = out.length;
    for (let i = 0; i < out.length; i++) {
      const t = out[i].trim();
      if (!t || t.startsWith("*")) continue;
      if (/^\.subckt\b/i.test(t) || !t.startsWith(".")) { insertAt = i; break; }
    }
    out.splice(insertAt, 0, "* -- Model Cards --", ...cards, "");
    notes.push(`added generic .model cards for: ${missing.join(", ")}`);
  }

  if (hadParens) notes.push("converted parenthesised (Spectre/CDL) node lists to positional form");
  if (valueNotes.length > 0) {
    // One summary line instead of one line per device — the tool answer goes
    // straight into the model's context.
    const sample = valueNotes.slice(0, 3).join("; ");
    notes.push(
      valueNotes.length === 1
        ? `evaluated an arithmetic device value: ${sample}`
        : `evaluated ${valueNotes.length} arithmetic device values (e.g. ${sample})`,
    );
  }
  return { netlist: out.join("\n"), notes };
}

// ── analysis handling ───────────────────────────────────────────

/** List the analysis directives present at netlist top level. */
export function findAnalysisDirectives(netlist: string): string[] {
  return netlist
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => ANALYSIS_DIRECTIVE_RE.test(l));
}

export interface ControlBlockResult {
  netlist: string;
  /** Analysis / measurement commands lifted out of .control blocks. */
  hoisted: string[];
  /** Commands that were dropped (they would break the batch run). */
  dropped: string[];
}

/**
 * Flatten `.control ... .endc` blocks.
 *
 * ngspice in batch mode runs the control block first and only then the
 * netlist analyses, so an analysis written inside a control block never
 * produces data — and a `quit` inside the block stops the batch run before
 * the raw file is written. This lifts analysis/measurement commands to the
 * top level and drops everything else (run, print, plot, write, quit, …).
 */
export function flattenControlBlocks(netlist: string): ControlBlockResult {
  const hoisted: string[] = [];
  const dropped: string[] = [];
  const out: string[] = [];
  let inControl = false;

  for (const raw of netlist.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (!inControl) {
      if (/^\.control\b/i.test(trimmed)) { inControl = true; continue; }
      out.push(raw);
      continue;
    }
    if (/^\.endc\b/i.test(trimmed)) { inControl = false; continue; }
    if (!trimmed) continue;
    if (CONTROL_ANALYSIS_RE.test(trimmed) || MEASURE_RE.test(trimmed)) {
      hoisted.push(trimmed);
      continue;
    }
    dropped.push(trimmed);
  }

  let result = out.join("\n");
  if (hoisted.length > 0) {
    // Insert the hoisted commands right before the first analysis directive.
    const lines = result.split(/\r?\n/);
    let insertAt = lines.length;
    for (let i = 0; i < lines.length; i++) {
      if (ANALYSIS_DIRECTIVE_RE.test(lines[i].trim())) { insertAt = i; break; }
    }
    lines.splice(insertAt, 0, ...hoisted, "");
    result = lines.join("\n");
  }
  return { netlist: result, hoisted, dropped };
}

export interface EnsureAnalysisResult {
  netlist: string;
  /** The directive that was added, or null when one was already present. */
  added: string | null;
}

/**
 * Guarantee the netlist asks for an analysis.
 *
 * Without one, `run` does nothing and ngspice writes its "Constant values"
 * plot (boltz, e, planck, …) instead of circuit results — the failure mode
 * that makes the agent report "the tool returned only built-in constants".
 */
export function ensureAnalysis(netlist: string): EnsureAnalysisResult {
  if (findAnalysisDirectives(netlist).length > 0) return { netlist, added: null };
  const lines = netlist.split(/\r?\n/);
  let insertAt = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*\.end\b/i.test(lines[i].trim())) { insertAt = i; break; }
  }
  lines.splice(insertAt, 0, ".op", "");
  return { netlist: lines.join("\n"), added: ".op" };
}

/**
 * Drop device lines that repeat an instance name.
 *
 * A model that writes the testbench into both `testbench` and `directives`
 * (or pastes the DUT twice) produces "device already exists, bail out" in
 * ngspice. Two lines with the same instance name can never be legal, so the
 * second one is dropped and reported.
 */
export function dedupeDeviceLines(netlist: string): { netlist: string; dropped: string[] } {
  const seen = new Set<string>();
  const dropped: string[] = [];
  const kept: string[] = [];
  for (const raw of netlist.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("*") || trimmed.startsWith(".")) { kept.push(raw); continue; }
    const name = /^([A-Za-z]\w*)/.exec(trimmed)?.[1];
    if (!name) { kept.push(raw); continue; }
    const key = name.toLowerCase();
    if (seen.has(key)) { dropped.push(name); continue; }
    seen.add(key);
    kept.push(raw);
  }
  return { netlist: kept.join("\n"), dropped };
}

/**
 * Instantiate a subcircuit that the testbench forgot.
 *
 * The extracted netlist defines the die as a `.subckt` whose ports are the
 * global nets of the chip (OUT, VCC, ref, …). A model that writes only the
 * supply and the load leaves the subcircuit dangling, and the simulation
 * returns a handful of source nodes. The instance is rebuilt from the port
 * list — the port names are the net names.
 */
export function autoInstantiateDut(netlist: string): { netlist: string; notes: string[]; added: string | null } {
  const notes: string[] = [];
  const lines = netlist.split(/\r?\n/);

  const subckts = new Map<string, string[]>();
  let current: string | null = null;
  let currentPorts: string[] = [];
  let instanceLine = -1;
  let instanceNodes: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith("*")) continue;
    const sub = /^\.subckt\s+(\S+)\s*(.*)$/i.exec(line);
    if (sub) {
      current = sub[1];
      currentPorts = sub[2].trim().split(/\s+/).filter(Boolean);
      subckts.set(current, currentPorts);
      continue;
    }
    if (/^\.ends\b/i.test(line)) { current = null; continue; }
    if (current) continue;
    if (line.startsWith(".")) continue;
    const x = /^([X]\w*)\s+(.+)$/i.exec(line);
    if (x) {
      const tokens = x[2].trim().split(/\s+/);
      instanceLine = i;
      instanceNodes = tokens.slice(0, -1);
      const subckt = tokens[tokens.length - 1];
      const ports = subckts.get(subckt);
      if (ports && ports.length !== instanceNodes.length) {
        notes.push(`the ${x[1]} instance connects ${instanceNodes.length} node(s) but "${subckt}" has ${ports.length} port(s) — check the port order`);
      }
      continue;
    }
  }

  if (instanceLine >= 0) return { netlist, notes, added: null };
  if (subckts.size === 0) return { netlist, notes, added: null };

  // Only one candidate: the subcircuit that is not instantiated.
  const [name, ports] = [...subckts.entries()][0];
  if (ports.length === 0) return { netlist, notes, added: null };

  const instance = `X1 ${ports.join(" ")} ${name}`;
  let insertAt = lines.length;
  let inside = false;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t || t.startsWith("*")) continue;
    if (/^\.subckt\b/i.test(t)) { inside = true; continue; }
    if (/^\.ends\b/i.test(t)) { inside = false; continue; }
    if (t.startsWith(".")) continue;
    if (inside) continue;
    insertAt = i;
    break;
  }
  lines.splice(insertAt, 0, `* -- DUT instantiated --`, instance, "");
  notes.push(`the subcircuit "${name}" was never instantiated — added "${instance}" (the port names are the net names of the chip)`);
  return { netlist: lines.join("\n"), notes, added: instance };
}

// ── testbench completion ────────────────────────────────────────

/** Net names that mean "ground". */
const GROUND_NET_RE = /^(gnd|vss|vee|vss_?\d*|vgnd|agnd|gnd_?\d*)$/i;
/** Net names that ARE node 0 in every sense (safe to rename to "0"). */
const HARD_GROUND_RE = /^(a|v)?gnd(_?\d+)?$/i;
/** Net names that mean "power". */
const POWER_NET_RE = /^(vcc|vdd|avcc|avdd|vcc_?\d*|vdd_?\d*|vdda|vddio|vbus|vin_?supply)$/i;

export interface WrapFlatDutResult {
  netlist: string;
  /** True when the DUT was wrapped into a .subckt + instance. */
  wrapped: boolean;
  /** Ports of the generated subcircuit. */
  ports: string[];
}

/** Nodes a line references: everything before the value/model/subckt token. */
function nodesOfLine(line: string): string[] {
  const tokens = line.trim().split(/\s+/);
  const nodes: string[] = [];
  for (const token of tokens.slice(1)) {
    if (!token) continue;
    if (token.includes("=")) break;                       // m=1.23 — parameters end the nodes
    if (SOURCE_KEYWORD_RE.test(token)) break;             // "DC 5", "PULSE(...)"
    if (token.startsWith("(")) break;                     // Spectre-style value
    if (token !== "0" && NUMBERISH_TOKEN_RE.test(token)) break;  // a value, not a node
    nodes.push(token);
  }
  return nodes;
}

/** "1k", "10u", "1.5n", "1e-12" — a value, not a net name. */
const NUMBERISH_TOKEN_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?[a-zA-Z]*$/;
/** Words a source line uses between its nodes and its waveform. */
const SOURCE_KEYWORD_RE = /^(dc|ac|pulse|sin|exp|pwl|sffm|am|laplace|table|noise)$/i;

/** Nodes a device line references (an `X` line ends with the subckt name). */
function nodesOfDeviceLine(line: string): string[] {
  const nodes = nodesOfLine(line);
  return line.trim().charAt(0).toLowerCase() === "x" ? nodes.slice(0, -1) : nodes;
}

/**
 * Wrap a flat DUT into a `.subckt` so the testbench can draw it as a block.
 *
 * An AI finding or a hand-written fragment is a flat pile of devices: there
 * is nothing to hang the testbench sources on, and the testbench view has no
 * rectangle to draw. The ports are inferred the way a schematic engineer
 * would infer them: a net used exactly once inside the DUT *and* referenced
 * by the testbench is a pin; anything used more than once is an internal
 * node. Ground (node 0) is global and never becomes a pin.
 *
 * A net the testbench only measures is a pin as well. ngspice keeps the
 * top-level nodes of a subcircuit in the raw file and drops the internal
 * ones, so a node that stays inside is computed but never drawn — a
 * `.measure` still returns its number while its graph is missing.
 */
export function wrapFlatDut(dut: string, testbench = "", name = "dut"): WrapFlatDutResult {
  const safeName = name.replace(/[^\w]/g, "_") || "dut";
  const deviceLines: string[] = [];
  const directives: string[] = [];
  /** lowercase net → the name the DUT spells it with. */
  const usage = new Map<string, string>();
  let hierarchical = false;

  for (const raw of dut.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("*")) continue;
    if (/^\.subckt\b/i.test(line)) { hierarchical = true; break; }
    // .include / .lib / .param are global — they must survive the wrapping.
    if (line.startsWith(".")) { directives.push(raw); continue; }
    deviceLines.push(raw);
    for (const node of nodesOfDeviceLine(line)) {
      if (!node) continue;
      const key = node.toLowerCase();
      if (!usage.has(key)) usage.set(key, node);
    }
  }

  // Already hierarchical, or nothing to wrap.
  if (hierarchical || deviceLines.length === 0) {
    return { netlist: dut, wrapped: false, ports: [] };
  }

  // A pin is a net the testbench touches inside the DUT: whatever the
  // testbench connects to IS the block's boundary. A net only the testbench
  // knows (between two of its own sources) is not a pin.
  // A pin keeps the DUT's spelling (the name inside the subcircuit); the
  // instance uses the testbench's spelling (the net outside).
  const pins: Array<{ inDut: string; inTb: string }> = [];
  const seen = new Set<string>();
  const addPin = (node: string) => {
    const key = node.toLowerCase();
    if (!node || key === "0" || seen.has(key)) return;  // ground is global
    seen.add(key);
    const inDut = usage.get(key);
    if (!inDut) return;   // a net that lives entirely in the testbench
    pins.push({ inDut, inTb: node });
  };

  for (const raw of testbench.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("*") || line.startsWith(".")) continue;
    for (const node of nodesOfDeviceLine(line)) addPin(node);
  }

  // A node the testbench only *measures* is a pin too. `.measure`, `.print`,
  // `.save` and `.plot` name vectors, not device lines, so the pass above never
  // sees them — and ngspice keeps only the top-level nodes of a subcircuit in
  // the raw file. Without this the vector is computed (a `.measure` still
  // returns its number) but there is nothing left to draw.
  for (const signal of requestedSignals(testbench)) {
    const node = /^v(?:m|p|r|s)?\s*\(\s*([^()]+?)\s*\)$/i.exec(signal.trim())?.[1];
    if (node) addPin(node);
  }

  if (pins.length === 0) return { netlist: dut, wrapped: false, ports: [] };

  // Power and ground pins first: that is how the block reads.
  const rank = (n: string) => (GROUND_NET_RE.test(n) ? 0 : POWER_NET_RE.test(n) ? 1 : 2);
  pins.sort((a, b) => rank(a.inDut) - rank(b.inDut));

  const instance = `X${safeName} ${pins.map((p) => p.inTb).join(" ")} ${safeName}`;
  const netlist = [
    ...directives,
    `.subckt ${safeName} ${pins.map((p) => p.inDut).join(" ")}`,
    ...deviceLines.map((l) => `  ${l.trim()}`),
    `.ends ${safeName}`,
    "",
    instance,
  ].join("\n");

  return { netlist, wrapped: true, ports: pins.map((p) => p.inDut) };
}

/**
 * Rename the ground rail to node 0.
 *
 * The extracted netlist calls the ground rail "GND", so a DUT pin tied to it
 * ends up on a floating net (every voltage comes out 0). A 0 V source does
 * not help — ngspice rejects it ("shorted VSRC") — so the net itself is
 * renamed to node 0, which is what SPICE expects.
 */
export function renameGroundNets(netlist: string): { netlist: string; renamed: string[] } {
  const renamed = new Set<string>();
  const lines = netlist.split(/\r?\n/);

  const rewrite = (line: string): string => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("*")) return line;
    const tokens = line.split(/(\s+)/);
    let seenFirst = false;
    return tokens.map((token) => {
      if (!token.trim()) return token;
      if (!seenFirst) { seenFirst = true; return token; }
      const bare = token.trim();
      if (HARD_GROUND_RE.test(bare)) {
        renamed.add(bare);
        return token.replace(bare, "0");
      }
      return token;
    }).join("");
  };

  const out = lines.map(rewrite);
  return { netlist: out.join("\n"), renamed: [...renamed] };
}

export interface AutoTestbenchResult {
  netlist: string;
  notes: string[];
  /** Sources the tool added. */
  added: string[];
}

/**
 * Complete a testbench that the model forgot to wire up.
 *
 * Two mistakes make a simulation meaningless while looking successful:
 *
 *  1. The DUT's ground pin is tied to a net called "GND" — in the extracted
 *     netlist the ground rail is *named*, not node 0 — so the whole circuit
 *     floats and every voltage comes out as 0.
 *  2. No supply source at all: the power pin has no source.
 *
 * This adds the missing 0 V tie and a default supply, and reports exactly
 * what it assumed so the model can correct it.
 */
export function autoTestbench(netlist: string, supplyVoltage = 5): AutoTestbenchResult {
  const notes: string[] = [];
  const added: string[] = [];
  let source = netlist;
  const lines = netlist.split(/\r?\n/);

  // Subcircuit port lists and the top-level instance.
  const subcktPorts = new Map<string, string[]>();
  let current: string | null = null;
  let instance: { name: string; nodes: string[]; subckt: string } | null = null;
  const topLevelSources: string[] = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("*")) continue;
    const sub = /^\.subckt\s+(\S+)\s*(.*)$/i.exec(line);
    if (sub) {
      current = sub[1];
      subcktPorts.set(current, sub[2].trim().split(/\s+/).filter(Boolean));
      continue;
    }
    if (/^\.ends\b/i.test(line)) { current = null; continue; }
    if (current) continue;
    if (line.startsWith(".")) continue;
    const x = /^([X]\w*)\s+(.+)$/i.exec(line);
    if (x) {
      const tokens = x[2].trim().split(/\s+/);
      instance = { name: x[1], nodes: tokens.slice(0, -1), subckt: tokens[tokens.length - 1] };
      continue;
    }
    const v = /^([VI]\w*)\s+(\S+)\s+(\S+)/i.exec(line);
    if (v) topLevelSources.push(v[2].toLowerCase());
  }

  // Nets the DUT exposes: port name → net name.
  const portNets = new Map<string, string>();
  if (instance) {
    const ports = subcktPorts.get(instance.subckt) ?? [];
    ports.forEach((port, i) => portNets.set(port, instance!.nodes[i] ?? port));
  }

  const groundNets = new Set<string>();
  const powerNets = new Set<string>();
  for (const [port, net] of portNets) {
    if (GROUND_NET_RE.test(port) || GROUND_NET_RE.test(net)) groundNets.add(net);
    else if (POWER_NET_RE.test(port) || POWER_NET_RE.test(net)) powerNets.add(net);
  }
  // No subcircuit? Fall back to the names used by the top-level devices.
  if (portNets.size === 0) {
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith("*") || line.startsWith(".")) continue;
      const tokens = line.split(/\s+/);
      for (const token of tokens.slice(1)) {
        if (GROUND_NET_RE.test(token)) groundNets.add(token);
        else if (POWER_NET_RE.test(token)) powerNets.add(token);
      }
    }
  }

  const injections: string[] = [];

  // 1. The ground rail becomes node 0 (a 0 V source would be a shorted VSRC).
  const hardGround = [...groundNets].filter((net) => HARD_GROUND_RE.test(net));
  if (hardGround.length > 0) {
    const renamed = renameGroundNets(netlist);
    if (renamed.renamed.length > 0) {
      notes.push(`the ground rail was a floating net — renamed ${renamed.renamed.join(", ")} to node 0 (SPICE's ground)`);
    }
    // Work on the renamed netlist from here on.
    source = renamed.netlist;
    for (const net of hardGround) groundNets.delete(net);
  }

  // 2. Supply the power rails that have no source.
  const sources = topLevelSources.map((n) => n.toLowerCase());
  if (sources.length === 0 || ![...powerNets].some((net) => sources.includes(net.toLowerCase()))) {
    for (const net of powerNets) {
      if (net === "0") continue;
      if (sources.includes(net.toLowerCase())) continue;
      injections.push(`VDD_${net} ${net} 0 DC ${supplyVoltage}`);
      added.push(`VDD_${net}`);
      notes.push(`no supply was connected — added VDD_${net} ${net} 0 DC ${supplyVoltage} (assumed ${supplyVoltage} V, override it in your next call if the die runs at another voltage)`);
    }
  }

  if (injections.length === 0) return { netlist: source, notes, added };

  // Insert the sources at the top level — before the first device line that is
  // NOT inside a .subckt block (a source inside a subcircuit would be scoped
  // to it and would not feed the instance).
  const out = source.split(/\r?\n/);
  let insertAt = out.length;
  let inside = false;
  for (let i = 0; i < out.length; i++) {
    const t = out[i].trim();
    if (!t || t.startsWith("*")) continue;
    if (/^\.subckt\b/i.test(t)) { inside = true; continue; }
    if (/^\.ends\b/i.test(t)) { inside = false; continue; }
    if (t.startsWith(".")) continue;
    if (inside) continue;
    insertAt = i;
    break;
  }
  out.splice(insertAt, 0, "* -- Testbench completed by the tool --", ...injections, "");
  return { netlist: out.join("\n"), notes, added };
}

// ── measurement parsing ─────────────────────────────────────────

/**
 * Parse `.measure` results out of ngspice stdout.
 *
 * ngspice prints them under a "Measurements for <analysis> Analysis" header:
 *   vout_max            =  5.00000e+00 at=  1.00000e+01
 */
export function parseNgspiceMeasurements(output: string): Record<string, number> {
  const measurements: Record<string, number> = {};
  const lines = output.split(/\r?\n/);
  let inMeasurements = false;
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (/^Measurements for\b/i.test(trimmed)) { inMeasurements = true; continue; }
    if (!inMeasurements) continue;
    const m = /^([A-Za-z_]\w*)\s*=\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/.exec(trimmed);
    if (m) measurements[m[1]] = Number(m[2]);
  }
  return measurements;
}

/**
 * `.measure op <name> find <expr>` — ngspice has no `op` measurement type,
 * so evaluate the expression against the operating point ourselves.
 * Returns the value, or null when the expression cannot be evaluated.
 */
export function evaluateOpMeasurement(
  expr: string,
  values: Record<string, number>,
): number | null {
  const text = expr.trim();
  // v(node) / i(source) lookups, then plain arithmetic over them.
  if (/^v\([^)]+\)$/i.test(text)) {
    const node = text.slice(2, -1).trim().toLowerCase();
    return lookupOpValue(`v(${node})`, values);
  }
  if (/^i\([^)]+\)$/i.test(text)) {
    const src = text.slice(2, -1).trim().toLowerCase();
    return lookupOpValue(`i(${src})`, values);
  }
  // Arithmetic over v()/i() terms: "v(a)-v(b)", "v(a)/2", …
  const replaced = text.replace(/([vi])\(([^)]+)\)/gi, (_all, kind: string, node: string) => {
    const value = lookupOpValue(`${kind.toLowerCase()}(${node.trim().toLowerCase()})`, values);
    return value === null || value === undefined ? "NaN" : String(value);
  });
  if (/[A-Za-z_]/.test(replaced.replace(/[eE][+-]?\d+/g, ""))) return null;
  return evaluateNumericExpression(replaced);
}

function lookupOpValue(key: string, values: Record<string, number>): number | null {
  if (key in values) return values[key];
  // ngspice names the source current "i(v1#branch)" in the raw file but
  // "i(v1)" in .measure expressions.
  const alt = key.endsWith("#branch") ? key : `${key}#branch`;
  if (alt in values) return values[alt];
  return null;
}

/** Extract `.meas`/`.measure` directives and their expressions from a netlist. */
export function findMeasureDirectives(netlist: string): Array<{ name: string; expression: string }> {
  const found: Array<{ name: string; expression: string }> = [];
  for (const raw of netlist.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (!MEASURE_RE.test(trimmed)) continue;
    const body = trimmed.replace(/^\.(meas|measure)\b/i, "").trim();
    const tokens = body.split(/\s+/);
    const type = tokens[0]?.toLowerCase() ?? "";
    if (type !== "op") continue;
    const name = tokens[1] ?? "";
    const findIndex = tokens.findIndex((t) => t.toLowerCase() === "find");
    if (!name || findIndex === -1) continue;
    const expression = tokens.slice(findIndex + 1).filter((t) => t.toLowerCase() !== "at" && !/^at=/i.test(t)).join(" ");
    found.push({ name, expression });
  }
  return found;
}

/**
 * Remove `.measure op ...` directives from a netlist.
 *
 * ngspice rejects the `op` measurement type outright ("unrecognized analysis
 * type 'op'"), so the tool evaluates those expressions itself against the
 * operating point instead of letting ngspice fail on them.
 */
export function stripOpMeasurementDirectives(netlist: string): { netlist: string; stripped: string[] } {
  const stripped: string[] = [];
  const kept = netlist.split(/\r?\n/).filter((raw) => {
    const trimmed = raw.trim();
    if (!MEASURE_RE.test(trimmed)) return true;
    const body = trimmed.replace(/^\.(meas|measure)\b/i, "").trim();
    const type = body.split(/\s+/)[0]?.toLowerCase() ?? "";
    if (type !== "op") return true;
    stripped.push(trimmed);
    return false;
  });
  return { netlist: kept.join("\n"), stripped };
}

// ── testbench view ───────────────────────────────────────────────

/** The `* ── Testbench ──` / `* ── Directives ──` header of a composed netlist. */
const SECTION_MARKER_RE = /^\*\s*(?:─+|-+)\s*(Testbench|Directives|User\s+Directives)\s*(?:─+|-+)\s*$/i;
const SUBCKT_HEADER_RE = /^\.subckt\s+(\S+)\s*(.*)$/i;
const SUBCKT_ENDS_RE = /^\.ends\b/i;
const INSTANCE_LINE_RE = /^([Xx]\w*)\s+(.+)$/;

/** Top-level lines of a netlist: everything that is not inside a `.subckt`. */
function splitTopLevel(netlist: string): { top: string[]; subcktCount: number } {
  const top: string[] = [];
  let subcktCount = 0;
  let inside = false;
  for (const raw of netlist.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("*")) { if (!inside) top.push(raw); continue; }
    if (SUBCKT_HEADER_RE.test(trimmed)) { inside = true; subcktCount++; continue; }
    if (inside) { if (SUBCKT_ENDS_RE.test(trimmed)) inside = false; continue; }
    top.push(raw);
  }
  return { top, subcktCount };
}

/** Drop every `.subckt … .ends` block — the DUT body never enters a view. */
function stripSubcircuitBlocks(text: string): string {
  const out: string[] = [];
  let inside = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (SUBCKT_HEADER_RE.test(line)) { inside = true; continue; }
    if (inside) { if (SUBCKT_ENDS_RE.test(line)) inside = false; continue; }
    out.push(raw);
  }
  return out.join("\n");
}

/** Every `.subckt NAME ports…` header, with its ports in order. */
function subcktHeaders(netlist: string): Array<{ name: string; ports: string[] }> {
  const found: Array<{ name: string; ports: string[] }> = [];
  for (const raw of netlist.split(/\r?\n/)) {
    const m = SUBCKT_HEADER_RE.exec(raw.trim());
    if (!m) continue;
    found.push({ name: m[1], ports: m[2].trim().split(/\s+/).filter(Boolean) });
  }
  return found;
}

/** Top-level `X…` instances (a subcircuit body has none of those). */
function instanceLines(netlist: string): Array<{ name: string; nodes: string[]; subckt: string; line: string }> {
  const found: Array<{ name: string; nodes: string[]; subckt: string; line: string }> = [];
  let inside = false;
  for (const raw of netlist.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("*")) continue;
    if (SUBCKT_HEADER_RE.test(line)) { inside = true; continue; }
    if (inside) { if (SUBCKT_ENDS_RE.test(line)) inside = false; continue; }
    if (line.startsWith(".")) continue;
    const x = INSTANCE_LINE_RE.exec(line);
    if (!x) continue;
    const tokens = x[2].trim().split(/\s+/);
    found.push({ name: x[1], nodes: tokens.slice(0, -1), subckt: tokens[tokens.length - 1], line });
  }
  return found;
}

/**
 * Split a simulation netlist into "the DUT" and "the testbench".
 *
 * Both netlist producers mark the split: `composeSimulationNetlist` writes
 * `* ── Directives ──` and the assistant tool writes `* ── Testbench ──`
 * right before the testbench section. When there is no marker the split falls
 * back to structure — a netlist with `.subckt` blocks keeps its top level as
 * the testbench — and finally to whatever the caller knows.
 */
export function splitSimulationSections(
  netlist: string,
  fallback?: { dut: string; testbench: string },
): { dut: string; testbench: string } {
  const lines = netlist.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (SECTION_MARKER_RE.test(lines[i].trim())) {
      return { dut: lines.slice(0, i).join("\n"), testbench: lines.slice(i + 1).join("\n") };
    }
  }
  const { top, subcktCount } = splitTopLevel(netlist);
  if (subcktCount > 0) return { dut: netlist, testbench: top.join("\n") };
  return fallback ?? { dut: netlist, testbench: "" };
}

/**
 * Split a netlist the assistant ran into "the DUT" and "the testbench" using
 * only the section marker both producers write (`* ── Testbench ──` from the
 * backend tool, `* ── Directives ──` from the composed netlist).
 *
 * `dut` is null when there is no marker. A netlist that does not say where the
 * testbench starts cannot be split safely, and guessing would duplicate the
 * testbench as soon as the netlist is recomposed.
 */
export function splitAtSectionMarker(netlist: string): { dut: string | null; testbench: string } {
  const lines = netlist.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (SECTION_MARKER_RE.test(lines[i].trim())) {
      return { dut: lines.slice(0, i).join("\n"), testbench: lines.slice(i + 1).join("\n") };
    }
  }
  return { dut: null, testbench: "" };
}

/**
 * Drop the scaffolding the runner wraps around a netlist, so a simulated
 * netlist becomes an editable testbench again.
 *
 * The assistant tool assembles `save … / run / write sim.raw / quit` inside a
 * `.control` block and closes the deck with `.end`. That is the runner's own
 * plumbing — the simulator drives ngspice itself and would otherwise execute a
 * second `run` and quit out from under it. `.print`, `.save`, `.measure`, the
 * sources and the analysis all belong to the testbench and stay.
 */
export function stripRunScaffolding(netlist: string): string {
  const out: string[] = [];
  let inControl = false;
  for (const raw of netlist.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^\.control\b/i.test(line)) { inControl = true; continue; }
    if (inControl) { if (/^\.endc\b/i.test(line)) inControl = false; continue; }
    if (SECTION_MARKER_RE.test(line)) continue;
    if (/^\.end\s*$/i.test(line)) continue;
    out.push(raw);
  }
  return out.join("\n").trim();
}

/** First free `X…` name, given the instances the testbench already has. */
function uniqueInstanceName(instances: Array<{ name: string }>): string {
  const taken = new Set(instances.map((i) => i.name.toLowerCase()));
  let n = 1;
  while (taken.has(`x${n}`)) n++;
  return `X${n}`;
}

export interface TestbenchViewResult {
  /** The netlist the testbench tab draws: a DUT block with no body + the testbench. */
  netlist: string;
  /** Name of the DUT block, when one could be built. */
  dutName: string | null;
  /** Ports of the DUT block, in order. */
  ports: string[];
  /** True when the view has a DUT block with at least one pin. */
  ok: boolean;
  /** Why the DUT block is missing. */
  message?: string;
}

/**
 * The netlist the testbench view draws — and the only one it ever draws.
 *
 * The testbench tab answers "what drives what", so it gets the testbench
 * elements plus ONE rectangle for the DUT with its pins. The DUT's own body
 * is dropped on purpose: without this guard a flat netlist (the way the
 * assistant tool emits it) makes the view degenerate into a picture of the
 * whole chip, which tells the user nothing about the testbench.
 *
 * @param input.dutNetlist  the DUT — a `.subckt` block or a flat device list
 * @param input.directives  the testbench — sources, loads, analysis, `.print`
 * @param input.dutName     block name when the DUT is flat or has several subcircuits
 */
export function buildTestbenchViewNetlist(input: {
  dutNetlist?: string;
  directives?: string;
  dutName?: string;
}): TestbenchViewResult {
  const dut = input.dutNetlist ?? "";
  const testbench = stripSubcircuitBlocks(input.directives ?? "");
  const wanted = input.dutName?.trim() ?? "";
  const instances = instanceLines(testbench);
  const headers = subcktHeaders(dut);
  // The DUT section may already carry the instance (`wrapFlatDut` writes it
  // there); reusing it keeps the testbench's own net spellings.
  const dutInstances = instanceLines(dut);

  // Which subcircuit is "the DUT"? Whatever the testbench instantiates, else
  // the name the page has selected, else the only one there is.
  const chosen =
    headers.find((h) => instances.some((i) => i.subckt.toLowerCase() === h.name.toLowerCase())) ??
    (wanted ? headers.find((h) => h.name.toLowerCase() === wanted.toLowerCase()) : undefined) ??
    headers[0];

  let dutName: string | null = chosen?.name ?? null;
  let ports: string[] = chosen?.ports ?? [];
  /** An instance line the testbench itself does not have. */
  let generatedInstance: string | null = null;

  if (chosen) {
    const inTestbench = instances.some((i) => i.subckt.toLowerCase() === chosen.name.toLowerCase());
    if (!inTestbench) {
      const fromDut = dutInstances.find((i) => i.subckt.toLowerCase() === chosen.name.toLowerCase());
      generatedInstance = fromDut
        ? fromDut.line
        : `${uniqueInstanceName([...instances, ...dutInstances])} ${ports.join(" ")} ${chosen.name}`;
    }
  } else {
    // Flat DUT: the pins are inferred the way the simulator infers them, and
    // `wrapFlatDut` writes the instance the testbench is missing.
    const wrapped = wrapFlatDut(dut, testbench, wanted || "chip");
    if (wrapped.wrapped) {
      const header = subcktHeaders(wrapped.netlist)[0];
      dutName = header?.name ?? null;
      ports = header?.ports ?? wrapped.ports;
      generatedInstance = instanceLines(wrapped.netlist)[0]?.line ?? null;
    }
  }

  const withBlock = dutName !== null && ports.length > 0;
  const parts: string[] = [];
  if (withBlock) {
    parts.push("* ── Testbench view ── the DUT is a block, its contents are not drawn");
    parts.push(`.subckt ${dutName} ${ports.join(" ")}`.trimEnd());
    parts.push(`.ends ${dutName}`);
    parts.push("");
  }
  parts.push(testbench.trim());
  if (withBlock && generatedInstance) {
    parts.push("");
    parts.push(generatedInstance);
  }

  return {
    netlist: parts.join("\n").replace(/\n{3,}/g, "\n\n").trim(),
    dutName: withBlock ? dutName : null,
    ports: withBlock ? ports : [],
    ok: withBlock,
    message: withBlock
      ? undefined
      : "the DUT has no subcircuit with pins the testbench touches — nothing to draw it as a block",
  };
}

// ── requested signals ────────────────────────────────────────────

/** Analysis keyword that opens a `.print`/`.plot` argument list. */
const PRINT_ANALYSIS_RE = /^(op|dc|tran|ac|noise|tf|disto|pz|sens|transfer)$/i;
/** `.save` words that are not signals. */
const SAVE_KEYWORDS = new Set(["all", "none", "one", "two", "three", "four", "five"]);
/** An explicit vector call: `v(ref)`, `i(vdd)`, `vm(out)`, … */
const VECTOR_CALL_RE = /^[vi](?:m|p|r|s)?\s*\(/i;
/** A bare node name — `.save ref` means "keep v(ref)". */
const BARE_NAME_RE = /^[A-Za-z_][\w.$]*$/;
/** Vector calls inside a `.measure` expression. */
const VECTOR_IN_EXPR_RE = /\b([vi](?:m|p|r|s)?\s*\([^()]*\))/gi;
/** Device-internal collector vectors: `@m1[ic]`. */
const AT_VECTOR_RE = /@[A-Za-z_][\w.]*\[[^\]]*\]/g;

/**
 * The signals the netlist explicitly asks for: `.print`, `.save`, `.plot`,
 * `.measure` and the `print`/`save`/`plot` commands inside a `.control` block.
 *
 * An empty result means "the netlist does not care" — every vector of the run
 * is worth showing. A non-empty result is a request to keep only those, so a
 * testbench that writes `.print v(ref)` gets one graph instead of one per
 * internal node of the chip.
 */
export function requestedSignals(netlist: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  const keep = (token: string) => {
    let t = token.trim().replace(/^['"]+|['"]+$/g, "");
    // one wrapping layer: `.print (vref)` means the node vref, and `save (vref)`
    // is not a vector ngspice understands
    if (t.startsWith("(") && t.endsWith(")") && t.indexOf(")") === t.length - 1) t = t.slice(1, -1).trim();
    if (!t || t.includes("=")) return;
    const low = t.toLowerCase();
    if (SAVE_KEYWORDS.has(low)) return;
    if (!t.startsWith("@") && !VECTOR_CALL_RE.test(t) && !BARE_NAME_RE.test(t)) return;
    if (seen.has(low)) return;
    seen.add(low);
    out.push(t);
  };

  let inControl = false;
  for (const raw of netlist.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("*")) continue;
    if (/^\.control\b/i.test(line)) { inControl = true; continue; }
    if (/^\.endc\b/i.test(line)) { inControl = false; continue; }

    const directive = /^\.(print|save|plot)\b\s*(.*)$/i.exec(line);
    const command = !directive && inControl ? /^(print|save|plot)\b\s*(.*)$/i.exec(line) : null;
    const list = directive ?? command;
    if (list) {
      let rest = list[2];
      if (list[1].toLowerCase() !== "save") {
        // `.print dc v(out)` opens with the analysis name; `.print v(out)` does not.
        const head = /^(\S+)\s*/.exec(rest);
        if (head && PRINT_ANALYSIS_RE.test(head[1])) rest = rest.slice(head[0].length);
      }
      for (const token of rest.split(/[\s,]+/)) keep(token);
      continue;
    }
    if (MEASURE_RE.test(line) || (inControl && /^meas(ure)?\b/i.test(line))) {
      for (const m of line.matchAll(VECTOR_IN_EXPR_RE)) keep(m[1]);
      for (const m of line.matchAll(AT_VECTOR_RE)) keep(m[0]);
    }
  }
  return out;
}

const VECTOR_PREFIX_RE = /^([vi](?:m|p|r|s)?)\s*\((.+)\)$/i;

/**
 * Comparison keys for a signal the testbench asked for, so `.print` matches
 * however it was spelled: `v(ref)`, `(vref)` and `ref` all name the same node.
 *
 * An explicit `v(…)`/`i(…)` stays exact — a type is never guessed away, so
 * asking for the supply current does not pull in the supply voltage.
 */
export function requestedSignalKeys(token: string): string[] {
  let t = token.trim().toLowerCase().replace(/^['"]+|['"]+$/g, "");
  if (!t) return [];
  // one wrapping layer: "(vref)" → "vref"
  if (t.startsWith("(") && t.endsWith(")") && t.indexOf(")") === t.length - 1) t = t.slice(1, -1).trim();
  const prefixed = VECTOR_PREFIX_RE.exec(t);
  if (prefixed) {
    if (prefixed[1] === "v" || prefixed[1] === "i") return [t];
    return [t, `v(${prefixed[2]})`];
  }
  // A bare name: `.save ref` means both `ref` and `v(ref)` to a reader.
  const keys = new Set<string>([t, `v(${t})`, `i(${t})`]);
  if (t.length > 1 && /^[vi]/.test(t)) keys.add(t.slice(1));
  return [...keys];
}

/**
 * Comparison keys of a measured vector: `v(ref)` is known as `v(ref)` and as
 * the node `ref`, which is how a bare or vref-style request spells it.
 */
export function vectorKeys(name: string): string[] {
  const t = name.trim().toLowerCase();
  if (!t) return [];
  const prefixed = VECTOR_PREFIX_RE.exec(t);
  if (prefixed) return prefixed[1] === "v" || prefixed[1] === "i" ? [t, prefixed[2]] : [t];
  return [t];
}
