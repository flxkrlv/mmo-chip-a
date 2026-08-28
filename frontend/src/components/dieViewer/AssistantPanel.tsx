import { useEffect, useMemo, useState } from "react";
import type { AnalogDevice, AssistantAnalysisBrief, AssistantAnalysisMode, AssistantFinding, DieAnnotations, FloorplanRegion } from "shared";
import { analyseAssistantCircuit } from "../../api/assistantAnalysis";
import { useAssistantSession } from "../../state/assistantSession";
import { usePreferences } from "../../state/preferences";

interface Props {
  dieId: string;
  annotations: DieAnnotations | undefined;
  devices: AnalogDevice[];
  netNames: Map<number, string>;
  warnings: string[];
  floorplanRegions: FloorplanRegion[];
  onActivateFinding: (finding: AssistantFinding | null) => void;
  onOpenNetlist: (finding: AssistantFinding, view: "code" | "graph" | "schematic") => void;
}

const COLOR: Record<AssistantFinding["kind"], string> = {
  diode_connected_device: "#9aa7bd",
  current_mirror: "#ffaa44",
  bjt_current_mirror: "#f59e42",
  bjt_current_source: "#eab676",
  widlar_current_source: "#db9a44",
  differential_pair: "#b56cff",
  bjt_differential_pair: "#bc72f5",
  ldo_error_amplifier_feedback: "#57b6ff",
  resistor_divider: "#f2cf4a",
  protection_clamp: "#ff6f91",
  llm_hypothesis: "#67c5ff",
  netlist_problem: "#ff5f56",
  positive_feedback_loop: "#ff6f91",
  bandgap_precursor: "#44ddff",
};

const emptyBrief: AssistantAnalysisBrief = {};

function findingStatus(finding: AssistantFinding): string {
  return `CONF: ${finding.confidenceLevel}`;
}

/** Read-only assistant surface. No action in this component mutates annotations. */
export function AssistantPanel({ dieId, annotations, devices, netNames, warnings, floorplanRegions, onActivateFinding, onOpenNetlist }: Props) {
  const session = useAssistantSession((state) => state.byDieId[dieId]);
  const setBriefForDie = useAssistantSession((state) => state.setBrief);
  const setModeForDie = useAssistantSession((state) => state.setMode);
  const setResultForDie = useAssistantSession((state) => state.setResult);
  const setActiveFindingIdForDie = useAssistantSession((state) => state.setActiveFindingId);
  const llmProvider = usePreferences((state) => state.llmProvider);
  const brief = session?.brief ?? emptyBrief;
  const result = session?.result ?? null;
  const mode: AssistantAnalysisMode = session?.mode ?? result?.mode ?? "functional_blocks";
  const activeId = session?.activeFindingId ?? null;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedRegionId, setSelectedRegionId] = useState<string | null>(null);

  const selectedRegion = useMemo(
    () => floorplanRegions.find((r) => r.id === selectedRegionId) ?? null,
    [floorplanRegions, selectedRegionId],
  );

  const regionDevices = useMemo(() => {
    if (!selectedRegion) return [];
    const { geometry, kind } = selectedRegion;
    if (kind === "rect" && geometry.length >= 2) {
      const [p1, p2] = geometry;
      const rx = Math.min(p1.x, p2.x);
      const ry = Math.min(p1.y, p2.y);
      const rw = Math.abs(p2.x - p1.x);
      const rh = Math.abs(p2.y - p1.y);
      return devices.filter((d) => {
        if (!d.bbox) return false;
        return !(d.bbox.x + d.bbox.width < rx || d.bbox.x > rx + rw || d.bbox.y + d.bbox.height < ry || d.bbox.y > ry + rh);
      });
    }
    if (kind === "polygon" && geometry.length >= 3) {
      return devices.filter((d) => {
        if (!d.bbox) return false;
        const cx = d.bbox.x + d.bbox.width / 2;
        const cy = d.bbox.y + d.bbox.height / 2;
        return pointInPolygon(cx, cy, geometry);
      });
    }
    return [];
  }, [devices, selectedRegion]);

  const regionUuids = useMemo(
    () => regionDevices.map((d) => String((d as any)._uuid ?? d.id)),
    [regionDevices],
  );

  const regionNetIds = useMemo(() => {
    const ids = new Set<number>();
    for (const d of regionDevices) {
      for (const t of d.terminals) {
        if (typeof t.netId === "number") ids.add(t.netId);
      }
    }
    return [...ids];
  }, [regionDevices]);

  const canAnalyse = Boolean(annotations && devices.length > 0 && !loading);
  const canAnalyseSelected = canAnalyse && regionDevices.length > 0;
  const sortedFindings = useMemo(
    () => [...(result?.findings ?? [])].sort((a, b) => b.confidence - a.confidence),
    [result],
  );
  const activeFinding = useMemo(
    () => result?.findings.find((finding) => finding.id === activeId) ?? null,
    [result, activeId],
  );

  const updateBrief = (key: keyof AssistantAnalysisBrief, value: string) => {
    setBriefForDie(dieId, { ...brief, [key]: value || undefined });
  };

  const run = async (scope: "selected" | "die", nextMode: AssistantAnalysisMode = mode) => {
    if (!annotations || !canAnalyse) return;
    if (scope === "selected" && regionDevices.length === 0) {
      setError("Select a floorplan region first, then use Analyze selected.");
      return;
    }
    setLoading(true);
    setError(null);
    setModeForDie(dieId, nextMode);
    try {
      const next = await analyseAssistantCircuit(dieId, {
        expectedRev: annotations.rev,
        scope,
        mode: nextMode,
        devices,
        netNames,
        warnings,
        selectedDeviceUuids: scope === "selected" ? regionUuids : [],
        selectedNetIds: scope === "selected" ? regionNetIds : [],
        brief,
        requestLlmExplanation: true,
        llmConfig: llmProvider,
      });
      setResultForDie(dieId, next);
      const first = [...next.findings].sort((a, b) => b.confidence - a.confidence)[0] ?? null;
      onActivateFinding(first);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Assistant analysis failed.";
      setError(message);
      setResultForDie(dieId, null);
      onActivateFinding(null);
    } finally {
      setLoading(false);
    }
  };

  const activate = (finding: AssistantFinding) => {
    setActiveFindingIdForDie(dieId, finding.id);
    onActivateFinding(finding);
  };

  // Restore the temporary die overlay when returning from Net Graph/Schematic
  // or after a browser refresh. The persisted result itself stays read-only.
  useEffect(() => {
    onActivateFinding(activeFinding);
  }, [activeFinding?.id]);

  return (
    <div style={{ padding: "10px 10px 12px", fontSize: 11, display: "flex", flexDirection: "column", gap: 9 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span className="u">AI ANALYSIS</span>
        <span className="chip" style={{ marginLeft: "auto", fontSize: 9 }}>read-only</span>
      </div>
      <details style={{ border: "1px solid var(--l2)", borderRadius: 5, padding: "6px 8px", color: "var(--ink3)" }}>
        <summary style={{ cursor: "pointer", color: "var(--ink2)" }}>Prompt & settings (optional)</summary>
        <fieldset style={{ border: 0, margin: "7px 0 0", padding: 0, display: "grid", gap: 6 }}>
          <legend style={{ color: "var(--ink3)", padding: 0, fontSize: 10 }}>Unknown unless supplied by user</legend>
        <Field label="IC / family" value={brief.chipName ?? ""} placeholder="No info from user" onChange={(value) => updateBrief("chipName", value)} />
        <Field label="Function" value={brief.chipDescription ?? ""} placeholder="No info from user" onChange={(value) => updateBrief("chipDescription", value)} />
        <label style={{ display: "grid", gap: 3 }}>
          <span style={{ color: "var(--ink3)", fontSize: 10 }}>LLM response language</span>
          <select value={brief.language ?? "ru"} onChange={(event) => updateBrief("language", event.target.value)} style={{ font: "inherit", background: "var(--l1)", color: "#fff", border: "1px solid var(--l2)", borderRadius: 4, padding: "4px 6px" }}>
            <option value="ru">Русский</option>
            <option value="en">English</option>
          </select>
        </label>
        <Field label="Technology" value={brief.technology ?? ""} placeholder="No info from user" onChange={(value) => updateBrief("technology", value)} />
        <Field label="Block / region" value={brief.focus ?? ""} placeholder="No info from user" onChange={(value) => updateBrief("focus", value)} />
        <label style={{ display: "grid", gap: 3 }}>
          <span style={{ color: "var(--ink3)", fontSize: 10 }}>Engineering question</span>
          <textarea
            value={brief.prompt ?? ""}
            onChange={(event) => updateBrief("prompt", event.target.value.slice(0, 1200))}
            placeholder="Optional question for the LLM"
            rows={4}
            style={{ resize: "vertical", font: "inherit", minHeight: 54, background: "var(--l1)", color: "#fff", border: "1px solid var(--l2)", borderRadius: 4, padding: "5px 6px" }}
          />
        </label>
        </fieldset>
      </details>

      {floorplanRegions.length > 0 && (
        <label style={{ display: "grid", gap: 3 }}>
          <span style={{ color: "var(--ink3)", fontSize: 10 }}>Floorplan region (for "Analyze selected")</span>
          <select
            value={selectedRegionId ?? ""}
            onChange={(e) => setSelectedRegionId(e.target.value || null)}
            style={{ font: "inherit", background: "var(--l1)", color: "#fff", border: "1px solid var(--l2)", borderRadius: 4, padding: "4px 6px" }}
          >
            <option value="">Whole die</option>
            {floorplanRegions.map((r) => <option key={r.id} value={r.id}>{r.name || r.id}</option>)}
          </select>
        </label>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
        <button className="btn" type="button" disabled={!canAnalyseSelected} title={selectedRegion ? `Region: ${selectedRegion.name} (${regionDevices.length} devices)` : "Select a floorplan region first"} onClick={() => void run("selected", mode)}>
          {loading ? "Analysing…" : "Analyze selected"}
        </button>
        <button className="btn" type="button" disabled={!canAnalyse} onClick={() => void run("die", "functional_blocks")}>
          {loading ? "Analysing…" : "Find functional blocks"}
        </button>
        <button className="btn" type="button" disabled={!canAnalyse} onClick={() => void run("die", "netlist_problems")}>
          {loading ? "Analysing…" : "Find netlist problems"}
        </button>
        {result && (
          <button className="btn ghost" type="button" onClick={() => { setResultForDie(dieId, null); onActivateFinding(null); }}>
            Clear results
          </button>
        )}
      </div>
      {selectedRegion && <div style={{ color: "var(--ink3)", fontFamily: "var(--mono)", fontSize: 10 }}>Region: {selectedRegion.name} · {regionDevices.length} device{regionDevices.length === 1 ? "" : "s"}</div>}
      {!devices.length && <div style={{ color: "var(--warn, #e6b05b)" }}>No extracted analog devices are available yet.</div>}
      {error && <div style={{ color: "var(--danger, #ed6a5e)", lineHeight: 1.35 }}>{error}</div>}

      {result && (
        <>
          <div style={{ borderTop: "1px solid var(--l2)", paddingTop: 8, color: "var(--ink2)", lineHeight: 1.4 }}>
            <span>{result.llm.used ? `${result.findings.length} findings` : "LLM analysis unavailable"}</span>
            {result.llm.requested && !result.llm.used && result.llm.unavailableReason && (
              <div style={{ marginTop: 5, color: "var(--ink3)" }}>{result.llm.unavailableReason}</div>
            )}
            {result.llm.requested && result.llm.used && (
              <div style={{ marginTop: 5, color: "var(--ink3)" }}>LLM full-graph analysis complete in {((result.llm.durationMs ?? 0) / 1000).toFixed(1)}s. Cards are sorted by confidence.</div>
            )}
            {result.llm.requested && result.llm.used && result.llm.unavailableReason && (
              <div style={{ marginTop: 5, color: "var(--warn, #e6b05b)" }}>{result.llm.unavailableReason}</div>
            )}
          </div>
          {result.diagnostics.filter((note) => !note.startsWith("LLM analysis snapshot:") && !note.includes("No hard-coded functional-block")).length > 0 && (
            <details style={{ border: "1px solid var(--l2)", borderRadius: 4, padding: "5px 7px", color: "var(--ink3)", lineHeight: 1.35 }}>
              <summary style={{ cursor: "pointer", color: "var(--ink2)" }}>Extraction diagnostics</summary>
              <ul style={{ margin: "6px 0 0", paddingLeft: 15 }}>
                {result.diagnostics
                  .filter((note) => !note.startsWith("LLM analysis snapshot:") && !note.includes("No hard-coded functional-block"))
                  .map((note, index) => <li key={index}>{note}</li>)}
              </ul>
            </details>
          )}
          {result.findings.length === 0 ? (
            <div style={{ color: "var(--ink3)", lineHeight: 1.4 }}>The LLM returned no hypotheses for this scope.</div>
          ) : sortedFindings.map((finding) => (
            <FindingCard
              key={finding.id}
              finding={finding}
              active={finding.id === activeId}
              onActivate={() => activate(finding)}
              onOpen={(view) => { activate(finding); onOpenNetlist(finding, view); }}
            />
          ))}
          {activeFinding && <div style={{ fontSize: 10, color: "var(--ink3)" }}>Overlay is a temporary read-only preview of the active result. The active finding is restored when returning from graph/schematic or after reload.</div>}
          <div style={{ fontSize: 10, color: "var(--ink3)", lineHeight: 1.4, borderTop: "1px solid var(--l2)", paddingTop: 8, marginTop: 4 }}>
            LLM is a probabilistic model and does not currently use a verified knowledge base. Results should be used only as an independent perspective for error-checking. Each hypothesis requires independent verification regardless of confidence level.
          </div>
        </>
      )}
    </div>
  );
}

function Field({ label, value, placeholder, onChange }: { label: string; value: string; placeholder: string; onChange: (value: string) => void }) {
  return (
    <label style={{ display: "grid", gap: 3 }}>
      <span style={{ color: "var(--ink3)", fontSize: 10 }}>{label}</span>
      <input value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} style={{ font: "inherit", minWidth: 0, background: "var(--l1)", color: "#fff", border: "1px solid var(--l2)", borderRadius: 4, padding: "4px 6px" }} />
    </label>
  );
}

function FindingCard({ finding, active, onActivate, onOpen }: { finding: AssistantFinding; active: boolean; onActivate: () => void; onOpen: (view: "code" | "graph" | "schematic") => void }) {
  const color = COLOR[finding.kind];
  return (
    <article
      onClick={onActivate}
      style={{ border: `1px solid ${active ? color : "var(--l2)"}`, borderLeft: `4px solid ${color}`, borderRadius: 5, padding: "8px 8px 7px", display: "grid", gap: 6, cursor: "pointer", background: active ? color + "12" : "transparent" }}
    >
      <div style={{ display: "flex", gap: 6, alignItems: "baseline" }}>
        <strong style={{ fontSize: 11 }}>{finding.label}</strong>
        <span style={{ marginLeft: "auto", color, fontSize: 9, textTransform: "uppercase" }}>{findingStatus(finding)}</span>
      </div>
      <div style={{ fontFamily: "var(--mono)", color: "var(--ink2)", fontSize: 10 }}>{finding.instanceNames.join(" · ")}</div>
      {finding.assistantComment && <div style={{ color: "var(--ink2)", lineHeight: 1.35 }}>{finding.assistantComment}</div>}
      <ul style={{ margin: 0, paddingLeft: 15, color: "var(--ink3)", lineHeight: 1.35 }}>
        {finding.evidence
          .filter((item) => item.code !== "llm_hypothesis_from_model")
          .slice(0, 2)
          .map((item) => <li key={item.code}>{item.text}</li>)}
      </ul>
      <div style={{ color: "var(--ink3)", lineHeight: 1.35 }}><b>Check:</b> {finding.suggestedChecks[0]}</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 }} onClick={(event) => event.stopPropagation()}>
        <button className="btn ghost" type="button" onClick={() => onOpen("graph")}>Net Graph</button>
        <button className="btn ghost" type="button" onClick={() => onOpen("code")}>Netlist</button>
      </div>
      <button className="btn ghost" type="button" onClick={(event) => { event.stopPropagation(); onOpen("schematic"); }}>Show schematic fragment</button>
    </article>
  );
}

function pointInPolygon(x: number, y: number, polygon: { x: number; y: number }[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x, yi = polygon[i].y;
    const xj = polygon[j].x, yj = polygon[j].y;
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}
