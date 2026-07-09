import { useCallback, useState, useRef, useEffect } from "react";
import type { SpiceDialect, LvsRawResult } from "shared";
import { compareNetlists, saveLvsSnapshot } from "../../api/lvs";
import { Ic } from "../../icons";

// ── Styles ────────────────────────────────────────────────────

const textareaBase: React.CSSProperties = {
  width: "100%", fontFamily: "var(--mono)", fontSize: 10, lineHeight: 1.4,
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
}

interface LvsResultData {
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
}

// ── Report text generator ───────────────────────────────────

function generateReportText(data: LvsResultData, devices: DeviceDiff[]): string {
  const { json, matched, report } = data;
  const lines: string[] = [];

  lines.push(`LVS Report`);
  lines.push(`Status: ${matched ? "MATCH" : "MISMATCH"}`);
  const unbalancedD = countByWhat(json, "device");
  const unbalancedN = countByWhat(json, "net");
  const dr = matchRate(json.a_devices, json.b_devices, unbalancedD.a, unbalancedD.b);
  const nr = matchRate(json.a_nets, json.b_nets, unbalancedN.a, unbalancedN.b);
  lines.push(`Devices: ${dr.matched}/${dr.total} (${pct(dr.rate)})  Nets: ${nr.matched}/${nr.total} (${pct(nr.rate)})`);
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

function stripSide(name: string): string {
  return name.replace(/^[AB]\//, "").replace(/\(\+\d+\)$/, "").replace(/\(×\d+\)$/, "");
}

// ── Direct netlist parsing (cascade-free) ────────────────────

/** Extract net → connection count from a netlist, skipping 0 (ground). */
function extractNetCounts(netlist: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const raw of netlist.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("*") || line.startsWith(".") || line.startsWith("//")) continue;
    const parenStart = line.indexOf("(");
    const parenEnd = line.lastIndexOf(")");
    if (parenStart === -1 || parenEnd === -1) continue;
    const nets = line.slice(parenStart + 1, parenEnd).split(/\s+/);
    for (const n of nets) {
      if (!n || n === "0") continue;
      counts.set(n, (counts.get(n) ?? 0) + 1);
    }
  }
  return counts;
}

interface NetDiffEntry {
  name: string;
  layoutCount: number;
  schematicCount: number;
}

/** Compare nets between two netlists by connection count — cascade-free. */
function computeNetDiffs(layoutNetlist: string, schematicNetlist: string): NetDiffEntry[] {
  const lNets = extractNetCounts(layoutNetlist);
  const sNets = extractNetCounts(schematicNetlist);
  const all = new Set([...lNets.keys(), ...sNets.keys()]);
  const diffs: NetDiffEntry[] = [];
  for (const name of all) {
    const lc = lNets.get(name) ?? 0;
    const sc = sNets.get(name) ?? 0;
    if (lc !== sc) diffs.push({ name, layoutCount: lc, schematicCount: sc });
  }
  diffs.sort((a, b) => Math.abs(b.layoutCount - b.schematicCount) - Math.abs(a.layoutCount - a.schematicCount));
  return diffs;
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

function parseModelType(line: string): string {
  const e = line.lastIndexOf(")");
  if (e === -1) return "";
  return line.slice(e + 1).trim().split(/\s+/)[0] || "";
}

function buildDiffs(layoutNetlist: string, schematicNetlist: string, json: LvsRawResult): DeviceDiff[] {
  const layoutMap = buildDeviceMap(layoutNetlist);
  const schematicMap = buildDeviceMap(schematicNetlist);
  const diffs: DeviceDiff[] = [];
  const seen = new Set<string>();

  // Phase 1: collect all device names vyges-lvs marked as unbalanced
  const unbalancedNames = new Set<string>();
  for (const cls of json.unbalanced) {
    if (cls.what !== "device") continue;
    for (const n of cls.a) unbalancedNames.add(stripSide(n).toLowerCase());
    for (const n of cls.b) unbalancedNames.add(stripSide(n).toLowerCase());
  }

  // Phase 2: for each unbalanced name, check if it really differs
  for (const name of unbalancedNames) {
    const lLine = layoutMap.get(name);
    const sLine = schematicMap.get(name);
    if (lLine === undefined && sLine === undefined) continue;

    if (lLine !== undefined && sLine !== undefined) {
      if (lLine === sLine) continue; // cascade artifact
      const cat = parseModelType(lLine) !== parseModelType(sLine) ? "type-mismatch" : "mismatch";
      diffs.push({ name, category: cat, layoutLine: lLine, schematicLine: sLine });
    } else if (lLine !== undefined) {
      diffs.push({ name, category: "l-only", layoutLine: lLine, schematicLine: "" });
    } else {
      diffs.push({ name, category: "s-only", layoutLine: "", schematicLine: sLine });
    }
    seen.add(name);
  }

  // Phase 3: catch type mismatches vyges-lvs matched (e.g. npn vs pnp with same connectivity)
  for (const [name, lLine] of layoutMap) {
    if (seen.has(name)) continue;
    const sLine = schematicMap.get(name);
    if (sLine === undefined) continue;
    if (lLine === sLine) continue;
    const lType = parseModelType(lLine);
    const sType = parseModelType(sLine);
    if (lType && sType && lType !== sType) {
      diffs.push({ name, category: "type-mismatch", layoutLine: lLine, schematicLine: sLine });
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

function unbalancedNets(json: LvsRawResult) {
  return json.unbalanced.filter((c) => c.what === "net");
}

function countByWhat(json: LvsRawResult, what: string): { a: number; b: number } {
  let a = 0, b = 0;
  for (const c of json.unbalanced) {
    if (c.what !== what) continue;
    a += c.a_count;
    b += c.b_count;
  }
  return { a, b };
}

function matchRate(totalSideA: number, totalSideB: number, unbalancedA: number, unbalancedB: number): { matched: number; total: number; rate: number } {
  const maxTotal = Math.max(totalSideA, totalSideB);
  if (maxTotal === 0) return { matched: 0, total: 0, rate: 1 };
  const matched = maxTotal - Math.max(unbalancedA, unbalancedB);
  return { matched, total: maxTotal, rate: matched / maxTotal };
}

function rateColor(rate: number): string {
  if (rate >= 1) return "var(--okFg, #4f4)";
  if (rate >= 0.9) return "#fd0";
  return "#f44";
}

function pct(rate: number): string {
  return (rate * 100).toFixed(0) + "%";
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

export default function LVSComparePanel({ dieId, layoutNetlist, dialect, moduleName }: Props) {
  const [schematicNetlist, setSchematicNetlist] = useState("");
  const [state, setState] = useState<PanelPhase>({ phase: "idle" });
  const [showReport, setShowReport] = useState(false);
  const reportRef = useRef<HTMLDivElement>(null);

  const handleCompare = useCallback(async () => {
    if (!schematicNetlist.trim() || !layoutNetlist) return;
    setState({ phase: "loading" });
    try {
      const res = await compareNetlists(dieId, {
        layoutNetlist, schematicNetlist, dialect, moduleName,
      });
      if (res.ok && "json" in res.data) {
        const json = res.data.json;
        const devices = buildDiffs(layoutNetlist, schematicNetlist, json);
        setState({ phase: "done", data: { matched: res.data.matched, json, report: res.data.report, devices } });
        setShowReport(false);
        saveLvsSnapshot({ layoutNetlist, schematicNetlist, matched: res.data.matched, json, report: res.data.report, devices });
      } else if (res.ok) {
        setState({ phase: "error", error: "Unexpected response format" });
      } else {
        setState({ phase: "error", error: res.error, detail: (res as any).detail });
      }
    } catch (err: unknown) {
      setState({ phase: "error", error: err instanceof Error ? err.message : "Network error" });
    }
  }, [schematicNetlist, layoutNetlist, dieId, dialect, moduleName]);

  useEffect(() => {
    if (state.phase === "done" && reportRef.current) {
      reportRef.current.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [state.phase]);

  const canCompare = schematicNetlist.trim().length > 0 && !!layoutNetlist && state.phase !== "loading";

  const sbStyles: React.CSSProperties = state.phase === "done" ? {
    borderTop: "1px solid var(--l2)", display: "flex", flexDirection: "column", flex: "1 1 auto", minHeight: 0,
  } : {
    overflow: "auto", flex: "1 1 auto",
  };

  // ── Render sections ────────────────────────────────────────

  const renderSummary = () => {
    const done = state.phase === "done";
    const data = done ? state.data : null;

    return (
      <div style={{
        display: "flex", alignItems: "center", gap: 12,
        padding: "6px 10px", flexWrap: "wrap", borderBottom: "1px solid var(--l2)",
        background: "var(--card)",
      }}>
        {/* Verdict badge — only when done */}
        {data && (
          <span style={{
            display: "inline-flex", alignItems: "center", gap: 4,
            fontSize: 12, fontWeight: 700, padding: "3px 10px", borderRadius: 4,
            background: data.matched ? "var(--okBg)" : "var(--errBg)",
            color: data.matched ? "var(--okFg, #4f4)" : "var(--errFg, #f44)",
          }}>
            {data.matched ? "✓ MATCH" : "✗ MISMATCH"}
          </span>
        )}

        {/* Stats — only when done */}
        {data && (() => {
          const { json } = data;
          const unbalancedD = countByWhat(json, "device");
          const unbalancedN = countByWhat(json, "net");
          const devRate = matchRate(json.a_devices, json.b_devices, unbalancedD.a, unbalancedD.b);
          const netRate = matchRate(json.a_nets, json.b_nets, unbalancedN.a, unbalancedN.b);
          return (
            <span style={{ fontSize: 10, color: "var(--ink)", display: "flex", gap: 12, fontWeight: 500, flexWrap: "wrap" }}>
              <span>Devices: <b>{devRate.matched}/{devRate.total}</b> <span style={{ color: rateColor(devRate.rate) }}>({pct(devRate.rate)})</span></span>
              <span>Nets: <b>{netRate.matched}/{netRate.total}</b> <span style={{ color: rateColor(netRate.rate) }}>({pct(netRate.rate)})</span></span>
              {json.only_in_a_ports.length > 0 && <span style={{ color: "#f66" }}>Extra L ports: {json.only_in_a_ports.length}</span>}
              {json.only_in_b_ports.length > 0 && <span style={{ color: "#6af" }}>Extra S ports: {json.only_in_b_ports.length}</span>}
              {json.property_diffs.length > 0 && <span style={{ color: "#fd0" }}>Property diffs: {json.property_diffs.length}</span>}
              <span style={{ color: "var(--ink3)" }}>{json.iterations} iters</span>
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
          {state.phase === "loading" ? "Running vyges-lvs..." : "Compare"}
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

  const renderSideBySide = () => (
    <div style={{
      display: "flex", gap: 8, padding: "6px 10px", flex: "0 0 40%", minHeight: 0,
      borderBottom: "1px solid var(--l2)",
    }}>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        <div style={{ fontSize: 9, fontWeight: 600, color: "var(--ink2)", marginBottom: 2 }}>
          Layout Netlist ({layoutNetlist?.split("\n").length ?? 0} lines)
        </div>
        <textarea
          readOnly
          value={layoutNetlist ?? ""}
          style={{ ...textareaBase, flex: 1, resize: "none", cursor: "default" }}
          spellCheck={false}
        />
      </div>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        <div style={{ fontSize: 9, fontWeight: 600, color: "var(--ink2)", marginBottom: 2 }}>
          Schematic Netlist
        </div>
        <textarea
          placeholder="Ctrl+V reference SPICE netlist..."
          value={schematicNetlist}
          onChange={(e) => { setSchematicNetlist(e.target.value); if (state.phase !== "idle") setState({ phase: "idle" }); }}
          style={{ ...textareaBase, flex: 1, resize: "none" }}
          spellCheck={false}
        />
      </div>
    </div>
  );

  const renderPropertyTable = () => {
    if (state.phase !== "done") return null;
    const pd = state.data.json.property_diffs;
    if (!pd.length) return null;

    return (
      <div style={{ margin: "0 10px 8px" }}>
        <div style={sectionTitle}>Property Diffs ({pd.length})</div>
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
                  <td style={{ padding: "2px 6px", color: "var(--ink2)" }}>{d.a_device}</td>
                  <td style={{ padding: "2px 6px", textAlign: "right", color: isChange ? "#f55" : "var(--ink2)", fontFamily: "var(--mono)" }}>{fmtVal(d.a_value)}</td>
                  <td style={{ padding: "2px 6px", color: "var(--ink2)" }}>{d.b_device}</td>
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

  function isCascadeArtifact(nets: { a_count: number; b_count: number }[]): boolean {
    let totalA = 0, totalB = 0;
    for (const n of nets) {
      totalA += n.a_count;
      totalB += n.b_count;
    }
    const matched = state.phase === "done" && state.data.matched;
    return !matched && totalA === totalB;
  }

  function cleanNetName(n: string): string {
    return n.replace(/^[AB]\//, "").replace(/[()]/g, "");
  }

  const renderNetTable = () => {
    if (state.phase !== "done") return null;
    // Use direct netlist parsing instead of vyges-lvs unbalanced — cascade-free
    const netDiffs = computeNetDiffs(layoutNetlist ?? "", schematicNetlist);
    if (!netDiffs.length) return null;

    return (
      <div style={{ margin: "0 10px 8px" }}>
        <div style={sectionTitle}>Net Connection Diffs ({netDiffs.length})</div>
        <table style={tableSm}>
          <thead>
            <tr style={{ color: "var(--ink3)", textAlign: "left" }}>
              <th style={{ padding: "2px 6px", width: 24 }}>#</th>
              <th style={{ padding: "2px 6px" }}>Net</th>
              <th style={{ padding: "2px 6px", textAlign: "right" }}>Conns (L)</th>
              <th style={{ padding: "2px 6px", textAlign: "right" }}>Conns (S)</th>
              <th style={{ padding: "2px 6px" }}>Δ</th>
            </tr>
          </thead>
          <tbody>
            {netDiffs.map((d, i) => {
              const moreInL = d.layoutCount > d.schematicCount;
              return (
                <tr key={i} style={{ ...panelBase, marginTop: i > 0 ? 1 : 0 }}>
                  <td style={{ padding: "2px 6px", color: "var(--ink3)" }}>{i + 1}</td>
                  <td style={{ padding: "2px 6px", fontWeight: 600, color: "var(--ink)" }}>{d.name}</td>
                  <td style={{ padding: "2px 6px", textAlign: "right", color: moreInL ? "#f55" : "var(--ink2)" }}>{d.layoutCount}</td>
                  <td style={{ padding: "2px 6px", textAlign: "right", color: !moreInL ? "#48f" : "var(--ink2)" }}>{d.schematicCount}</td>
                  <td style={{ padding: "2px 6px", textAlign: "right", color: "var(--ink3)" }}>
                    {moreInL ? `+${d.layoutCount - d.schematicCount}` : `-${d.schematicCount - d.layoutCount}`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  };

  const renderPortChips = () => {
    if (state.phase !== "done") return null;
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
    // Split mismatch by type
    const paramOnly = mismatches.filter(d => !terminalsDiffer(d.layoutLine, d.schematicLine));
    const connMism = mismatches.filter(d => terminalsDiffer(d.layoutLine, d.schematicLine));

    const catBlock = (title: string, items: DeviceDiff[], color: string, sub?: string) => {
      if (!items.length) return null;
      return (
        <div style={{ marginBottom: 8 }}>
          <div style={{ ...sectionTitle, color }}>{title} ({items.length}){sub && <span style={{ color: "var(--ink3)", fontWeight: 400 }}> — {sub}</span>}</div>
          {items.map((d, i) => (
            <div key={i} style={{ ...panelBase, borderLeft: `3px solid ${color}` }}>
              <div style={{ fontWeight: 600, color: "var(--ink0)" }}>{d.name}</div>
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

    return (
      <div style={{ flex: "0 0 auto", margin: "0 10px 8px" }}>
        <div style={{ ...sectionTitle, fontSize: 12 }}>Device Diffs ({devices.length})</div>
        {catBlock("Only in Layout", lOnly, "#f55")}
        {catBlock("Only in Schematic", sOnly, "#48f")}
        {catBlock("Device Type Mismatch", typeMism, "#f0f", "different model type (e.g. npn vs pnp)")}
        {catBlock("Param Changed", paramOnly, "#fd0", "same topology, different W/L/R/m")}
        {catBlock("Connection Mismatch", connMism, "#f80", "different terminal connections")}
      </div>
    );
  };

  const renderReport = () => {
    if (state.phase !== "done" || !state.data.report) return null;
    return (
      <div style={{ margin: "0 10px 8px" }}>
        <div
          style={{ ...sectionTitle, cursor: "pointer", userSelect: "none", display: "flex", alignItems: "center", gap: 4 }}
          onClick={() => setShowReport((v) => !v)}
        >
          <span style={{ transform: showReport ? "rotate(90deg)" : "none", display: "inline-block", fontSize: 8 }}>{Ic.chev}</span>
          Full vyges-lvs Report
        </div>
        {showReport && (
          <textarea
            readOnly
            value={state.data.report}
            style={{ ...textareaBase, minHeight: 100, cursor: "default", whiteSpace: "pre", fontFamily: "var(--mono)" }}
            spellCheck={false}
          />
        )}
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
            running vyges-lvs...
          </div>
        )}

        {state.phase === "done" && (
          <>
            <div style={{ display: "flex", gap: 10, flex: "1 1 auto", minHeight: 0, overflow: "hidden", padding: "6px 10px 0" }}>
              <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "auto", minWidth: 0 }}>
                {renderNetTable()}
                {renderPortChips()}
                {renderPropertyTable()}
              </div>
              <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "auto", minWidth: 0 }}>
                {renderDeviceDiffs()}
              </div>
            </div>
            <div style={{ margin: "0 10px" }}>
              {renderReport()}
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
