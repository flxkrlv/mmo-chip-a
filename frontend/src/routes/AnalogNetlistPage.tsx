/**
 * AnalogNetlistPage — CDL/Spectre netlist viewer for analog devices.
 *
 * Layout mirrors the CodePage:
 *   left panel — cell instances grouped by device kind (MOS, BJT, R, C…)
 *   right panel — syntax-highlighted CDL source with clickable line numbers
 *
 * A toolbar picker lets the user switch between CDL / Spectre / HSPICE.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { NetGraphView } from "../components/netlist/NetGraphView";
import type { SpiceConfig, SpiceDialect } from "shared";
import { AppShell } from "../components/shell/AppShell";
import { StatusBar } from "../components/shell/StatusBar";
import { SubBar, ToolDivider } from "../components/shell/SubBar";
import { CodeViewer, type CodeViewerHandle } from "../components/code/CodeViewer";
import { TreeRow, TreeSep } from "../components/tree/TreeRow";
import { useDie } from "../api/dies";
import { useAnnotations } from "../api/annotations";
import { useAnnotationsWebSocket } from "../api/annotationsWebSocket";
import { usePreferences } from "../state/preferences";
import { useSession } from "../state/session";
import {
  useAnalogNetlist,
  loadSpiceConfig,
  saveSpiceConfigToBackend,
} from "../api/analogNetlist";
import { loadClipper } from "../lib/extraction";
import { Ic } from "../icons";
import { exportLayout, renderLayoutCsv } from "../lib/export/layoutExport";

// ── Dialect selector ─────────────────────────────────────────────

const DIALECT_OPTIONS: { value: SpiceDialect; label: string }[] = [
  { value: "cdl", label: "CDL" },
  { value: "spectre", label: "Spectre" },
  { value: "hspice", label: "HSPICE" },
];

// ── Page entry ────────────────────────────────────────────────────

export function AnalogNetlistPage() {
  const [params] = useSearchParams();
  const sessionDieId = useSession((s) => s.dieId);
  const setSessionDieId = useSession((s) => s.setDieId);
  const dieId = params.get("die") ?? sessionDieId ?? null;

  useEffect(() => {
    if (dieId && dieId !== sessionDieId) setSessionDieId(dieId);
  }, [dieId, sessionDieId, setSessionDieId]);

  if (!dieId) {
    return (
      <AppShell breadcrumb="Analog Netlist">
        <Centered>Open a die from the Library to view its analog netlist.</Centered>
      </AppShell>
    );
  }
  return <AnalogNetlist key={dieId} dieId={dieId} />;
}

// ── Inner page ────────────────────────────────────────────────────

function AnalogNetlist({ dieId }: { dieId: string }) {
  const navigate = useNavigate();
  const die = useDie(dieId).data;
  const annotationsQ = useAnnotations(dieId);
  useAnnotationsWebSocket(dieId);
  const annotations = annotationsQ.data;

  // Dialect picker state
  const [dialect, setDialect] = useState<SpiceDialect>("cdl");
  // Resistor format: ohms (resolved value) vs sqRs (squares × sheetR)
  const [resistorFormat, setResistorFormat] = useState<"ohms" | "sqRs">("ohms");
  const [matchEnabled, setMatchEnabled] = useState(false);
  const [matchTolerance, setMatchTolerance] = useState(10);
  // Global supply net names
  const [vddNet, setVddNet] = useState("VDD");
  const [gndNet, setGndNet] = useState("GND");

  // Module name: same convention as the Code page.
  const moduleName = useMemo(
    () => sanitizeModuleName(die?.name ?? dieId),
    [die?.name, dieId],
  );

  // Hierarchical netlist toggle
  const [hierarchical, setHierarchical] = useState(false);

  // Reactive sheetR from preferences (set in Die Viewer → AnalogDiePanel → SheetRConfigPanel)
  const sheetRPrefs = usePreferences((s) => (s as any).sheetR ?? {});

  const spiceConfig: SpiceConfig = useMemo(
    () => ({
      resistorFormat,
      vdd: vddNet, gnd: gndNet,
      sheetR_ohms: sheetRPrefs,
      matchTolerancePercent: matchEnabled ? matchTolerance : 0,
    }),
    [resistorFormat, vddNet, gndNet, sheetRPrefs, matchEnabled, matchTolerance],
  );

  // ══ Ensure Clipper2 WASM is loaded for multi-finger MOS splitting ═
  useEffect(() => {
    loadClipper()
      .then(() => console.log("[analog] Clipper2 loaded"))
      .catch((e) => console.warn("[analog] Clipper2 load failed:", e));
  }, []);

  // ══ SpiceConfig persistence (load on mount, auto-save) ════════
  const lastConfigRef = useRef<SpiceConfig>({});

  // Load saved config on mount
  useEffect(() => {
    let cancelled = false;
    loadSpiceConfig(dieId).then((cfg) => {
      if (cancelled) return;
      lastConfigRef.current = cfg;
      if (cfg.vdd && cfg.vdd !== "VDD") setVddNet(cfg.vdd);
      if (cfg.gnd && cfg.gnd !== "GND") setGndNet(cfg.gnd);
      if (cfg.resistorFormat) setResistorFormat(cfg.resistorFormat);
      if (cfg.matchTolerancePercent != null) {
        setMatchEnabled(cfg.matchTolerancePercent > 0);
        if (cfg.matchTolerancePercent > 0) setMatchTolerance(cfg.matchTolerancePercent);
      }
      // Restore sheetR to preferences if saved in backend
      if (cfg.sheetR_ohms && Object.keys(cfg.sheetR_ohms).length > 0) {
        const prefs = usePreferences.getState() as any;
        const prefsSheetR = prefs.sheetR ?? {};
        // Only set values that aren't already in preferences
        let changed = false;
        for (const [k, v] of Object.entries(cfg.sheetR_ohms)) {
          if (prefsSheetR[k] == null) { prefsSheetR[k] = v; changed = true; }
        }
        if (changed) usePreferences.setState({ sheetR: prefsSheetR });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [dieId]);

  // Auto-save with 500ms debounce
  useEffect(() => {
    const timer = setTimeout(async () => {
      const prefs = usePreferences.getState() as any;
      const merged: SpiceConfig = {
        ...lastConfigRef.current,
        vdd: vddNet,
        gnd: gndNet,
        resistorFormat,
        sheetR_ohms: { ...(prefs.sheetR ?? {}) },
        matchTolerancePercent: matchEnabled ? matchTolerance : 0,
      };
      try {
        await saveSpiceConfigToBackend(dieId, merged);
        lastConfigRef.current = merged;
      } catch {
        // Silent — user can re-save on next edit
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [vddNet, gndNet, resistorFormat, dieId]);

  const netlist = useAnalogNetlist(annotations, moduleName, dialect, spiceConfig, hierarchical);

  // ── UI state ────────────────────────────────────────────────────
  const [rightView, setRightView] = useState<"code" | "graph">("code");
  const viewerRef = useRef<CodeViewerHandle | null>(null);
  const [selectedLine, setSelectedLine] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);

  // Reset the "Copied!" flash.
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1100);
    return () => clearTimeout(t);
  }, [copied]);

  const goToLine = useCallback((line: number) => {
    setSelectedLine(line);
    viewerRef.current?.goToLine(line);
  }, []);

  // Click a device instance → navigate to die viewer and frame it
  const onSelectDevice = useCallback(
    (instanceName: string, cellId: string, line: number) => {
      setSelectedLine(line);
      viewerRef.current?.goToLine(line);
      // Use URL query params — always survives navigation
      navigate(
        `/die/${encodeURIComponent(dieId)}?focusCell=${encodeURIComponent(cellId)}&focusDevice=${encodeURIComponent(instanceName)}`,
      );
    },
    [dieId, navigate],
  );

  const onCopy = useCallback(async () => {
    const text = netlist.data?.source;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      // Fall through silently.
    }
  }, [netlist.data?.source]);

  const onDownload = useCallback(() => {
    const text = netlist.data?.source;
    if (!text) return;
    const ext = dialect === "cdl" ? "cdl" : dialect === "spectre" ? "scs" : "sp";
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${moduleName}.${ext}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [netlist.data?.source, moduleName, dialect]);

  const onDownloadLayout = useCallback(() => {
    if (!annotations) return;
    const umPerPx = annotations.umPerPx ?? 1.0;
    const entries = exportLayout(annotations, umPerPx);
    const csv = renderLayoutCsv(entries);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${moduleName}_placement.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [annotations, moduleName]);

  // ── Status bar items ────────────────────────────────────────────

  const statusItems = useMemo(() => {
    if (!netlist.data) {
      return [die?.name ?? dieId, netlist.loading ? "generating…" : "—"];
    }
    const { totalDevices, byKind, totalCells, totalNets, unconnectedCount } = netlist.data;
    const kindSummary = Object.entries(byKind)
      .map(([k, n]) => `${n}×${k}`)
      .join(" · ");
    const parts = [
      die?.name ?? dieId,
      `${totalDevices} device${totalDevices === 1 ? "" : "s"}`,
      kindSummary,
    ];
    if (totalCells > 0 || totalNets > 0) {
      parts.push(`${totalCells}c ${totalNets}n`);
    }
    if (unconnectedCount > 0) {
      parts.push(`${unconnectedCount} unconn`);
    }
    parts.push(selectedLine ? `L${selectedLine}` : "—", dialect.toUpperCase());
    return parts;
  }, [netlist.data, netlist.loading, die?.name, dieId, selectedLine, dialect]);

  // ── Warning count for the header chip ───────────────────────────
  const warnCount = netlist.data?.warnings.length ?? 0;

  return (
    <AppShell
      breadcrumb={die?.name ?? "Analog Netlist"}
      meta={netlist.data ? `analog · ${netlist.data.fileName}` : "analog"}
    >
      <SubBar
        right={
          <>
            {warnCount > 0 && (
              <span
                className="chip warn"
                title={netlist.data?.warnings.join("\n")}
              >
                {Ic.warn}
                <span style={{ marginLeft: 4 }}>
                  {warnCount} {warnCount === 1 ? "warning" : "warnings"}
                </span>
              </span>
            )}
            {/* View toggle: Code / Graph */}
            <div className="row" style={{ gap: 2, background: "var(--l1)", borderRadius: 4, padding: 2 }}>
              <button
                type="button"
                className={"btn sm" + (rightView === "code" ? " on" : "")}
                onClick={() => setRightView("code")}
                style={{ fontSize: 10, fontWeight: 600 }}
              >
                Code
              </button>
              <button
                type="button"
                className={"btn sm" + (rightView === "graph" ? " on" : "")}
                onClick={() => setRightView("graph")}
                style={{ fontSize: 10, fontWeight: 600 }}
              >
                Graph
              </button>
            </div>
            {/* Hierarchical toggle */}
            {rightView === "code" && (
              <label
                className="row"
                style={{
                  gap: 4,
                  alignItems: "center",
                  fontSize: 10,
                  color: "var(--ink2)",
                  cursor: "pointer",
                  userSelect: "none",
                }}
                title="Partition by floorplan regions → .SUBCKT per region"
              >
                <input
                  type="checkbox"
                  checked={hierarchical}
                  onChange={(e) => setHierarchical(e.target.checked)}
                />
                Hierarchical
              </label>
            )}
            <ToolDivider />
            {/* Dialect picker (only shown in code view) */}
            {rightView === "code" && (
              <div className="row" style={{ gap: 2, background: "var(--l1)", borderRadius: 4, padding: 2 }}>
                {DIALECT_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    className={"btn sm" + (dialect === opt.value ? " on" : "")}
                    onClick={() => setDialect(opt.value)}
                    style={{ fontSize: 10, fontWeight: 600 }}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            )}
            <ToolDivider />
            {/* VDD/GND net names */}
            <div className="row" style={{ gap: 4, alignItems: "center" }}>
              <span style={{ fontSize: 9, color: "var(--ink3)" }}>G:</span>
              <input
                type="text"
                value={vddNet}
                onChange={(e) => setVddNet(e.target.value)}
                style={{
                  width: 48,
                  fontSize: 10,
                  padding: "1px 4px",
                  border: "1px solid var(--l2)",
                  borderRadius: 3,
                  background: "var(--card)",
                  color: "var(--fg)",
                  outline: "none",
                }}
                title="Global VDD net name"
              />
              <span style={{ fontSize: 9, color: "var(--ink3)" }}>GND:</span>
              <input
                type="text"
                value={gndNet}
                onChange={(e) => setGndNet(e.target.value)}
                style={{
                  width: 48,
                  fontSize: 10,
                  padding: "1px 4px",
                  border: "1px solid var(--l2)",
                  borderRadius: 3,
                  background: "var(--card)",
                  color: "var(--fg)",
                  outline: "none",
                }}
                title="Global GND net name"
              />
            </div>
            <ToolDivider />
            {/* Resistor format toggle */}
            <div className="row" style={{ gap: 2, background: "var(--l1)", borderRadius: 4, padding: 2 }}>
              <button
                type="button"
                className={"btn sm" + (resistorFormat === "ohms" ? " on" : "")}
                onClick={() => setResistorFormat("ohms")}
                style={{ fontSize: 10, fontWeight: 600 }}
                title="Resistor: resolved ohms value"
              >
                R=Ω
              </button>
              <button
                type="button"
                className={"btn sm" + (resistorFormat === "sqRs" ? " on" : "")}
                onClick={() => setResistorFormat("sqRs")}
                style={{ fontSize: 10, fontWeight: 600 }}
                title="Resistor: squares × sheetR expression"
              >
                R=sq·Rs
              </button>
            </div>
            <ToolDivider />
            {/* Device matching toggle */}
            <div className="row" style={{ gap: 4, alignItems: "center" }}>
              <button
                type="button"
                className={"btn sm" + (matchEnabled ? " on" : "")}
                onClick={() => setMatchEnabled((v) => !v)}
                style={{ fontSize: 10, fontWeight: 600 }}
                title="Match & average similar device geometry"
              >
                Match
              </button>
              {matchEnabled && (
                <div className="row" style={{ gap: 2, alignItems: "center" }}>
                  <input
                    type="range"
                    min={1}
                    max={25}
                    value={matchTolerance}
                    onChange={(e) => setMatchTolerance(parseInt(e.target.value, 10))}
                    style={{ width: 48, height: 12, margin: 0 }}
                    title="Tolerance %"
                  />
                  <span style={{ fontSize: 9, color: "var(--ink3)", minWidth: 20 }}>
                    {matchTolerance}%
                  </span>
                </div>
              )}
            </div>
            <ToolDivider />
            <button
              type="button"
              className="btn"
              onClick={onCopy}
              disabled={!netlist.data}
              title="Copy netlist source"
            >
              {Ic.copy}
              <span style={{ marginLeft: 4 }}>{copied ? "copied" : "copy"}</span>
            </button>
            <button
              type="button"
              className="btn"
              onClick={onDownload}
              disabled={!netlist.data}
              title="Download netlist file"
            >
              {Ic.download}
              <span style={{ marginLeft: 4 }}>
                {netlist.data ? netlist.data.fileName : "download"}
              </span>
            </button>
            <button
              type="button"
              className="btn"
              onClick={onDownloadLayout}
              disabled={!annotations}
              title="Download layout placement CSV"
            >
              {Ic.download}
              <span style={{ marginLeft: 4 }}>layout</span>
            </button>
          </>
        }
      >
        <span
          className="m"
          style={{ fontSize: 11, color: "var(--ink2)", padding: "0 8px" }}
        >
          {netlist.data?.fileName ?? "—"}
        </span>
      </SubBar>

      <main
        style={{
          flex: "1 1 auto",
          minHeight: 0,
          display: "grid",
          gridTemplateColumns: "240px 1fr",
        }}
      >
        {/* ── Left panel: device instances ───────────────────── */}
        <aside
          style={{
            borderRight: "1px solid var(--l2)",
            background: "var(--card)",
            minHeight: 0,
            overflow: "hidden",
          }}
        >
          {netlist.data ? (
            <InstanceOutline
              outline={netlist.data.outline}
              selectedLine={selectedLine ?? undefined}
              onGoToLine={goToLine}
              onSelectDevice={onSelectDevice}
              totalDevices={netlist.data.totalDevices}
            />
          ) : (
            <OutlinePlaceholder loading={netlist.loading} />
          )}
        </aside>

        {/* ── Right panel: CDL source ────────────────────────── */}
        <section
          style={{
            display: "flex",
            flexDirection: "column",
            minHeight: 0,
            background: "var(--card)",
          }}
        >
          {rightView === "graph" && annotations && netlist.data ? (
            <NetGraphView
              annotations={annotations}
              onDeviceClick={(name, cellId) => {
                navigate(`/die/${encodeURIComponent(dieId)}?focusCell=${encodeURIComponent(cellId)}&focusDevice=${encodeURIComponent(name)}`);
              }}
            />
          ) : netlist.data ? (
            <CodeViewer
              ref={viewerRef}
              source={netlist.data.source}
              markers={[]}
              selectedLine={selectedLine ?? undefined}
              onSelectLine={setSelectedLine}
            />
          ) : (
            <ViewerPlaceholder
              loading={netlist.loading}
              annotationsLoading={!annotations && annotationsQ.isLoading}
            />
          )}

          {/* Warnings panel (collapsible) */}
          {netlist.data && warnCount > 0 && (
            <ProblemsTable
              warnings={netlist.data.warnings}
              onJump={goToLine}
            />
          )}
        </section>
      </main>

      <StatusBar items={statusItems} />
    </AppShell>
  );
}

// ── Instance Outline (left panel) ─────────────────────────────────

function InstanceOutline({
  outline,
  selectedLine,
  onGoToLine,
  onSelectDevice,
  totalDevices,
}: {
  outline: import("../api/analogNetlist").AnalogNetlistGroup[];
  selectedLine?: number;
  onGoToLine: (line: number) => void;
  onSelectDevice: (instanceName: string, cellId: string, line: number) => void;
  totalDevices: number;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggle = (kind: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  };

  // Selected leaf = deepest leaf whose `line <= selectedLine`.
  let selectedLeafId: string | null = null;
  if (selectedLine != null) {
    let bestLine = -1;
    for (const g of outline) {
      for (const leaf of g.leaves) {
        if (leaf.line <= selectedLine && leaf.line > bestLine) {
          bestLine = leaf.line;
          selectedLeafId = leaf.id;
        }
      }
    }
  }

  // Color swatches per device kind
  const kindSwatch: Record<string, string> = {
    mos: "#6dd679",
    bjt_npn: "#82d6a6",
    bjt_pnp: "#f5d68a",
    jfet_n: "#68c4d4",
    jfet_p: "#68c4d4",
    resistor: "#e36854",
    capacitor: "#d4a06a",
    diode: "#c87dc8",
    zener: "#c87dc8",
    schottky: "#c87dc8",
    inductor: "#6aadc8",
    unknown: "#999",
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: "var(--card)",
      }}
    >
      <div className="ph">
        <span
          className="m"
          style={{
            fontSize: 10,
            fontWeight: 600,
            color: "var(--ink2)",
            letterSpacing: 0.6,
          }}
        >
          INSTANCES · {totalDevices}
        </span>
        <span className="m" style={{ fontSize: 8.5, color: "var(--ink3)", display: "block", marginTop: 2 }}>
          double-click to frame on die
        </span>
      </div>
      <div style={{ flex: 1, overflow: "auto" }}>
        {outline.length === 0 ? (
          <div
            style={{
              padding: "16px",
              fontSize: 11,
              color: "var(--ink3)",
              textAlign: "center",
            }}
          >
            no analog devices found
          </div>
        ) : (
          outline.map((g, gi) => {
            const isCollapsed = collapsed.has(g.kind);
            return (
              <div key={g.kind}>
                {gi > 0 && <TreeSep />}
                <TreeRow
                  expand={isCollapsed ? "closed" : "open"}
                  label={g.title}
                  meta={String(g.leaves.length)}
                  onToggleExpand={() => toggle(g.kind)}
                  onSelect={() => toggle(g.kind)}
                />
                {!isCollapsed &&
                  g.leaves.map((leaf) => (
                    <TreeRow
                      key={leaf.id}
                      depth={1}
                      swatch={kindSwatch[leaf.deviceKind] ?? "#666"}
                      label={leaf.label}
                      meta={leaf.meta}
                      monoLabel
                      selected={selectedLeafId === leaf.id}
                      onSelect={() => onGoToLine(leaf.line)}
                      onDoubleClick={() => onSelectDevice(leaf.label, leaf.cellId, leaf.line)}
                    />
                  ))}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

// ── Warnings table ────────────────────────────────────────────────

function ProblemsTable({
  warnings,
  onJump,
}: {
  warnings: string[];
  onJump: (line: number) => void;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div
      style={{
        borderTop: "2px solid var(--l2)",
        background: "var(--panel)",
        flex: "0 0 auto",
        maxHeight: 140,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div className="ph" style={{ cursor: "pointer" }} onClick={() => setOpen((v) => !v)}>
        <span className="u" style={{ color: "var(--warn)", fontSize: 10, display: "flex", alignItems: "center", gap: 4 }}>
          {Ic.chev}
          {warnings.length} {warnings.length === 1 ? "warning" : "warnings"}
        </span>
      </div>
      {open && (
        <div style={{ flex: 1, overflow: "auto", padding: "4px 10px", fontSize: 11 }}>
          {warnings.map((w, i) => (
            <div
              key={i}
              style={{
                padding: "3px 0",
                color: "var(--ink2)",
                borderBottom: "1px solid var(--l1)",
                lineHeight: 1.4,
              }}
            >
              <span style={{ color: "var(--warn)", marginRight: 4 }}>⚠</span>
              {w}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Placeholders ──────────────────────────────────────────────────

function OutlinePlaceholder({ loading }: { loading: boolean }) {
  return (
    <div
      className="m"
      style={{
        padding: "20px 16px",
        color: "var(--ink3)",
        fontSize: 11,
        lineHeight: 1.5,
      }}
    >
      {loading ? "scanning devices…" : "no analog data"}
    </div>
  );
}

function ViewerPlaceholder({
  loading,
  annotationsLoading,
}: {
  loading: boolean;
  annotationsLoading: boolean;
}) {
  let msg = "";
  if (annotationsLoading) msg = "loading annotations…";
  else if (loading) msg = "generating netlist…";
  else msg = "no source";
  return (
    <div
      className="m"
      style={{
        flex: "1 1 auto",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--card)",
        color: "var(--ink3)",
        fontSize: 12,
      }}
    >
      {msg}
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="m"
      style={{
        flex: "1 1 auto",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "var(--ink3)",
        fontSize: 12,
      }}
    >
      {children}
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────

function sanitizeModuleName(name: string): string {
  const s = name.replace(/[^A-Za-z0-9_]/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  if (!s) return "die";
  return /^[0-9]/.test(s) ? `_${s}` : s;
}
