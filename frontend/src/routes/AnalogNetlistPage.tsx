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
import type { SpiceDialect } from "shared";
import { AppShell } from "../components/shell/AppShell";
import { StatusBar } from "../components/shell/StatusBar";
import { SubBar, ToolDivider } from "../components/shell/SubBar";
import { CodeViewer, type CodeViewerHandle } from "../components/code/CodeViewer";
import { TreeRow, TreeSep } from "../components/tree/TreeRow";
import { useDie } from "../api/dies";
import { useAnnotations } from "../api/annotations";
import { useAnnotationsWebSocket } from "../api/annotationsWebSocket";
import { useSession } from "../state/session";
import { useCrossTabSelection } from "../state/crossTabSelection";
import { useAnalogNetlist } from "../api/analogNetlist";
import { Ic } from "../icons";

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
  const setAnalogFocus = useCrossTabSelection((s) => s.setAnalogFocus);

  // Dialect picker state
  const [dialect, setDialect] = useState<SpiceDialect>("cdl");

  // Module name: same convention as the Code page.
  const moduleName = useMemo(
    () => sanitizeModuleName(die?.name ?? dieId),
    [die?.name, dieId],
  );

  const netlist = useAnalogNetlist(annotations, moduleName, dialect);

  // ── UI state ────────────────────────────────────────────────────
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
      setAnalogFocus(instanceName, cellId);
      // Small delay to let the store update before navigation
      setTimeout(() => navigate(`/die/${encodeURIComponent(dieId)}?focusAnalog=1`), 50);
    },
    [dieId, navigate, setAnalogFocus],
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

  // ── Status bar items ────────────────────────────────────────────

  const statusItems = useMemo(() => {
    if (!netlist.data) {
      return [die?.name ?? dieId, netlist.loading ? "generating…" : "—"];
    }
    const { totalDevices, byKind } = netlist.data;
    const kindSummary = Object.entries(byKind)
      .map(([k, n]) => `${n}×${k}`)
      .join(" · ");
    return [
      die?.name ?? dieId,
      `${totalDevices} device${totalDevices === 1 ? "" : "s"}`,
      kindSummary,
      selectedLine ? `L${selectedLine}` : "—",
      dialect.toUpperCase(),
    ];
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
            {/* Dialect picker */}
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
          {netlist.data ? (
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
