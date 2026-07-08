import { useCallback, useState, useRef, useEffect } from "react";
import type { SpiceDialect } from "shared";
import { compareNetlists } from "../../api/lvs";
import { Ic } from "../../icons";

const textareaBase: React.CSSProperties = {
  width: "100%", fontFamily: "var(--mono)", fontSize: 10, lineHeight: 1.4,
  background: "var(--bg1)", border: "1px solid var(--l2)", borderRadius: 4,
  color: "var(--fg)", padding: 6, resize: "vertical", outline: "none",
};

interface DeviceDiff {
  name: string;
  layoutLine: string;
  schematicLine: string;
}

type PanelPhase =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "done"; matched: boolean; devices: DeviceDiff[]; report: string }
  | { phase: "error"; error: string; detail?: string };

interface Props {
  dieId: string;
  layoutNetlist: string | null;
  dialect: SpiceDialect;
  moduleName: string;
}

// ── Helpers ────────────────────────────────────────────────────

/** Extract device names from vyges-lvs JSON unbalanced[].what === "device" */
function unbalancedDeviceNames(json: Record<string, unknown>): Set<string> {
  const names = new Set<string>();
  const classes = json.unbalanced as any[] ?? [];
  for (const c of classes) {
    if (c.what !== "device") continue;
    for (const n of c.a ?? []) names.add((n as string).replace(/^[AB]\//, ""));
    for (const n of c.b ?? []) names.add((n as string).replace(/^[AB]\//, ""));
  }
  return names;
}

/** Find first word (device name) on each device line in a netlist */
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

/** Build diff for devices vyges-lvs flagged as unbalanced */
function buildDiffs(layoutNetlist: string, schematicNetlist: string, json: Record<string, unknown>): DeviceDiff[] {
  const names = unbalancedDeviceNames(json);
  const layoutMap = buildDeviceMap(layoutNetlist);
  const schematicMap = buildDeviceMap(schematicNetlist);
  const diffs: DeviceDiff[] = [];
  for (const name of names) {
    const lLine = layoutMap.get(name.toLowerCase()) ?? "";
    const sLine = schematicMap.get(name.toLowerCase()) ?? "";
    if (lLine !== sLine) {
      diffs.push({ name: lLine.split(/\s+/)[0] || name, layoutLine: lLine, schematicLine: sLine });
    }
  }
  return diffs;
}

// ── Component ──────────────────────────────────────────────────

export default function LVSComparePanel({ dieId, layoutNetlist, dialect, moduleName }: Props) {
  const [schematicNetlist, setSchematicNetlist] = useState("");
  const [state, setState] = useState<PanelPhase>({ phase: "idle" });
  const [showLayout, setShowLayout] = useState(false);
  const reportRef = useRef<HTMLDivElement>(null);

  const handleCompare = useCallback(async () => {
    if (!schematicNetlist.trim() || !layoutNetlist) return;
    setState({ phase: "loading" });
    try {
      const res = await compareNetlists(dieId, { layoutNetlist, schematicNetlist, dialect, moduleName });
      if (res.ok && "json" in res.data) {
        const devices = buildDiffs(layoutNetlist, schematicNetlist, res.data.json as unknown as Record<string, unknown>);
        setState({ phase: "done", matched: res.data.matched, devices, report: res.data.report });
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

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--card)" }}>
      {/* Inputs */}
      <div style={{ flex: "0 0 auto", display: "flex", flexDirection: "column" }}>
        <div className="ph" style={{ cursor: "pointer" }} onClick={() => setShowLayout((v) => !v)}>
          <span className="u" style={{ fontSize: 10, fontWeight: 600, color: "var(--ink2)", display: "flex", alignItems: "center", gap: 4 }}>
            <span style={{ transform: showLayout ? "rotate(90deg)" : "none", display: "inline-block" }}>{Ic.chev}</span>
            Layout Netlist {layoutNetlist ? `(${layoutNetlist.split("\n").length} lines)` : ""}
          </span>
        </div>
        {showLayout && (
          <textarea readOnly value={layoutNetlist ?? ""} style={{ ...textareaBase, minHeight: 80, cursor: "default" }} />
        )}
        <div style={{ fontSize: 10, fontWeight: 600, color: "var(--ink2)", padding: "8px 10px 4px" }}>
          Schematic Netlist (paste from external CAD)
        </div>
        <textarea
          placeholder="Ctrl+V your reference SPICE netlist here..."
          value={schematicNetlist}
          onChange={(e) => { setSchematicNetlist(e.target.value); if (state.phase !== "idle") setState({ phase: "idle" }); }}
          style={{ ...textareaBase, minHeight: 60 }}
          spellCheck={false}
        />
        <div style={{ padding: "6px 10px", display: "flex", gap: 8, alignItems: "center" }}>
          <button type="button" disabled={!canCompare} onClick={handleCompare} style={{
            fontSize: 10, fontWeight: 600, padding: "4px 14px", borderRadius: 4, cursor: "pointer", border: "none",
            background: canCompare ? "var(--accent)" : "var(--l1)",
            color: canCompare ? "var(--accentFg, #fff)" : "var(--ink3)", opacity: canCompare ? 1 : 0.5,
          }}>
            {state.phase === "loading" ? "Running vyges-lvs..." : "Compare"}
          </button>
        </div>
      </div>

      {/* Results */}
      <div ref={reportRef} style={{ flex: "1 1 auto", minHeight: 0, borderTop: "1px solid var(--l2)", overflow: "auto", display: "flex", flexDirection: "column" }}>
        {state.phase === "loading" && (
          <div className="m" style={{ padding: 20, fontSize: 11, color: "var(--ink3)", textAlign: "center" }}>running vyges-lvs...</div>
        )}

        {state.phase === "done" && (
          <div style={{ padding: "4px 10px 10px", display: "flex", flexDirection: "column", height: "100%" }}>
            {/* Badge */}
            <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 0 8px", flexWrap: "wrap" }}>
              <span style={{
                display: "inline-flex", alignItems: "center", gap: 4,
                fontSize: 12, fontWeight: 700, padding: "3px 10px", borderRadius: 4,
                background: state.matched ? "var(--okBg, #1a3a1a)" : "var(--errBg, #3a1a1a)",
                color: state.matched ? "var(--okFg, #4f4)" : "var(--errFg, #f44)",
              }}>
                {state.matched ? "MATCH" : "MISMATCH"}
              </span>
              <span style={{ fontSize: 9, color: "var(--ink3)" }}>
                {state.report.split("\n")[1]?.trim() ?? ""}
              </span>
            </div>

            {/* Device diff table */}
            {state.devices.length > 0 && (
              <div style={{ flex: "0 0 auto", marginBottom: 8 }}>
                <div style={{ fontSize: 9, fontWeight: 600, color: "var(--ink2)", marginBottom: 4 }}>
                  Differences ({state.devices.length})
                </div>
                {state.devices.map((d, i) => (
                  <div key={i} style={{
                    fontSize: 9, fontFamily: "var(--mono)", lineHeight: 1.5,
                    padding: "4px 6px", marginTop: 2, borderRadius: 3,
                    background: "var(--l1)",
                  }}>
                    <div style={{ fontWeight: 600, color: "var(--ink0)" }}>{d.name}</div>
                    <table style={{ width: "100%", fontSize: 9, borderCollapse: "collapse", marginTop: 2 }}>
                      <tbody>
                        <tr>
                          <td style={{ color: "#f55", paddingRight: 8, verticalAlign: "top", whiteSpace: "nowrap", width: 16 }}>L</td>
                          <td style={{ color: "var(--ink2)", wordBreak: "break-all" }}>{d.layoutLine || "—"}</td>
                        </tr>
                        <tr>
                          <td style={{ color: "#48f", paddingRight: 8, verticalAlign: "top", whiteSpace: "nowrap", width: 16 }}>S</td>
                          <td style={{ color: "var(--ink2)", wordBreak: "break-all" }}>{d.schematicLine || "—"}</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                ))}
              </div>
            )}

            {/* Text report */}
            {state.report && (
              <div style={{ flex: "1 1 auto", display: "flex", flexDirection: "column", minHeight: 60 }}>
                <div style={{ fontSize: 9, fontWeight: 600, color: "var(--ink3)", marginBottom: 2 }}>
                  Full vyges-lvs Report
                </div>
                <textarea
                  readOnly
                  value={state.report}
                  style={{ ...textareaBase, flex: 1, cursor: "default", whiteSpace: "pre" }}
                  spellCheck={false}
                />
              </div>
            )}
          </div>
        )}

        {state.phase === "error" && (
          <div style={{ padding: 16 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: "var(--err)", display: "flex", alignItems: "center", gap: 6 }}>
              {Ic.warn} {state.error}
            </div>
            {state.detail && <div style={{ fontSize: 10, color: "var(--ink2)", marginTop: 6, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>{state.detail}</div>}
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
