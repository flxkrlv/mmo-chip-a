import { useCallback, useState, useRef, useEffect } from "react";
import type { SpiceDialect, LvsRawResult, LvsEngine, LvsCombinedResult } from "shared";
import type { LvsEngineResult } from "shared";
import { compareNetlists, saveLvsSnapshot } from "../../api/lvs";
import { Ic } from "../../icons";

// ── Styles ────────────────────────────────────────────────────

const textareaBase: React.CSSProperties = {
  width: "100%", fontFamily: "var(--mono)", fontSize: 12, lineHeight: 1.5,
  background: "var(--bg1)", border: "1px solid var(--l2)", borderRadius: 4,
  color: "var(--fg)", padding: 6, resize: "vertical", outline: "none",
};

const panelBase: React.CSSProperties = {
  fontSize: 11, fontFamily: "var(--mono)", lineHeight: 1.5,
  padding: "4px 6px", marginTop: 2, borderRadius: 3,
  background: "var(--l1)",
};

const sectionTitle: React.CSSProperties = {
  fontSize: 11, fontWeight: 600, color: "var(--ink2)", marginBottom: 4,
};

const tableSm: React.CSSProperties = { width: "100%", fontSize: 11, borderCollapse: "collapse" };

// ── Types ────────────────────────────────────────────────────

type DiffCategory = "l-only" | "s-only" | "mismatch" | "type-mismatch";

interface DeviceDiff {
  name: string;
  category: DiffCategory;
  layoutLine: string;
  schematicLine: string;
  collapsedLayout?: number;
  collapsedSchematic?: number;
}

interface LvsResultData {
  engine: LvsEngine;
  matched: boolean;
  json: LvsRawResult;
  report: string;
  devices: DeviceDiff[];
}

type PanelPhase =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "done"; data: LvsResultData }
  | { phase: "error"; error: string; detail?: string };

interface Props {
  dieId: string;
  layoutNetlist: string | null;
  dialect: SpiceDialect;
  moduleName: string;
  deviceToHighlight?: string | null;
}

// ── Report text generator ───────────────────────────────────

function generateReportText(data: LvsResultData, devices: DeviceDiff[]): string {
  const { json, matched, report } = data;
  const lines: string[] = [];

  lines.push(`LVS Report`);
  lines.push(`Status: ${matched ? "MATCH" : "MISMATCH"}`);
  const totalDev = Math.max(json.a_devices, json.b_devices);
  const devs = devices.length;
  lines.push(`Devices: ${totalDev} — ${devs} diff${devs !== 1 ? "s" : ""}  Nets: ${json.a_nets}/${json.b_nets}`);
  const parts: string[] = [];
  const stLOnly = devices.filter(d => d.category === "l-only").length;
  const stSOnly = devices.filter(d => d.category === "s-only").length;
  const stTypeM = devices.filter(d => d.category === "type-mismatch").length;
  const stParamC = devices.filter(d => d.category === "mismatch" && !terminalsDiffer(d.layoutLine, d.schematicLine)).length;
  const stConnM = devices.filter(d => d.category === "mismatch" && terminalsDiffer(d.layoutLine, d.schematicLine)).length;
  if (stLOnly) parts.push(`L-only:${stLOnly}`);
  if (stSOnly) parts.push(`S-only:${stSOnly}`);
  if (stTypeM) parts.push(`Type:${stTypeM}`);
  if (stParamC) parts.push(`Param:${stParamC}`);
  if (stConnM) parts.push(`Conn:${stConnM}`);
  if (parts.length) lines.push(`  diffs — ${parts.join(" ")}`);
  lines.push(`Iterations: ${json.iterations}`);
  if (json.only_in_a_ports.length) lines.push(`Extra L ports: ${json.only_in_a_ports.join(", ")}`);
  if (json.only_in_b_ports.length) lines.push(`Extra S ports: ${json.only_in_b_ports.join(", ")}`);
  lines.push("");

  // Device diffs
  const lOnly = devices.filter((d) => d.category === "l-only");
  const sOnly = devices.filter((d) => d.category === "s-only");
  const typeMism = devices.filter((d) => d.category === "type-mismatch");
  const mism = devices.filter((d) => d.category === "mismatch");

  if (devices.length) {
    lines.push("── Device Diffs ──");
    lines.push("");
    if (lOnly.length) {
      lines.push(`Only in Layout (${lOnly.length}):`);
      for (const d of lOnly) lines.push(`  ${d.name}  ${d.layoutLine}`);
      lines.push("");
    }
    if (sOnly.length) {
      lines.push(`Only in Schematic (${sOnly.length}):`);
      for (const d of sOnly) lines.push(`  ${d.name}  ${d.schematicLine}`);
      lines.push("");
    }
    if (typeMism.length) {
      lines.push(`Device Type Mismatch (${typeMism.length}) — different model type:`);
      for (const d of typeMism) {
        lines.push(`  ${d.name}`);
        lines.push(`    L: ${d.layoutLine}`);
        lines.push(`    S: ${d.schematicLine}`);
      }
      lines.push("");
    }
    if (mism.length) {
      const paramOnly = mism.filter(d => !terminalsDiffer(d.layoutLine, d.schematicLine));
      const connMism = mism.filter(d => terminalsDiffer(d.layoutLine, d.schematicLine));
      if (paramOnly.length) {
        lines.push(`Param Changed (${paramOnly.length}) — same topology, different W/L/R/m:`);
        for (const d of paramOnly) {
          lines.push(`  ${d.name}`);
          lines.push(`    L: ${d.layoutLine}`);
          lines.push(`    S: ${d.schematicLine}`);
        }
        lines.push("");
      }
      if (connMism.length) {
        lines.push(`Connection Mismatch (${connMism.length}) — different terminal connections:`);
        for (const d of connMism) {
          lines.push(`  ${d.name}`);
          lines.push(`    L: ${d.layoutLine}`);
          lines.push(`    S: ${d.schematicLine}`);
        }
        lines.push("");
      }
    }
  }

  // Net count comparison
  if (json.a_nets !== json.b_nets) {
    lines.push(`── Net Counts ──`);
    lines.push(`  Layout: ${json.a_nets}  Schematic: ${json.b_nets}`);
    lines.push("");
  }

  // Property diffs
  if (json.property_diffs.length) {
    lines.push("── Property Diffs ──");
    for (const d of json.property_diffs) {
      lines.push(`  ${d.kind} ${d.param}  L:${d.a_device}=${fmtVal(d.a_value)}  S:${d.b_device}=${fmtVal(d.b_value)}`);
    }
    lines.push("");
  }

  // Full vyges-lvs report
  if (report) {
    lines.push("── vyges-lvs Report ──");
    lines.push(report);
  }

  return lines.join("\n");
}

// ── Helpers ──────────────────────────────────────────────────

function buildDeviceMap(netlist: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const raw of netlist.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("*") || line.startsWith(".")) continue;
    const first = line.split(/\s+/)[0];
    if (first) map.set(first.toLowerCase(), line);
  }
  return map;
}

/** Strip vyges-lvs side prefix (A/, B/) and collapsed suffix (+N, ⨯-N) */
function stripSide(name: string): string {
  return name
    .replace(/^[AB]\//, "")
    .replace(/\(\+\d+\)$/, "")
    .replace(/\([×⨯]\-?\d+\)$/, "")
    .replace(/\(�-\d+\)$/, "");
}

/** Parse collapsed count from vyges-lvs name suffix: (+N) or (⨯-N) */
function parseCollapsedCount(name: string): { clean: string; count: number | null } {
  const clean = stripSide(name);
  // (+N) → collapsed with N+1 devices total
  const mPlus = name.match(/\(\+(\d+)\)$/);
  if (mPlus) return { clean, count: parseInt(mPlus[1]) + 1 };
  // (⨯-N), (×-N), (�-N) → collapsed N times
  const mMult = name.match(/\([×⨯�]\-?(\d+)\)$/);
  if (mMult) return { clean, count: parseInt(mMult[1]) };
  return { clean, count: null };
}

/** Extract terminal nets from a device line */
function parseTerminals(line: string): string[] {
  const s = line.indexOf("(");
  const e = line.lastIndexOf(")");
  if (s === -1 || e === -1) return [];
  return line.slice(s + 1, e).split(/\s+/).filter(Boolean);
}

/** Extract params (everything after model name) from a device line */
function parseParams(line: string): string {
  const e = line.lastIndexOf(")");
  if (e === -1) return "";
  const rest = line.slice(e + 1).trim();
  // Remove model name (first word after parens)
  const parts = rest.split(/\s+/);
  return parts.slice(1).join(" "); // skip model keyword, return params
}

/** Compare terminals-only (skip params): true if terminals differ */
function terminalsDiffer(layoutLine: string, schematicLine: string): boolean {
  return parseTerminals(layoutLine).join(" ") !== parseTerminals(schematicLine).join(" ");
}

/** Detect netlist dialect from content */
function detectDialect(netlist: string): SpiceDialect | "unknown" {
  for (const raw of netlist.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("//") || line.startsWith("*")) continue;
    if (/^simulator\s+lang\s*=\s*spectre/i.test(line)) return "spectre";
    if (/^\.?\s*(subckt|SUBCKT)\b/.test(line)) {
      return line.includes("(") && line.includes(")") ? "spectre" : "cdl";
    }
  }
  for (const raw of netlist.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("//") || line.startsWith("*") || line.startsWith(".")) continue;
    if (/^\w+\s+\(/.test(line)) return "spectre";
    if (/^\w+\s+\S+\s+\S+/.test(line)) return "cdl";
  }
  return "unknown";
}

function parseModelType(line: string): string {
  const e = line.lastIndexOf(")");
  if (e === -1) return "";
  return line.slice(e + 1).trim().split(/\s+/)[0] || "";
}

function buildDiffs(layoutNetlist: string, schematicNetlist: string, json: LvsRawResult): DeviceDiff[] {
  const layoutMap = buildDeviceMap(layoutNetlist);
  const schematicMap = buildDeviceMap(schematicNetlist);
  const diffs: DeviceDiff[] = [];

  // Extract collapsed counts from raw unbalanced names (before stripSide)
  const collapsedMap = new Map<string, { collapsedLayout?: number; collapsedSchematic?: number }>();
  for (const cls of json.unbalanced) {
    if (cls.what !== "device") continue;
    for (const n of cls.a) {
      const { clean, count } = parseCollapsedCount(n);
      if (count !== null) {
        if (!collapsedMap.has(clean)) collapsedMap.set(clean, {});
        collapsedMap.get(clean)!.collapsedLayout = count;
      }
    }
    for (const n of cls.b) {
      const { clean, count } = parseCollapsedCount(n);
      if (count !== null) {
        if (!collapsedMap.has(clean)) collapsedMap.set(clean, {});
        collapsedMap.get(clean)!.collapsedSchematic = count;
      }
    }
  }

  // Phase 1: collect unbalanced device names from vyges-lvs
  const unbalancedNames = new Set<string>();
  for (const cls of json.unbalanced) {
    if (cls.what !== "device") continue;
    for (const n of cls.a) unbalancedNames.add(stripSide(n).toLowerCase());
    for (const n of cls.b) unbalancedNames.add(stripSide(n).toLowerCase());
  }

  // Phase 2: check each unbalanced name against layoutMap/schematicMap
  for (const name of unbalancedNames) {
    const lLine = layoutMap.get(name);
    const sLine = schematicMap.get(name);
    if (lLine === undefined && sLine === undefined) continue;

    const collapsed = collapsedMap.get(name);

    if (lLine !== undefined && sLine !== undefined) {
      if (lLine === sLine) continue; // cascade artifact (same line both sides)
      const cat = parseModelType(lLine) !== parseModelType(sLine) ? "type-mismatch" : "mismatch";
      diffs.push({ name, category: cat, layoutLine: lLine, schematicLine: sLine, ...collapsed });
    } else if (lLine !== undefined) {
      diffs.push({ name, category: "l-only", layoutLine: lLine, schematicLine: "", ...collapsed });
    } else {
      diffs.push({ name, category: "s-only", layoutLine: "", schematicLine: sLine!, ...collapsed });
    }
  }

  return diffs;
}

function fmtVal(n: number): string {
  const abs = Math.abs(n);
  if (abs === 0) return "0";
  if (abs >= 1e6) return (n / 1e6).toFixed(3) + "M";
  if (abs >= 1e3) return (n / 1e3).toFixed(3) + "k";
  if (abs >= 1) return n.toFixed(3);
  if (abs >= 1e-3) return (n * 1e3).toFixed(2) + "m";
  if (abs >= 1e-6) return (n * 1e6).toFixed(2) + "u";
  if (abs >= 1e-9) return (n * 1e9).toFixed(2) + "n";
  if (abs >= 1e-12) return (n * 1e12).toFixed(2) + "p";
  return n.toExponential(2);
}

function fallbackCopy(text: string): void {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.left = "-9999px";
  ta.style.top = "-9999px";
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand("copy");
  } catch { /* silent */ }
  document.body.removeChild(ta);
}

// ── Component ────────────────────────────────────────────────

const ENGINE_OPTIONS: { value: LvsEngine; label: string }[] = [
  { value: "vyges-lvs", label: "vyges-lvs (name-independent)" },
  { value: "name-based", label: "name-based" },
];

const ENGINE_LABELS: Record<string, string> = {
  "vyges-lvs": "vyges-lvs",
  "name-based": "name-based",
};

export default function LVSComparePanel({ dieId, layoutNetlist, dialect, moduleName, deviceToHighlight }: Props) {
  const [schematicNetlist, setSchematicNetlist] = useState("");
  const [layoutNetlistOverride, setLayoutNetlistOverride] = useState<string | null>(null);
  const [layoutLocked, setLayoutLocked] = useState(true);
  const [state, setState] = useState<PanelPhase>({ phase: "idle" });
  const [engine, setEngine] = useState<LvsEngine>("vyges-lvs");
  const [highlightedLine, setHighlightedLine] = useState<number | null>(null);
  const [highlightedSchematicLine, setHighlightedSchematicLine] = useState<number | null>(null);
  const reportRef = useRef<HTMLDivElement>(null);
  const layoutScrollRef = useRef<HTMLDivElement>(null);

  const displayLayout = layoutNetlistOverride ?? layoutNetlist;

  const handleCompare = useCallback(async () => {
    if (!schematicNetlist.trim() || !displayLayout) return;
    setState({ phase: "loading" });
    try {
      const res = await compareNetlists(dieId, {
        layoutNetlist: displayLayout, schematicNetlist, dialect, moduleName, engine,
      });
      if (res.ok && "json" in res.data) {
        const data = res.data as LvsCombinedResult;

        const snapshotJson = data.json;
        // For vyges-lvs: raw unbalanced classes only (no name-matching)
        // For name-based: use buildDiffs which correctly uses device names
        const snapshotDevices = engine === "name-based"
          ? buildDiffs(displayLayout, schematicNetlist, snapshotJson)
          : [];

        // Debug: log property_diffs count
        if (snapshotJson.property_diffs && snapshotJson.property_diffs.length > 0) {
          console.log(`[LVS] property_diffs (${snapshotJson.property_diffs.length}):`,
            snapshotJson.property_diffs.map(d => `${d.a_device} ${d.param} ${d.a_value}→${d.b_value}`).join(", "));
        }

        setState({ phase: "done", data: { engine: engine, matched: data.matched, json: snapshotJson, report: data.report, devices: snapshotDevices } });

        saveLvsSnapshot({ layoutNetlist: displayLayout, schematicNetlist, matched: data.matched, json: snapshotJson, report: data.report, devices: snapshotDevices });
      } else if (res.ok) {
        setState({ phase: "error", error: "Unexpected response format" });
      } else {
        setState({ phase: "error", error: res.error, detail: (res as any).detail });
      }
    } catch (err: unknown) {
      setState({ phase: "error", error: err instanceof Error ? err.message : "Network error" });
    }
  }, [schematicNetlist, displayLayout, dieId, dialect, moduleName, engine]);

  useEffect(() => {
    if (state.phase === "done" && reportRef.current) {
      reportRef.current.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [state.phase]);

  // Scroll and highlight device when selected from parent
  useEffect(() => {
    if (!deviceToHighlight || !layoutLocked) return;

    const searchName = deviceToHighlight.toLowerCase();
    const findLine = (text: string | null): number => {
      if (!text) return -1;
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const first = lines[i].trim().split(/\s+/)[0];
        if (first && first.toLowerCase() === searchName) return i;
      }
      return -1;
    };

    const layoutLine = findLine(displayLayout);
    setHighlightedLine(layoutLine);

    // Name-based: also highlight schematic
    if (engine === "name-based") {
      setHighlightedSchematicLine(findLine(schematicNetlist));
    }

    const centerScroll = (el: HTMLElement, line: number, totalLines: number) => {
      const lineHeight = el.scrollHeight / totalLines;
      el.scrollTop = Math.max(0, line * lineHeight - el.clientHeight / 2 + lineHeight / 2);
    };

    requestAnimationFrame(() => {
      if (layoutLine >= 0 && layoutScrollRef.current && displayLayout) {
        centerScroll(layoutScrollRef.current, layoutLine, displayLayout.split("\n").length);
      }
    });
  }, [deviceToHighlight, engine, layoutLocked, displayLayout]);

  const canCompare = schematicNetlist.trim().length > 0 && !!displayLayout && state.phase !== "loading";

  const sbStyles: React.CSSProperties = state.phase === "done" ? {
    borderTop: "1px solid var(--l2)", display: "flex", flexDirection: "column", flex: "1 1 auto", minHeight: 0,
  } : {
    overflow: "auto", flex: "1 1 auto",
  };

  // ── Render sections ────────────────────────────────────────

  const renderEngineSelector = () => (
    <div style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10 }}>
      <span style={{ color: "var(--ink3)" }}>Engine:</span>
      {ENGINE_OPTIONS.map((opt) => (
        <label key={opt.value} style={{
          display: "inline-flex", alignItems: "center", gap: 2, cursor: "pointer",
          padding: "2px 6px", borderRadius: 3,
          background: engine === opt.value ? "var(--accent)" : "var(--l1)",
          color: engine === opt.value ? "var(--accentFg, #fff)" : "var(--ink2)",
          fontWeight: engine === opt.value ? 600 : 400,
        }}>
          <input type="radio" name="lvs-engine" value={opt.value}
            checked={engine === opt.value}
            onChange={() => { setEngine(opt.value); if (state.phase !== "idle") setState({ phase: "idle" }); }}
            style={{ display: "none" }} />
          {opt.label}
        </label>
      ))}
    </div>
  );

  const renderVerdictBadge = (matched: boolean, label?: string) => (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 4,
      fontSize: 12, fontWeight: 700, padding: "3px 10px", borderRadius: 4,
      background: matched ? "var(--okBg)" : "var(--errBg)",
      color: matched ? "var(--okFg, #4f4)" : "var(--errFg, #f44)",
    }}>
      {label ? `${label}: ` : ""}{matched ? "MATCH" : "MISMATCH"}
    </span>
  );

  const renderSummary = () => {
    const done = state.phase === "done";
    const data = done ? state.data : null;

    // Device count warning: vyges-lvs may collapse parallel/series resistors
    const devCountWarning = data && data.engine === "vyges-lvs"
      ? data.report.includes("vyges-lvs sees") && data.report.match(/vyges-lvs sees (\d+) devices/)
      : null;
    const showDevCountWarning = devCountWarning && data
      && data.json.a_devices < Math.max(data.json.a_devices, data.json.b_devices) + 1;

    return (
      <div style={{
        display: "flex", alignItems: "center", gap: 12,
        padding: "6px 10px", flexWrap: "wrap", borderBottom: "1px solid var(--l2)",
        background: "var(--card)",
      }}>
        {/* Engine selector */}
        {renderEngineSelector()}

        {/* Verdict badge */}
        {data && renderVerdictBadge(data.matched)}

        {/* Device count warning (vyges-lvs) */}
        {data && data.engine === "vyges-lvs" && (() => {
          const rawDev = displayLayout?.split("\n")
            .filter(l => /^\s*[A-Za-z_]/.test(l) && !/^\s*\./.test(l))
            .length ?? 0;
          if (data.json.a_devices < rawDev) {
            return (
              <div style={{ fontSize: 9, color: "#fd0", lineHeight: 1.4, width: "100%" }}>
                ⚠ vyges-lvs sees {data.json.a_devices} devices (raw netlist has {rawDev}). Resistors sharing nets may be collapsed — connection mismatches between active devices (BJTs, diodes) may be hidden. Use <strong>name-based</strong> engine for detailed verification.
              </div>
            );
          }
          return null;
        })()}

        {/* Stats — only when done */}
        {data && (() => {
          const { json, devices, engine: eng } = data;
          const totalDev = Math.max(json.a_devices, json.b_devices);
          const netD = Math.abs(json.a_nets - json.b_nets);
          if (eng === "vyges-lvs") {
            const devClasses = json.unbalanced.filter(c => c.what === "device").length;
            return (
              <span style={{ fontSize: 10, color: "var(--ink)", display: "flex", gap: 12, fontWeight: 500, flexWrap: "wrap" }}>
                <span>Devices: <b>{json.a_devices}</b> / <b>{json.b_devices}</b> L/S</span>
                {devClasses > 0 && <span style={{ color: "#fd0" }}>{devClasses} unbalanced classes</span>}
                <span style={{ color: "var(--ink3)" }}>Nets {json.a_nets}/{json.b_nets}{netD > 0 ? ` (Δ${netD})` : ""} | {json.iterations} iters</span>
              </span>
            );
          }
          const devDiffs = devices.length;
          const lOnly = devices.filter(d => d.category === "l-only").length;
          const sOnly = devices.filter(d => d.category === "s-only").length;
          const typeM = devices.filter(d => d.category === "type-mismatch").length;
          const paramC = devices.filter(d => d.category === "mismatch" && !terminalsDiffer(d.layoutLine, d.schematicLine)).length;
          const connM = devices.filter(d => d.category === "mismatch" && terminalsDiffer(d.layoutLine, d.schematicLine)).length;
          return (
            <span style={{ fontSize: 10, color: "var(--ink)", display: "flex", gap: 12, fontWeight: 500, flexWrap: "wrap" }}>
              <span>Devices: <b>{totalDev}</b> — <span style={{ color: devDiffs ? "#fd0" : "var(--okFg, #4f4)" }}>{devDiffs} diff{devDiffs !== 1 ? "s" : ""}</span></span>
              {devDiffs > 0 && <span style={{ color: "var(--ink3)" }}>
                L-only:{lOnly} S-only:{sOnly} Type:{typeM} Param:{paramC} Conn:{connM}
              </span>}
              <span style={{ color: "var(--ink3)" }}>Nets {json.a_nets}/{json.b_nets}{netD > 0 ? ` (Δ${netD})` : ""} | {json.iterations} iters</span>
            </span>
          );
        })()}

        {/* Compare button — always visible */}
        <button type="button" disabled={!canCompare} onClick={handleCompare} style={{
          fontSize: 10, fontWeight: 600, padding: "4px 14px", borderRadius: 4,
          cursor: canCompare ? "pointer" : "default", border: "none",
          background: canCompare ? "var(--accent)" : "var(--l1)",
          color: canCompare ? "var(--accentFg, #fff)" : "var(--ink3)",
          opacity: canCompare ? 1 : 0.5,
        }}>
          {state.phase === "loading" ? `Running ${ENGINE_LABELS[engine] ?? engine}...` : "Compare"}
        </button>

        {/* Copy Report button — only when done */}
        {data && (
          <button type="button" onClick={() => {
            const result = state as { phase: "done"; data: LvsResultData };
            const text = generateReportText(result.data, result.data.devices);
            fallbackCopy(text);
          }} style={{
            fontSize: 10, fontWeight: 600, padding: "4px 10px", borderRadius: 4,
            cursor: "pointer", border: "1px solid var(--l2)",
            background: "transparent", color: "var(--ink2)",
          }}>
            Copy Report
          </button>
        )}
      </div>
    );
  };

  const renderSideBySide = () => {
    const layoutDialect = displayLayout ? detectDialect(displayLayout) : null;
    const schematicDialect = schematicNetlist ? detectDialect(schematicNetlist) : null;
    const dialectMismatch = layoutDialect && schematicDialect && layoutDialect !== "unknown" && schematicDialect !== "unknown" && layoutDialect !== schematicDialect;

    const dialectBadge = (dialect: SpiceDialect | "unknown" | null) => {
      if (!dialect || dialect === "unknown") return null;
      const color = dialect === "spectre" ? "#48f" : dialect === "cdl" ? "#f80" : "#aaa";
      return (
        <span style={{
          fontSize: 8, fontWeight: 700, padding: "1px 5px", borderRadius: 3,
          background: color, color: "#fff", marginLeft: 6, letterSpacing: 0.5,
        }}>
          {dialect.toUpperCase()}
        </span>
      );
    };

    return (
      <div style={{
        display: "flex", gap: 8, padding: "6px 10px", flex: "0 0 40%", minHeight: 0,
        borderBottom: "1px solid var(--l2)", position: "relative",
      }}>
        {dialectMismatch && (
          <div style={{
            position: "absolute", top: 33, left: "50%", transform: "translateX(-50%)",
            zIndex: 2, fontSize: 9, fontWeight: 600, color: "#fd0",
            background: "var(--card)", padding: "2px 8px", borderRadius: 3,
            border: "1px solid #fd0", whiteSpace: "nowrap",
          }}>
            ⚠ Dialect mismatch: {layoutDialect} vs {schematicDialect}
          </div>
        )}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
          <div style={{ fontSize: 9, fontWeight: 600, color: "var(--ink2)", marginBottom: 2, display: "flex", alignItems: "center", gap: 4 }}>
            Layout Netlist ({displayLayout?.split("\n").length ?? 0} lines)
            {dialectBadge(layoutDialect)}
            <span
              onClick={() => {
                if (layoutLocked) {
                  setLayoutNetlistOverride(displayLayout);
                  setLayoutLocked(false);
                } else {
                  setLayoutNetlistOverride(null);
                  setLayoutLocked(true);
                }
              }}
              style={{
                cursor: "pointer", fontSize: 10, opacity: 0.6, marginLeft: "auto",
                userSelect: "none", padding: "1px 4px", borderRadius: 2,
                background: layoutLocked ? "transparent" : "var(--l1)",
              }}
              title={layoutLocked ? "Unlock to edit (debug)" : "Lock (revert to original)"}
            >
              {layoutLocked ? "🔒" : "🔓"}
            </span>
          </div>
          {!layoutLocked && (
            <div style={{ fontSize: 9, color: "#fd0", marginBottom: 4, lineHeight: 1.4, display: "flex", alignItems: "center", gap: 4 }}>
              ⚠ Layout was modified — debug use only
            </div>
          )}
          {layoutLocked ? (
            <div ref={layoutScrollRef} style={{
              ...textareaBase, flex: 1, overflow: "auto", cursor: "default", padding: "4px 0",
              whiteSpace: "pre-wrap", wordBreak: "break-all",
              maxWidth: "100%", boxSizing: "border-box",
            }}>
              {(displayLayout ?? "").split("\n").map((line, i) => (
                <div key={i} style={{
                  padding: "0 6px",
                  background: highlightedLine === i ? "var(--accentBg)" : "transparent",
                  borderLeft: highlightedLine === i ? "3px solid var(--accent)" : "3px solid transparent",
                }}>
                  {line || " "}
                </div>
              ))}
            </div>
          ) : (
            <textarea
              readOnly={false}
              value={displayLayout ?? ""}
              onChange={(e) => {
                setLayoutNetlistOverride(e.target.value);
                if (state.phase !== "idle") setState({ phase: "idle" });
              }}
              style={{
                ...textareaBase, flex: 1, resize: "none",
                cursor: "text", border: "1px solid #fd0",
              }}
              spellCheck={false}
            />
          )}
        </div>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
          <div style={{ fontSize: 9, fontWeight: 600, color: "var(--ink2)", marginBottom: 2, display: "flex", alignItems: "center", gap: 4 }}>
            Schematic Netlist
            {dialectBadge(schematicDialect)}
          </div>
          {engine === "name-based" && deviceToHighlight ? (
            <div style={{
              ...textareaBase, flex: 1, overflow: "auto", cursor: "default", padding: "4px 0",
              whiteSpace: "pre-wrap", wordBreak: "break-all",
              maxWidth: "100%", boxSizing: "border-box",
            }}>
              {schematicNetlist.split("\n").map((line, i) => (
                <div key={i} style={{
                  padding: "0 6px",
                  background: highlightedSchematicLine === i ? "var(--accentBg)" : "transparent",
                  borderLeft: highlightedSchematicLine === i ? "3px solid var(--accent)" : "3px solid transparent",
                }}>
                  {line || " "}
                </div>
              ))}
            </div>
          ) : (
            <textarea
              placeholder="Ctrl+V reference SPICE netlist..."
              value={schematicNetlist}
              onChange={(e) => { setSchematicNetlist(e.target.value); if (state.phase !== "idle") setState({ phase: "idle" }); }}
              style={{ ...textareaBase, flex: 1, resize: "none" }}
              spellCheck={false}
            />
          )}
        </div>
      </div>
    );
  };

  const renderJsonNote = () => {
    if (state.phase !== "done") return null;
    const note = state.data.json.note;
    if (!note) return null;
    return (
      <div style={{ margin: "0 10px 8px", fontSize: 10, color: "#fd0", lineHeight: 1.5, whiteSpace: "pre-wrap" }}>
        ⓘ {note}
      </div>
    );
  };

  const renderPropertyTable = () => {
    if (state.phase !== "done") return null;
    const curEngine = state.data.engine;
    const pd = state.data.json.property_diffs;
    if (!pd || !pd.length) return null;
    const engLabel = ` (${ENGINE_LABELS[curEngine] ?? curEngine})`;
    return (
      <div style={{ margin: "0 10px 8px" }}>
        <div style={sectionTitle}>Property Diffs{engLabel} ({pd.length})</div>
        <table style={tableSm}>
          <thead>
            <tr style={{ color: "var(--ink3)", textAlign: "left" }}>
              <th style={{ padding: "2px 6px" }}>Kind</th>
              <th style={{ padding: "2px 6px" }}>Param</th>
              <th style={{ padding: "2px 6px" }}>Layout</th>
              <th style={{ padding: "2px 6px", textAlign: "right" }}>L Val</th>
              <th style={{ padding: "2px 6px" }}>Schematic</th>
              <th style={{ padding: "2px 6px", textAlign: "right" }}>S Val</th>
              <th style={{ padding: "2px 6px", textAlign: "right" }}>Δ</th>
            </tr>
          </thead>
          <tbody>
            {pd.map((d, i) => {
              const delta = d.a_value !== 0
                ? ((d.b_value - d.a_value) / d.a_value * 100).toFixed(1)
                : "∞";
              const isChange = Math.abs(delta !== "∞" ? parseFloat(delta) : 0) > 1;
              return (
                <tr key={i} style={{ ...panelBase, marginTop: i > 0 ? 1 : 0 }}>
                  <td style={{ padding: "2px 6px", color: "var(--ink)" }}>{d.kind}</td>
                  <td style={{ padding: "2px 6px", fontWeight: 600 }}>{d.param}</td>
                  <td style={{ padding: "2px 6px", color: "var(--ink2)" }}>{stripSide(d.a_device)}{parseCollapsedCount(d.a_device).count ? ` (×${parseCollapsedCount(d.a_device).count})` : ""}</td>
                  <td style={{ padding: "2px 6px", textAlign: "right", color: isChange ? "#f55" : "var(--ink2)", fontFamily: "var(--mono)" }}>{fmtVal(d.a_value)}</td>
                  <td style={{ padding: "2px 6px", color: "var(--ink2)" }}>{stripSide(d.b_device)}{parseCollapsedCount(d.b_device).count ? ` (×${parseCollapsedCount(d.b_device).count})` : ""}</td>
                  <td style={{ padding: "2px 6px", textAlign: "right", color: isChange ? "#48f" : "var(--ink2)", fontFamily: "var(--mono)" }}>{fmtVal(d.b_value)}</td>
                  <td style={{
                    padding: "2px 6px", textAlign: "right", fontFamily: "var(--mono)",
                    color: isChange ? "var(--ink)" : "var(--ink3)",
                  }}>
                    {delta}%
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  };

  const renderCombinedDevices = () => {
    if (state.phase !== "done" || state.data.json.unbalanced.length === 0) return null;

    // Collect all devices with collapsed info from unbalanced
    const combined: { name: string; side: "L" | "S"; collapsedCount: number; what: string }[] = [];
    for (const cls of state.data.json.unbalanced) {
      for (const n of cls.a) {
        const { clean, count } = parseCollapsedCount(n);
        if (count !== null) combined.push({ name: clean, side: "L", collapsedCount: count, what: cls.what });
      }
      for (const n of cls.b) {
        const { clean, count } = parseCollapsedCount(n);
        if (count !== null) combined.push({ name: clean, side: "S", collapsedCount: count, what: cls.what });
      }
    }
    if (combined.length === 0) return null;

    return (
      <div style={{ margin: "0 10px 8px" }}>
        <div style={sectionTitle}>Combined Devices</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
          {combined.map((c, i) => (
            <div key={i} style={{ ...panelBase, display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{
                fontSize: 9, fontWeight: 700, padding: "1px 4px", borderRadius: 2,
                background: c.side === "L" ? "var(--errBg)" : "var(--accentBg)",
                color: c.side === "L" ? "#f55" : "#48f",
              }}>{c.side}</span>
              <span style={{ fontWeight: 600, color: "var(--ink0)" }}>{c.name}</span>
              <span style={{ fontSize: 9, color: "var(--ink3)" }}>
                {c.what === "device" ? `×${c.collapsedCount}` : `net(×${c.collapsedCount})`}
              </span>
            </div>
          ))}
        </div>
        <div style={{ fontSize: 9, color: "var(--ink3)", marginTop: 4, lineHeight: 1.4 }}>
          vyges-lvs collapsed these devices/nets (parallel/series combination).
          Device-level diffs use the individual names; combined info is shown for reference.
        </div>
      </div>
    );
  };

  // (net-level diffs removed — noise for renamed nets)

  const renderPortChips = () => {
    if (state.phase !== "done") return null;
    const curEngine = state.data.engine;
    // Only vyges-lvs reports port diffs; name-based has no port concept
    if (curEngine === "name-based") return null;
    const { only_in_a_ports, only_in_b_ports } = state.data.json;
    if (!only_in_a_ports.length && !only_in_b_ports.length) return null;

    return (
      <div style={{ margin: "0 10px 8px" }}>
        <div style={sectionTitle}>Port Diffs</div>
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          {only_in_a_ports.map((p) => (
            <span key={p} style={{
              fontSize: 9, fontFamily: "var(--mono)", padding: "1px 6px", borderRadius: 3,
              background: "var(--errBg)", color: "#f55",
            }}>
              L-only: {p}
            </span>
          ))}
          {only_in_b_ports.map((p) => (
            <span key={p} style={{
              fontSize: 9, fontFamily: "var(--mono)", padding: "1px 6px", borderRadius: 3,
              background: "var(--accentBg)", color: "#48f",
            }}>
              S-only: {p}
            </span>
          ))}
        </div>
      </div>
    );
  };

  const renderDeviceDiffs = () => {
    if (state.phase !== "done") return null;
    const { devices } = state.data;
    if (!devices.length) return null;

    const lOnly = devices.filter((d) => d.category === "l-only");
    const sOnly = devices.filter((d) => d.category === "s-only");
    const typeMism = devices.filter((d) => d.category === "type-mismatch");
    const mismatches = devices.filter((d) => d.category === "mismatch");
    const paramOnly = mismatches.filter(d => !terminalsDiffer(d.layoutLine, d.schematicLine));
    const connMism = mismatches.filter(d => terminalsDiffer(d.layoutLine, d.schematicLine));

    const catBlock = (title: string, items: DeviceDiff[], color: string, sub?: string) => {
      if (!items.length) return null;
      return (
        <div style={{ marginBottom: 8 }}>
          <div style={{ ...sectionTitle, color }}>{title} ({items.length}){sub && <span style={{ color: "var(--ink3)", fontWeight: 400 }}> — {sub}</span>}</div>
          {items.map((d, i) => (
            <div key={i} style={{ ...panelBase, borderLeft: `3px solid ${color}` }}>
              <div style={{ fontWeight: 600, color: "var(--ink0)", display: "flex", alignItems: "center", gap: 4 }}>
                {d.name}
                {d.collapsedLayout && <span style={{ fontSize: 8, fontWeight: 700, padding: "1px 4px", borderRadius: 2, background: "#f55", color: "#fff" }}>L×{d.collapsedLayout}</span>}
                {d.collapsedSchematic && <span style={{ fontSize: 8, fontWeight: 700, padding: "1px 4px", borderRadius: 2, background: "#48f", color: "#fff" }}>S×{d.collapsedSchematic}</span>}
              </div>
              <table style={{ width: "100%", fontSize: 11, borderCollapse: "collapse", marginTop: 2 }}>
                <tbody>
                  <tr><td style={{ color: "#f55", paddingRight: 8, verticalAlign: "top", whiteSpace: "nowrap", width: 16 }}>L</td>
                    <td style={{ color: "var(--ink2)", wordBreak: "break-all" }}>{d.layoutLine || "—"}</td></tr>
                  <tr><td style={{ color: "#48f", paddingRight: 8, verticalAlign: "top", whiteSpace: "nowrap", width: 16 }}>S</td>
                    <td style={{ color: "var(--ink2)", wordBreak: "break-all" }}>{d.schematicLine || "—"}</td></tr>
                </tbody>
              </table>
            </div>
          ))}
        </div>
      );
    };

    const curEngine = state.data.engine;
    const engLabel = ` (${ENGINE_LABELS[curEngine] ?? curEngine})`;
    // Cascade warning only for vyges-lvs — name-based engine matches by name, no cascade issue
    const hasCascadeNoise = curEngine !== "name-based" && lOnly.length > 0 && sOnly.length > 0;
    // High iterations warning: 1-WL may struggle on complex graphs
    const highIters = curEngine !== "name-based" && state.data.json.iterations > 4;
    return (
      <div style={{ flex: "0 0 auto", margin: "0 10px 8px" }}>
        <div style={{ ...sectionTitle, fontSize: 12 }}>Device Diffs{engLabel} ({devices.length})</div>
        {hasCascadeNoise && (
          <div style={{ fontSize: 9, color: "#fd0", marginBottom: 6, lineHeight: 1.4 }}>
            ⚠ For circuits with renamed devices/nets, some diffs below may be cascade noise from the 1-WL algorithm, not real errors. Compare with the report for details.
          </div>
        )}
        {highIters && (
          <div style={{ fontSize: 9, color: "#fd0", marginBottom: 6, lineHeight: 1.4 }}>
            ⚠ {state.data.json.iterations} refinement iterations (high) — 1-WL may struggle on this graph. Cross-check with name-based engine.
          </div>
        )}
        {catBlock("Only in Layout", lOnly, "#f55")}
        {catBlock("Only in Schematic", sOnly, "#48f")}
        {catBlock("Device Type Mismatch", typeMism, "#f0f", "different model type (e.g. npn vs pnp)")}
        {catBlock("Param Changed", paramOnly, "#fd0", "same topology, different W/L/R/m")}
        {catBlock("Connection Mismatch", connMism, "#f80", "different terminal connections")}
      </div>
    );
  };

  /** Render vyges-lvs unbalanced classes directly (no name-matching) */
  const renderUnbalancedVyges = () => {
    if (state.phase !== "done" || state.data.engine !== "vyges-lvs") return null;
    const unbalanced = state.data.json.unbalanced.filter(c => c.what === "device");
    if (!unbalanced.length) return null;

    const lOnly = unbalanced.filter(c => c.a_count > 0 && c.b_count === 0);
    const sOnly = unbalanced.filter(c => c.a_count === 0 && c.b_count > 0);
    const sameCount = unbalanced.filter(c => c.a_count > 0 && c.b_count > 0 && c.a_count === c.b_count);
    const diffCount = unbalanced.filter(c => c.a_count > 0 && c.b_count > 0 && c.a_count !== c.b_count);

    const renderClass = (title: string, classes: typeof unbalanced, color: string) => {
      if (!classes.length) return null;
      return (
        <div style={{ marginBottom: 8 }}>
          <div style={{ ...sectionTitle, color }}>{title} ({classes.length})</div>
          {classes.map((c, i) => (
            <div key={i} style={{ ...panelBase, borderLeft: `3px solid ${color}`, marginTop: i > 0 ? 1 : 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10, fontWeight: 600, color: "var(--ink3)", marginBottom: 2 }}>
                L {c.a_count} : S {c.b_count}
                {c.a_count !== c.b_count && <span style={{ fontSize: 9, fontWeight: 700, color, padding: "0 4px", borderRadius: 2, background: color + "22" }}>Δ{c.a_count - c.b_count}</span>}
              </div>
              <table style={{ width: "100%", fontSize: 11, borderCollapse: "collapse" }}>
                <tbody>
                  <tr>
                    <td style={{ color: "#f55", paddingRight: 8, verticalAlign: "top", whiteSpace: "nowrap", width: 16, fontSize: 10 }}>L</td>
                    <td style={{ color: "var(--ink2)", wordBreak: "break-all", fontFamily: "var(--mono)", fontSize: 10 }}>
                      {c.a.map(n => stripSide(n)).join(", ") || "—"}
                    </td>
                  </tr>
                  <tr>
                    <td style={{ color: "#48f", paddingRight: 8, verticalAlign: "top", whiteSpace: "nowrap", width: 16, fontSize: 10 }}>S</td>
                    <td style={{ color: "var(--ink2)", wordBreak: "break-all", fontFamily: "var(--mono)", fontSize: 10 }}>
                      {c.b.map(n => stripSide(n)).join(", ") || "—"}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          ))}
        </div>
      );
    };

    const highIters = state.data.json.iterations > 4;
    return (
      <div style={{ flex: "0 0 auto", margin: "0 10px 8px" }}>
        <div style={{ ...sectionTitle, fontSize: 12 }}>Unbalanced Devices ({unbalanced.length} classes, L {state.data.json.a_devices} : S {state.data.json.b_devices})</div>
        {highIters && (
          <div style={{ fontSize: 9, color: "#fd0", marginBottom: 6, lineHeight: 1.4 }}>
            ⚠ {state.data.json.iterations} refinement iterations (high) — 1-WL may struggle on this graph.
          </div>
        )}
        <div style={{ fontSize: 9, color: "var(--ink3)", marginBottom: 6, lineHeight: 1.4 }}>
          vyges-lvs is name-independent — unbalanced classes are color groups, not device-by-device matches.
          Devices that share the same connection signature end up in the same class.
          L-only / S-only mean no counterpart existed with matching connectivity.
        </div>
        {renderClass("Only in Layout", lOnly, "#f55")}
        {renderClass("Only in Schematic", sOnly, "#48f")}
        {renderClass("Mismatch (same count)", sameCount, "#f80")}
        {renderClass("Count Mismatch", diffCount, "#fd0")}
      </div>
    );
  };

  const renderReportInline = () => {
    if (state.phase !== "done" || !state.data.report) return null;
    const engName = ENGINE_LABELS[state.data.engine] ?? state.data.engine;

    return (
      <div style={{ margin: "0 0 8px", display: "flex", flexDirection: "column", flex: "1 1 auto", minHeight: 0 }}>
        <div style={sectionTitle}>{engName} report</div>
        <textarea
          readOnly
          value={state.data.report}
          style={{ ...textareaBase, flex: 1, cursor: "default", whiteSpace: "pre", fontFamily: "var(--mono)", fontSize: 11 }}
          spellCheck={false}
        />
      </div>
    );
  };

  // ── Render ────────────────────────────────────────────────

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--card)" }}>
      {renderSummary()}
      {renderSideBySide()}

      <div ref={reportRef} style={sbStyles}>
        {state.phase === "loading" && (
          <div className="m" style={{ padding: 20, fontSize: 11, color: "var(--ink3)", textAlign: "center" }}>
            running {ENGINE_LABELS[engine] ?? engine}...
          </div>
        )}

        {state.phase === "done" && (
          <>
            <div style={{ display: "flex", gap: 10, flex: "1 1 auto", minHeight: 0, overflow: "hidden", padding: "6px 10px 0" }}>
              <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "auto", minWidth: 0 }}>
                {renderJsonNote()}
                {renderPortChips()}
                {renderPropertyTable()}
                {renderReportInline()}
              </div>
              <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "auto", minWidth: 0 }}>
                {engine === "vyges-lvs" ? (
                  <>{renderUnbalancedVyges()}</>
                ) : (
                  <>{renderDeviceDiffs()}</>
                )}
              </div>
            </div>
          </>
        )}

        {state.phase === "error" && (
          <div style={{ padding: 16 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: "var(--err)", display: "flex", alignItems: "center", gap: 6 }}>
              {Ic.warn} {state.error}
            </div>
            {state.detail && (
              <div style={{ fontSize: 10, color: "var(--ink2)", marginTop: 6, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>
                {state.detail}
              </div>
            )}
          </div>
        )}

        {state.phase === "idle" && (
          <div className="m" style={{ padding: 20, fontSize: 11, color: "var(--ink3)", textAlign: "center" }}>
            Paste a reference netlist above and press Compare.
          </div>
        )}
      </div>
    </div>
  );
}
