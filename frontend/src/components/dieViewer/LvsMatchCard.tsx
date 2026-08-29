import { useMemo, useState } from "react";
import type { AssistantLvsMatch } from "shared";
import { formatDevicesAsNetlist2Svg } from "../../lib/schematic/netlist2svgFormat";
import { parseNetlistToDevices } from "../../lib/schematic/netlistTextToDevices";
import { Netlist2SvgView } from "../netlist/Netlist2SvgView";

/**
 * One LVS comparison result: status, near-miss diagnostics, and an expandable view
 * of the found reference netlist and the candidate netlist, each rendered as a
 * schematic via the app's existing netlist2svg pipeline (same engine as the
 * Netlist (Analog) tab — no duplicate SVG renderer).
 */
export function LvsMatchCard({
  match,
  candidateNetlist,
}: {
  match: AssistantLvsMatch;
  /** Normalized candidate netlist (CDL) — the user's selection, for side-by-side comparison. */
  candidateNetlist?: string;
}) {
  const [view, setView] = useState<"none" | "text" | "refSvg" | "candSvg">("none");
  const accent = match.matched ? "#7ee787" : "#f2cf4a";

  const refYosys = useMemo(() => {
    if (!match.referenceNetlist) return null;
    try {
      const { devices, namedNets } = parseNetlistToDevices(match.referenceNetlist);
      return formatDevicesAsNetlist2Svg(devices, namedNets, match.cellId ?? "ref", { showNetLabels: true });
    } catch {
      return null;
    }
  }, [match.referenceNetlist, match.cellId]);

  const candYosys = useMemo(() => {
    if (!candidateNetlist) return null;
    try {
      const { devices, namedNets } = parseNetlistToDevices(candidateNetlist);
      return formatDevicesAsNetlist2Svg(devices, namedNets, "candidate", { showNetLabels: true });
    } catch {
      return null;
    }
  }, [candidateNetlist]);

  const showCand = Boolean(candYosys);

  return (
    <div style={{ border: `1px solid ${accent}`, borderRadius: 5, padding: "6px 8px", background: "var(--l1)", display: "grid", gap: 5 }}>
      <div style={{ fontSize: 10, color: accent, fontWeight: 600 }}>
        {match.matched ? "TOPOLOGY MATCH" : "NEAR MISS"} · {match.cellId}
      </div>
      {match.topology && <div style={{ fontSize: 9, color: "var(--ink2)" }}>Topology: {match.topology}</div>}
      <div style={{ fontSize: 9, color: "var(--ink3)" }}>Distance: {match.distance}</div>
      {!match.matched && (
        <div style={{ fontSize: 9, color: "var(--ink3)", lineHeight: 1.3 }}>
          Extra in selected: {match.extraDevices?.join(", ") || "—"}
          <br />
          Missing vs reference: {match.missingDevices?.join(", ") || "—"}
        </div>
      )}
      {match.referenceNetlist && (
        <div style={{ display: "grid", gap: 4 }}>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <button className="btn ghost" type="button" style={{ fontSize: 9, padding: "2px 6px" }} onClick={() => setView(view === "text" ? "none" : "text")}>
              Netlist text
            </button>
            <button className="btn ghost" type="button" style={{ fontSize: 9, padding: "2px 6px" }} onClick={() => setView(view === "refSvg" ? "none" : "refSvg")}>
              Reference SVG
            </button>
            {showCand && (
              <button className="btn ghost" type="button" style={{ fontSize: 9, padding: "2px 6px" }} onClick={() => setView(view === "candSvg" ? "none" : "candSvg")}>
                Candidate SVG
              </button>
            )}
          </div>
          {view === "text" && (
            <pre
              style={{
                margin: 0,
                maxHeight: 180,
                overflow: "auto",
                fontFamily: "var(--mono)",
                fontSize: 9,
                color: "var(--ink2)",
                background: "var(--card)",
                border: "1px solid var(--l2)",
                borderRadius: 4,
                padding: 6,
                whiteSpace: "pre",
              }}
            >
              {match.referenceNetlist}
            </pre>
          )}
          {view === "refSvg" && refYosys && <Netlist2SvgView netlistJson={refYosys} height={220} />}
          {view === "refSvg" && !refYosys && <div style={{ fontSize: 9, color: "var(--ink3)" }}>Could not render reference schematic.</div>}
          {view === "candSvg" && candYosys && <Netlist2SvgView netlistJson={candYosys} height={220} />}
        </div>
      )}
    </div>
  );
}
