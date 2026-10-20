/**
 * SpiceChatPanel — LLM chat for generating and running ngspice testbenches.
 *
 * Uses the spice agent loop: LLM generates directives → simulation runs →
 * if error, LLM fixes → retry → analyze results. Never modifies DUT.
 */

import { useCallback, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useSpiceAgent } from "../../lib/simulation/useSpiceAgent";
import { usePreferences } from "../../state/preferences";
import { useSpiceHandoff } from "../../state/spiceHandoff";

type Props = {
  dieId: string;
  netlist: string;
  onApplyDirectives: (directives: string) => void;
};

export function SpiceChatPanel({ dieId, netlist, onApplyDirectives }: Props) {
  const [input, setInput] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const llmProvider = usePreferences((s) => s.llmProvider);
  const ngspiceMode = usePreferences((s) => s.ngspiceMode);
  const ngspicePath = usePreferences((s) => s.ngspicePath);
  const navigate = useNavigate();
  const setHandoff = useSpiceHandoff((s) => s.setHandoff);

  const { turns, running, status, runAgentLoop } = useSpiceAgent({
    dieId,
    netlist,
    llmConfig: llmProvider,
    onDirectivesUpdate: onApplyDirectives,
    mode: ngspiceMode,
    binPath: ngspiceMode === "server" ? ngspicePath : undefined,
  });

  /** Open this testbench in the simulator with its results. */
  const openResults = useCallback((turnIndex: number) => {
    const turn = turns[turnIndex];
    if (!turn?.simResult?.netlist) return;
    setHandoff({
      dieId,
      netlist: turn.simResult.netlist,
      summary: turn.simResult.measurements
        ? `${turn.simResult.numPoints ?? 0} points, ${Object.keys(turn.simResult.measurements).length} values`
        : undefined,
      measurements: turn.simResult.measurements,
      origin: "assistant",
      at: Date.now(),
    });
    navigate(`/spice-sim?die=${encodeURIComponent(dieId)}`);
  }, [turns, dieId, navigate, setHandoff]);

  const send = useCallback(() => {
    const prompt = input.trim();
    if (!prompt || running) return;
    setInput("");
    runAgentLoop(prompt);
  }, [input, running, runAgentLoop]);

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  }, [send]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {/* Agent status */}
      {running && (
        <div style={{ fontSize: 10, color: "var(--accent)", padding: "4px 0" }}>
          {status}
        </div>
      )}

      {/* Chat turns */}
      {turns.length > 0 && (
        <div style={{ maxHeight: 250, overflow: "auto", display: "flex", flexDirection: "column", gap: 4 }}>
          {turns.map((turn, i) => (
            <div key={i} style={{
              padding: "6px 8px", borderRadius: 4, fontSize: 11, lineHeight: 1.4,
              background: turn.role === "user" ? "var(--l1)" : "var(--card)",
              border: "1px solid var(--l2)",
              color: "var(--ink)",
              fontFamily: "var(--font-mono, monospace)",
              whiteSpace: "pre-wrap",
            }}>
              <div style={{ fontSize: 9, color: "var(--ink3)", marginBottom: 2, fontWeight: 600, display: "flex", gap: 6, alignItems: "center" }}>
                {turn.role === "user" ? "You" : "Agent"}
                {turn.simResult && (
                  <span style={{
                    fontSize: 8, padding: "1px 4px", borderRadius: 2,
                    background: turn.simResult.ok ? "#1a4d1a" : "#4d1a1a",
                    color: turn.simResult.ok ? "#4dff4d" : "#ff4d4d",
                    fontWeight: 400,
                  }}>
                    {turn.simResult.ok ? "OK" : "FAIL"}
                    {turn.simResult.numPoints != null && ` ${turn.simResult.numPoints}pts`}
                  </span>
                )}
              </div>
              {turn.content}
              {turn.directives && (
                <details style={{ marginTop: 4 }}>
                  <summary style={{ fontSize: 9, color: "var(--ink3)", cursor: "pointer" }}>
                    directives ({turn.directives.split("\n").length} lines)
                  </summary>
                  <pre style={{ fontSize: 9, color: "var(--ink2)", margin: "4px 0 0", whiteSpace: "pre-wrap" }}>
                    {turn.directives}
                  </pre>
                </details>
              )}
              {turn.simResult?.measurements && Object.keys(turn.simResult.measurements).length > 0 && (
                <details style={{ marginTop: 4 }}>
                  <summary style={{ fontSize: 9, color: "var(--ink3)", cursor: "pointer" }}>
                    measurements ({Object.keys(turn.simResult.measurements).length})
                  </summary>
                  <pre style={{ fontSize: 9, color: "var(--ink2)", margin: "4px 0 0", whiteSpace: "pre-wrap" }}>
                    {Object.entries(turn.simResult.measurements).map(([k, v]) => `${k} = ${typeof v === "number" ? v.toPrecision(4) : v}`).join("\n")}
                  </pre>
                </details>
              )}
              {turn.simResult?.errors && turn.simResult.errors.length > 0 && (
                <pre style={{ fontSize: 9, color: "var(--bad)", margin: "4px 0 0", whiteSpace: "pre-wrap" }}>
                  {turn.simResult.errors.join("\n")}
                </pre>
              )}
              {turn.simResult?.notes && turn.simResult.notes.length > 0 && (
                <details style={{ marginTop: 4 }}>
                  <summary style={{ fontSize: 9, color: "var(--ink3)", cursor: "pointer" }}>
                    run notes ({turn.simResult.notes.length})
                  </summary>
                  <ul style={{ fontSize: 9, color: "var(--ink3)", margin: "4px 0 0", paddingLeft: 14, lineHeight: 1.4 }}>
                    {turn.simResult.notes.map((note, i) => (
                      <li key={i}>{note}</li>
                    ))}
                  </ul>
                </details>
              )}
              {turn.simResult?.ok && turn.simResult.netlist && (
                <button
                  className="btn ghost"
                  style={{ fontSize: 9, marginTop: 4 }}
                  onClick={() => openResults(i)}
                >
                  Go to SPICE results →
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Input */}
      <div style={{ display: "flex", gap: 4 }}>
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={running ? "agent working..." : "ask agent to generate testbench..."}
          rows={2}
          disabled={running}
          style={{
            flex: 1, padding: "6px 8px", fontSize: 11, lineHeight: 1.4,
            fontFamily: "var(--font-mono, monospace)",
            background: "var(--card)", color: "var(--ink)",
            border: "1px solid var(--l2)", borderRadius: 4, resize: "none", outline: "none",
            opacity: running ? 0.5 : 1,
          }}
        />
        <button
          className="btn ghost"
          onClick={send}
          disabled={!input.trim() || running}
          style={{ fontSize: 10, alignSelf: "flex-end" }}
        >
          {running ? "..." : "Send"}
        </button>
      </div>

      {turns.length > 0 && !running && (
        <button
          className="btn ghost"
          onClick={() => { /* TODO: clear turns */ }}
          style={{ fontSize: 9, alignSelf: "flex-start" }}
        >
          new session
        </button>
      )}
    </div>
  );
}
