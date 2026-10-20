/**
 * SpiceRunCard.tsx — the trace of one ngspice run inside the assistant thread.
 *
 * Shows what the model ran, what ngspice answered and what the tool had to
 * fix on the way, and offers to open the same testbench in the SPICE
 * simulator (with the results).
 */

import { useState } from "react";
import type { AssistantSpiceRun } from "shared";

type Props = {
  run: AssistantSpiceRun;
  /** Opens the SPICE simulator with this run (testbench + results). */
  onOpenResults?: (run: AssistantSpiceRun) => void;
};

function formatValue(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (value === 0) return "0";
  const abs = Math.abs(value);
  if (abs >= 1e5 || abs < 1e-3) return value.toExponential(4);
  return value.toPrecision(6).replace(/0+$/, "").replace(/\.$/, "");
}

export function SpiceRunCard({ run, onOpenResults }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [showNetlist, setShowNetlist] = useState(false);
  const ok = run.ok;

  return (
    <div
      style={{
        border: `1px solid ${ok ? "var(--l2)" : "#6b2b2b"}`,
        borderRadius: 6,
        background: "var(--l1)",
        padding: "6px 8px",
        maxWidth: "100%",
        minWidth: 0,
      }}
    >
      <div
        style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}
        onClick={() => setExpanded(!expanded)}
      >
        <span style={{ fontSize: 10, fontWeight: 600, color: ok ? "#7ee787" : "#ff7b72" }}>
          {ok ? "⚡ SPICE" : "⚡ SPICE failed"}
        </span>
        <span style={{ fontSize: 9, color: "var(--ink3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {run.summary}
        </span>
        <span style={{ marginLeft: "auto", fontSize: 9, color: "var(--ink3)" }}>{expanded ? "▲" : "▼"}</span>
      </div>

      {expanded && (
        <div style={{ display: "grid", gap: 6, marginTop: 6, fontSize: 9 }}>
          {run.error && (
            <div style={{ color: "#ff7b72", whiteSpace: "pre-wrap", overflowWrap: "anywhere", lineHeight: 1.4 }}>
              {run.error}
            </div>
          )}

          {run.analyses && run.analyses.length > 0 && (
            <div style={{ color: "var(--ink3)" }}>
              analyses:{" "}
              {run.analyses.map((a, i) => (
                <span key={i}>
                  {i > 0 ? ", " : ""}
                  <code style={{ color: "var(--ink2)" }}>{a.analysis}</code>
                  {a.plot ? ` → ${a.plot}` : ""}
                  {a.error ? " (failed)" : ""}
                </span>
              ))}
            </div>
          )}

          {run.measurements && Object.keys(run.measurements).length > 0 && (
            <div>
              <div style={{ color: "var(--ink3)", textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 2 }}>measurements</div>
              <div style={{ display: "grid", gap: 2 }}>
                {Object.entries(run.measurements).map(([name, value]) => (
                  <div key={name} style={{ display: "flex", gap: 8 }}>
                    <span style={{ color: "var(--ink2)" }}>{name}</span>
                    <span style={{ marginLeft: "auto", color: "#7ee787", fontFamily: "var(--mono)" }}>{formatValue(value)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {run.keyValues && Object.keys(run.keyValues).length > 0 && (
            <details>
              <summary style={{ cursor: "pointer", color: "var(--ink3)" }}>node voltages / currents ({Object.keys(run.keyValues).length})</summary>
              <div style={{ display: "grid", gap: 1, marginTop: 3, maxHeight: 160, overflowY: "auto" }}>
                {Object.entries(run.keyValues).map(([name, value]) => (
                  <div key={name} style={{ display: "flex", gap: 8 }}>
                    <span style={{ color: "var(--ink2)" }}>{name}</span>
                    <span style={{ marginLeft: "auto", color: "var(--ink3)", fontFamily: "var(--mono)" }}>{formatValue(value)}</span>
                  </div>
                ))}
              </div>
            </details>
          )}

          {run.notes && run.notes.length > 0 && (
            <div>
              <div style={{ color: "var(--ink3)", textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 2 }}>tool notes</div>
              <ul style={{ margin: 0, paddingLeft: 14, color: "var(--ink3)", lineHeight: 1.4 }}>
                {run.notes.map((note, i) => (
                  <li key={i}>{note}</li>
                ))}
              </ul>
            </div>
          )}

          <div>
            <button
              className="btn ghost"
              type="button"
              style={{ fontSize: 9 }}
              onClick={(event) => { event.stopPropagation(); setShowNetlist(!showNetlist); }}
            >
              {showNetlist ? "hide netlist" : "show netlist"}
            </button>
            {onOpenResults && (
              <button
                className="btn"
                type="button"
                style={{ fontSize: 9, marginLeft: 6 }}
                onClick={(event) => { event.stopPropagation(); onOpenResults(run); }}
              >
                Go to SPICE results →
              </button>
            )}
          </div>

          {showNetlist && (
            <pre
              style={{
                margin: 0, maxHeight: 220, overflow: "auto", whiteSpace: "pre-wrap", overflowWrap: "anywhere",
                background: "#11110f", border: "1px solid var(--l2)", borderRadius: 4, padding: "5px 6px",
                fontFamily: "var(--mono)", fontSize: 8.5, color: "var(--ink2)", lineHeight: 1.35,
              }}
            >
              {run.netlist}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
