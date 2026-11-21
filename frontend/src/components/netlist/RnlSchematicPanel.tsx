/**
 * RnlSchematicPanel — the RNL tab.
 *
 * The drawing is the SPICE+RNL (or Spectre+RNL) file written by analog-canvas
 * (through the backend, as a separate local process). The viewer is the
 * official MIT RNL web viewer embedded in its canvas-only mode; it receives
 * the text with postMessage, so nothing is fetched from this app and no viewer
 * code is copied here.
 *
 * The tab shows a saved file, not a live view of the schematic. Under the
 * editor, the history lists every schematic export and every agent/manual
 * edit, with a diff and a rollback. Pinning the snapshot stops a schematic
 * export from replacing the drawing until the user unpins it; an unpinned
 * export still asks before replacing an edited drawing.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  readRnlHistory,
  readRnlRevision,
  restoreRnlRevision,
  setRnlFrozen,
  type RnlAuthor,
  type RnlDiff,
  type RnlFormat,
  type RnlRevisionMeta,
  type RnlSaved,
  type RnlState,
} from "../../api/rnl";

type SaveState = "idle" | "saving" | "saved" | "error";

const VIEWER_ORIGIN = "https://rich-netlist.github.io";
const VIEWER_URL = `${VIEWER_ORIGIN}/rnl/viewer/?embed=1&names=1&grid=off&background=light`;
const PACKAGE_NAME = "analog-canvas-extensions";

interface Props {
  dieId: string;
  moduleName: string;
  text: string;
  generating: boolean;
  error: string | null;
  format: RnlFormat;
  canExport: boolean;
  state: RnlState | null;
  /** Fingerprint of the current analog netlist. */
  sourceHash: string | null;
  /** A 409 from the export endpoint: the drawing has edits. */
  notice: string | null;
  pendingOverwrite: boolean;
  onFormatChange: (format: RnlFormat) => void;
  onTextChange: (text: string) => void;
  onSave: (text: string) => Promise<RnlSaved>;
  onReload: () => Promise<void>;
  onOpenSchematic: () => void;
  onStateChange: (state: RnlState) => void;
  onRestored: (text: string, state: RnlState) => void;
  onConfirmOverwrite: () => void;
  onCancelOverwrite: () => void;
  onRegenerate?: () => void;
}

interface ViewerMessage {
  rnl?: number;
  type?: string;
  requestId?: string;
  name?: string;
  levels?: string[];
  level?: string;
  errors?: number;
  warnings?: number;
  violations?: number;
  features?: string[];
  message?: string;
  reason?: string;
}

/** The viewer picks the dialect from the file name; Spectre files end in .scs. */
function viewerFileName(moduleName: string, text: string): string {
  const spectre = /^\s*simulator\s+lang\s*=\s*spectre/m.test(text);
  return `${moduleName}.${spectre ? "scs" : "sp"}`;
}

function packageVersion(text: string): string {
  return (
    /@USE-PACKAGE\(name="analog-canvas-extensions",\s*version="([^"]+)"\)/.exec(
      text,
    )?.[1] ?? "0.7"
  );
}

/** A compact local time: today shows just the clock. */
function when(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const today = new Date();
  const time = date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  return date.toDateString() === today.toDateString()
    ? time
    : `${date.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

function authorLabel(author: RnlAuthor): string {
  switch (author) {
    case "schematic":
      return "schematic";
    case "agent":
      return "MCP agent";
    case "user":
      return "you";
    case "saved":
      return "existing";
    default:
      return author;
  }
}

function authorStyle(author: RnlAuthor): {
  color: string;
  background: string;
} {
  if (author === "agent")
    return { color: "var(--accent)", background: "var(--accentBg)" };
  if (author === "user") return { color: "var(--ok)", background: "var(--okBg)" };
  if (author === "saved")
    return { color: "var(--warn)", background: "var(--warnBg)" };
  return { color: "var(--ink2)", background: "var(--l1)" };
}

function shorten(id: string | null | undefined): string {
  if (!id) return "—";
  return id.length > 10 ? `…${id.slice(-6)}` : id;
}

export function RnlSchematicPanel({
  dieId,
  moduleName,
  text,
  generating,
  error,
  format,
  canExport,
  state,
  sourceHash,
  notice,
  pendingOverwrite,
  onFormatChange,
  onTextChange,
  onSave,
  onReload,
  onOpenSchematic,
  onStateChange,
  onRestored,
  onConfirmOverwrite,
  onCancelOverwrite,
  onRegenerate,
}: Props) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const fullViewerRef = useRef<{
    window: Window;
    token: string;
    ready: boolean;
  } | null>(null);
  const textRef = useRef(text);
  textRef.current = text;
  const moduleRef = useRef(moduleName);
  moduleRef.current = moduleName;

  const [history, setHistory] = useState<RnlRevisionMeta[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [openRevision, setOpenRevision] = useState<string | null>(null);
  const [detail, setDetail] = useState<{
    id: string;
    diff: RnlDiff;
    text: string;
  } | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  /** Ignores a slower diff response after another row was opened. */
  const detailRequest = useRef(0);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [pinning, setPinning] = useState(false);
  const [serviceError, setServiceError] = useState<string | null>(null);

  /** WebCrypto (package SHA-256) exists only in a secure context. A page
   *  served over HTTP on a LAN address makes the embedded viewer's
   *  `crypto.subtle` undefined, so the full HTTPS viewer is the fallback. */
  const secure = useMemo(
    () => typeof window === "undefined" || window.isSecureContext,
    [],
  );
  const [ready, setReady] = useState(false);
  const viewerUrl = useMemo(() => {
    const url = new URL(VIEWER_URL);
    // The viewer replies only to this exact origin when one is given.
    if (typeof window !== "undefined" && window.location.origin !== "null")
      url.searchParams.set("origin", window.location.origin);
    return url.toString();
  }, []);
  const [viewerError, setViewerError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<{
    levels: string[];
    level: string | null;
    errors: number;
    warnings: number;
    violations: number;
  } | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");

  const sendOpen = useCallback(
    (value: string) => {
      const frame = frameRef.current;
      if (!frame?.contentWindow || !value.trim()) return;
      frame.contentWindow.postMessage(
        {
          rnl: 1,
          type: "open",
          name: viewerFileName(moduleName, value),
          text: value,
          packages: [{ name: PACKAGE_NAME, version: packageVersion(value) }],
        },
        VIEWER_ORIGIN,
      );
    },
    [moduleName],
  );

  const payloadFor = useCallback(
    (value: string, token?: string) => ({
      rnl: 1,
      type: "open",
      ...(token ? { token } : {}),
      name: viewerFileName(moduleRef.current, value),
      text: value,
      requestId: `rnl-${Date.now().toString(36)}`,
      packages: [{ name: PACKAGE_NAME, version: packageVersion(value) }],
    }),
    [],
  );

  const sendFullOpen = useCallback(
    (full: { window: Window; token: string }) => {
      const value = textRef.current;
      if (!value.trim()) return;
      full.window.postMessage(payloadFor(value, full.token), VIEWER_ORIGIN);
    },
    [payloadFor],
  );

  /** Open the complete (not canvas-only) viewer in a top-level HTTPS tab. */
  const openFullViewer = useCallback(() => {
    const existing = fullViewerRef.current;
    if (existing && !existing.window.closed) {
      existing.window.focus();
      // Before its `ready`, the queued open is sent by the message handler.
      if (existing.ready) sendFullOpen(existing);
      return;
    }
    // Math.random, not crypto.randomUUID: the correlation token must also
    // exist on an insecure page, where crypto.randomUUID is unavailable.
    const token = `rnl-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 10)}`;
    const url = new URL(`${VIEWER_ORIGIN}/rnl/viewer/`);
    url.searchParams.set("api", "1");
    url.searchParams.set("origin", window.location.origin);
    url.searchParams.set("token", token);
    const viewer = window.open(url.toString(), "rnl-viewer");
    if (!viewer) {
      setViewerError("Allow pop-ups to open the full RNL viewer.");
      return;
    }
    fullViewerRef.current = { window: viewer, token, ready: false };
  }, [sendFullOpen]);

  useEffect(() => {
    const onMessage = (event: MessageEvent<ViewerMessage & { token?: string }>) => {
      if (event.origin !== VIEWER_ORIGIN) return;
      if (event.data?.rnl !== 1) return;
      const full = fullViewerRef.current;
      const fromFullViewer = full && event.source === full.window;
      const fromFrame = event.source === frameRef.current?.contentWindow;
      if (!fromFullViewer && !fromFrame) return;
      if (fromFullViewer && event.data.token && event.data.token !== full.token)
        return;
      if (event.data.type === "ready") {
        if (fromFullViewer) {
          const features = event.data.features ?? [];
          if (
            !features.includes("requestId") ||
            !features.includes("packages")
          ) {
            setViewerError(
              "This RNL Viewer is too old to import a netlist. Update it and retry.",
            );
            return;
          }
          full.ready = true;
          sendFullOpen(full);
        } else {
          setReady(true);
        }
        return;
      }
      if (event.data.type === "loaded") {
        setLoaded({
          levels: event.data.levels ?? [],
          level: event.data.level ?? null,
          errors: event.data.errors ?? 0,
          warnings: event.data.warnings ?? 0,
          violations: event.data.violations ?? 0,
        });
        setViewerError(null);
        return;
      }
      if (event.data.type === "error") {
        setViewerError(event.data.message ?? "The RNL viewer refused the file");
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [sendFullOpen]);

  useEffect(() => {
    if (ready) sendOpen(text);
  }, [ready, sendOpen]);

  // Follow edits with a short pause; the viewer rebuilds only when asked.
  useEffect(() => {
    if (!ready || !text.trim()) return;
    const timer = setTimeout(() => sendOpen(text), 700);
    return () => clearTimeout(timer);
  }, [ready, sendOpen, text]);

  const refreshHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const result = await readRnlHistory(dieId, moduleName);
      setHistory(result.revisions);
      setHistoryError(null);
      onStateChange(result.state);
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : String(error));
    } finally {
      setHistoryLoading(false);
    }
  }, [dieId, moduleName, onStateChange]);

  useEffect(() => {
    void refreshHistory();
  }, [refreshHistory, state?.latestRevisionId, state?.frozen]);

  useEffect(() => {
    setOpenRevision(null);
    setDetail(null);
    setDetailError(null);
  }, [moduleName]);

  const toggleRevision = useCallback(
    async (revision: RnlRevisionMeta) => {
      const request = ++detailRequest.current;
      if (openRevision === revision.id) {
        setOpenRevision(null);
        setDetailLoading(false);
        return;
      }
      setOpenRevision(revision.id);
      setDetail(null);
      setDetailError(null);
      setDetailLoading(true);
      try {
        const result = await readRnlRevision(dieId, moduleName, revision.id);
        if (detailRequest.current === request)
          setDetail({ id: revision.id, diff: result.diff, text: result.text });
      } catch (error) {
        if (detailRequest.current === request)
          setDetailError(error instanceof Error ? error.message : String(error));
      } finally {
        if (detailRequest.current === request) setDetailLoading(false);
      }
    },
    [dieId, moduleName, openRevision],
  );

  const restore = useCallback(
    async (revisionId: string) => {
      setRestoring(revisionId);
      setServiceError(null);
      try {
        const result = await restoreRnlRevision(dieId, moduleName, revisionId);
        onRestored(result.text, result.state);
        setOpenRevision(null);
        await refreshHistory();
      } catch (error) {
        setServiceError(error instanceof Error ? error.message : String(error));
      } finally {
        setRestoring(null);
      }
    },
    [dieId, moduleName, onRestored, refreshHistory],
  );

  const togglePinned = useCallback(async () => {
    setPinning(true);
    setServiceError(null);
    try {
      const result = await setRnlFrozen(dieId, moduleName, !(state?.frozen ?? false));
      onStateChange(result.state);
      await refreshHistory();
    } catch (error) {
      setServiceError(error instanceof Error ? error.message : String(error));
    } finally {
      setPinning(false);
    }
  }, [dieId, moduleName, onStateChange, refreshHistory, state?.frozen]);

  const save = useCallback(async () => {
    setSaveState("saving");
    try {
      const result = await onSave(text);
      onStateChange(result.state);
      setSaveState("saved");
      await refreshHistory();
      setTimeout(() => setSaveState("idle"), 1200);
    } catch {
      setSaveState("error");
    }
  }, [onSave, onStateChange, refreshHistory, text]);

  const reload = useCallback(async () => {
    setServiceError(null);
    await onReload();
    await refreshHistory();
  }, [onReload, refreshHistory]);

  const download = useCallback(() => {
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = viewerFileName(moduleName.replace(/[^\w.-]+/g, "_"), text);
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }, [format, moduleName, text]);

  const copy = useCallback(() => {
    void navigator.clipboard?.writeText(text);
  }, [text]);

  const diagnostics = useMemo(
    () => (error ? [{ severity: "error", message: error }] : []),
    [error],
  );

  const stale = Boolean(
    state?.sourceHash && sourceHash && state.sourceHash !== sourceHash,
  );
  const stateLabel = !state
    ? "saved drawing"
    : state.revisionCount === 0
      ? "saved drawing · no history yet"
      : state.edited
        ? "edited drawing"
        : "schematic snapshot";

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        height: "100%",
        background: "var(--card)",
      }}
    >
      <div
        className="row"
        style={{
          gap: 6,
          padding: "6px 8px",
          alignItems: "center",
          borderBottom: "1px solid var(--l2)",
          flexWrap: "wrap",
        }}
      >
        <strong style={{ fontSize: 11 }}>RNL · {moduleName}</strong>
        <span
          className="chip"
          title="This tab shows the file saved beside the project, not a live view of the schematic."
          style={{ fontSize: 9 }}
        >
          saved state
        </span>
        <span className="chip" style={{ fontSize: 9 }} title="What the saved file is: the schematic export, or a drawing edited by an agent or by hand.">
          {stateLabel}
        </span>
        {state?.frozen && (
          <span
            className="chip"
            style={{ fontSize: 9, color: "var(--warn)", background: "var(--warnBg)" }}
            title="The snapshot is pinned: a schematic export will not replace it until you unpin it in the history panel."
          >
            pinned
          </span>
        )}
        {stale && (
          <span
            className="chip"
            style={{ fontSize: 9, color: "var(--warn)", background: "var(--warnBg)" }}
            title="The analog netlist changed after this drawing was exported. Regenerate it from the schematic to match."
          >
            may be stale
          </span>
        )}
        {generating && (
          <span className="chip" style={{ fontSize: 9, opacity: 0.8 }}>
            RNL…
          </span>
        )}
        {loaded && (
          <span className="chip" style={{ fontSize: 9 }}>
            {loaded.levels.length} level{loaded.levels.length === 1 ? "" : "s"}
            {loaded.errors > 0 ? ` · ${loaded.errors} error${loaded.errors === 1 ? "" : "s"}` : ""}
            {loaded.warnings > 0 ? ` · ${loaded.warnings} warning${loaded.warnings === 1 ? "" : "s"}` : ""}
            {loaded.violations > 0 ? ` · ${loaded.violations} violation${loaded.violations === 1 ? "" : "s"}` : ""}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <label
          className="chip"
          style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 9 }}
          title={
            state?.frozen
              ? "The snapshot is pinned. Unpin it in the history panel to switch the export dialect."
              : canExport
                ? "Netlist dialect of the export: SPICE or Spectre. Changing it exports the schematic again with the same drawing."
                : "Generate the export from the schematic first; then this switches between SPICE and Spectre."
          }
        >
          <span>dialect</span>
          <select
            value={format}
            onChange={(event) => onFormatChange(event.target.value as RnlFormat)}
            disabled={generating || !canExport || Boolean(state?.frozen)}
            style={{
              font: "inherit",
              fontSize: 9,
              padding: "1px 2px",
              color: "var(--ink)",
              background: "var(--bg)",
              border: "1px solid var(--l2)",
              borderRadius: 4,
            }}
          >
            <option value="spice">SPICE</option>
            <option value="spectre">Spectre</option>
          </select>
        </label>
        <button
          type="button"
          className="btn sm"
          onClick={onOpenSchematic}
          title="Back to the schematic to generate a fresh RNL export"
        >
          Schematic
        </button>
        <button
          type="button"
          className="btn sm"
          onClick={() => void reload()}
          disabled={generating}
          title="Reload the saved RNL file and its history (for example after an MCP edit)"
        >
          {generating ? "Reloading…" : "Reload"}
        </button>
        <button
          type="button"
          className={"btn sm" + (saveState === "saved" ? " on" : "")}
          onClick={() => void save()}
          disabled={!text.trim() || saveState === "saving"}
          title="Save the RNL text beside the project and add a version to the history (MCP tools read this file)"
        >
          {saveState === "saving" ? "Saving…" : saveState === "saved" ? "Saved" : saveState === "error" ? "Save failed" : "Save"}
        </button>
        <button type="button" className="btn sm" onClick={copy} disabled={!text.trim()}>
          Copy
        </button>
        <button
          type="button"
          className="btn sm"
          onClick={openFullViewer}
          disabled={!text.trim()}
          title="Open the complete RNL editor (syntax highlighting, hierarchy, Problems) in a separate HTTPS tab"
        >
          Full viewer ↗
        </button>
        <button type="button" className="btn sm" onClick={download} disabled={!text.trim()}>
          Download
        </button>
      </div>

      {diagnostics.length > 0 && (
        <div
          style={{
            padding: "6px 10px",
            background: "rgba(220, 60, 60, 0.08)",
            color: "var(--err, #d14)",
            fontSize: 10,
            whiteSpace: "pre-wrap",
          }}
        >
          {diagnostics.map((item) => item.message).join("\n")}
        </div>
      )}
      {viewerError && (
        <div
          style={{
            padding: "6px 10px",
            background: "rgba(220, 160, 40, 0.1)",
            color: "var(--warn, #b70)",
            fontSize: 10,
            whiteSpace: "pre-wrap",
          }}
        >
          Viewer: {viewerError}
        </div>
      )}
      {serviceError && (
        <div
          style={{
            padding: "6px 10px",
            background: "var(--errBg)",
            color: "var(--err)",
            fontSize: 10,
            whiteSpace: "pre-wrap",
          }}
        >
          {serviceError}
        </div>
      )}
      {notice && pendingOverwrite && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            flexWrap: "wrap",
            padding: "6px 10px",
            background: "var(--warnBg)",
            color: "var(--warn)",
            fontSize: 10,
          }}
        >
          <span style={{ flex: 1, minWidth: 220 }}>
            {notice} The previous version stays in the history below.
          </span>
          <button type="button" className="btn sm" onClick={onConfirmOverwrite}>
            Overwrite drawing
          </button>
          <button type="button" className="btn sm" onClick={onCancelOverwrite}>
            Cancel
          </button>
        </div>
      )}

      {text.trim() ? (
        <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
          <div style={{ display: "flex", minHeight: 0, flex: "2 1 0" }}>
            <textarea
              value={text}
              onChange={(event) => onTextChange(event.target.value)}
              spellCheck={false}
              style={{
                flex: "0 0 42%",
                minWidth: 260,
                resize: "none",
                border: 0,
                borderRight: "1px solid var(--l1)",
                outline: "none",
                background: "var(--card)",
                color: "var(--ink)",
                fontFamily: "var(--mono, monospace)",
                fontSize: 13,
                lineHeight: 1.55,
                padding: 10,
                tabSize: 2,
              }}
              aria-label="RNL netlist text"
            />
            {secure ? (
              <iframe
                ref={frameRef}
                title="RNL schematic"
                src={viewerUrl}
                style={{ flex: 1, minWidth: 0, border: 0, background: "#fff" }}
                sandbox="allow-scripts allow-same-origin allow-downloads"
              />
            ) : (
              <div
                style={{
                  flex: 1,
                  minWidth: 0,
                  padding: 24,
                  fontSize: 11,
                  lineHeight: 1.6,
                  color: "var(--ink2)",
                  background: "var(--card)",
                }}
              >
                <p style={{ marginTop: 0 }}>
                  The embedded viewer needs a <strong>secure page</strong>{" "}
                  (<code>localhost</code> or HTTPS): it verifies the
                  <code> analog-canvas-extensions</code> package with WebCrypto,
                  and this page is served over plain HTTP. Open the complete
                  viewer in a separate HTTPS tab — it has the same drawing plus
                  the netlist editor, hierarchy and Problems.
                </p>
                <button type="button" className="btn sm" onClick={openFullViewer}>
                  Open full RNL viewer ↗
                </button>
              </div>
            )}
          </div>

          <div
            style={{
              display: "flex",
              flexDirection: "column",
              minHeight: 118,
              flex: "1 1 0",
              borderTop: "1px solid var(--l2)",
              background: "var(--bg)",
            }}
          >
            <div
              className="row"
              style={{
                gap: 6,
                padding: "4px 8px",
                alignItems: "center",
                borderBottom: "1px solid var(--l1)",
                flexWrap: "wrap",
              }}
            >
              <strong style={{ fontSize: 10 }}>RNL MCP change history</strong>
              <span className="chip" style={{ fontSize: 9 }}>
                {history.length} version{history.length === 1 ? "" : "s"}
              </span>
              {state?.latestAt && (
                <span style={{ fontSize: 9, color: "var(--ink3)" }}>
                  latest {when(state.latestAt)}
                </span>
              )}
              <span style={{ flex: 1 }} />
              <label
                className="chip"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                  fontSize: 9,
                  cursor: text.trim() ? "pointer" : "default",
                }}
                title="Fix schematic RNL snapshot: while this is on, regenerating the RNL from the schematic is refused. Agent edits are still allowed. The choice is saved with the project."
              >
                <input
                  type="checkbox"
                  checked={Boolean(state?.frozen)}
                  disabled={pinning || !text.trim()}
                  onChange={() => void togglePinned()}
                />
                Pin snapshot
              </label>
              <button
                type="button"
                className="btn sm"
                onClick={() => void refreshHistory()}
                disabled={historyLoading}
                title="Reload the version list (for example after an MCP edit)"
              >
                {historyLoading ? "…" : "Refresh"}
              </button>
            </div>

            <div
              style={{
                display: "flex",
                gap: 10,
                flexWrap: "wrap",
                padding: "3px 8px",
                borderBottom: "1px solid var(--l1)",
                fontSize: 9,
                color: "var(--ink3)",
              }}
            >
              <span>{state?.format === "spectre" ? "Spectre" : "SPICE"}</span>
              <span>
                {state?.exportedAt
                  ? `exported ${when(state.exportedAt)}`
                  : "no schematic export recorded"}
              </span>
              {state?.sourceHash && (
                <span title="Hash of the analog netlist at the last schematic export">
                  source {state.sourceHash.slice(0, 8)}
                </span>
              )}
              {sourceHash && (
                <span title="Hash of the analog netlist now">
                  now {sourceHash.slice(0, 8)}
                </span>
              )}
              {state?.baselineRevisionId && (
                <span title="Version written by the last schematic export">
                  baseline {shorten(state.baselineRevisionId)}
                </span>
              )}
            </div>

            {stale && (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  flexWrap: "wrap",
                  padding: "4px 8px",
                  background: "var(--warnBg)",
                  color: "var(--warn)",
                  fontSize: 10,
                }}
              >
                <span style={{ flex: 1, minWidth: 200 }}>
                  The analog netlist changed after this drawing was exported.
                  The drawing is still the saved version; regenerating it
                  replaces the drawing (the current version stays in history).
                </span>
                {!state?.frozen && onRegenerate ? (
                  <button type="button" className="btn sm" onClick={onRegenerate}>
                    Regenerate
                  </button>
                ) : (
                  <span style={{ fontSize: 9 }}>
                    {state?.frozen
                      ? "Unpin the snapshot to regenerate."
                      : "Use Schematic → RNL to regenerate."}
                  </span>
                )}
              </div>
            )}

            <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
              {historyLoading && history.length === 0 ? (
                <div style={emptyHistoryStyle}>Loading versions…</div>
              ) : historyError ? (
                <div style={{ ...emptyHistoryStyle, color: "var(--err)" }}>
                  {historyError}
                </div>
              ) : history.length === 0 ? (
                <div style={emptyHistoryStyle}>
                  No versions yet. The first schematic export starts the
                  history; every agent or manual save adds a version here, and
                  any version can be restored.
                </div>
              ) : (
                history.map((revision) => {
                  const open = openRevision === revision.id;
                  const isCurrent = revision.id === state?.latestRevisionId;
                  const isBaseline = revision.id === state?.baselineRevisionId;
                  const showDetail = detail?.id === revision.id;
                  return (
                    <div
                      key={revision.id}
                      style={{ borderBottom: "1px solid var(--l1)" }}
                    >
                      <div
                        className="row"
                        style={{
                          gap: 6,
                          padding: "3px 8px",
                          alignItems: "center",
                          cursor: "pointer",
                          fontSize: 10,
                        }}
                        onClick={() => void toggleRevision(revision)}
                        title="Show this version's diff"
                      >
                        <span style={{ width: 8, color: "var(--ink3)" }}>
                          {open ? "▾" : "▸"}
                        </span>
                        <span
                          style={{
                            color: "var(--ink3)",
                            fontVariantNumeric: "tabular-nums",
                          }}
                        >
                          {when(revision.at)}
                        </span>
                        <span
                          className="chip"
                          style={{ fontSize: 8, ...authorStyle(revision.author) }}
                        >
                          {authorLabel(revision.author)}
                        </span>
                        {revision.restores && (
                          <span
                            className="chip"
                            style={{ fontSize: 8, color: "var(--warn)", background: "var(--warnBg)" }}
                            title={`This version restored ${revision.restores}`}
                          >
                            rollback
                          </span>
                        )}
                        {isCurrent && (
                          <span className="chip" style={{ fontSize: 8 }}>
                            current
                          </span>
                        )}
                        {isBaseline && !isCurrent && (
                          <span className="chip" style={{ fontSize: 8 }}>
                            schematic
                          </span>
                        )}
                        <span
                          style={{
                            flex: 1,
                            minWidth: 60,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                            color: "var(--ink2)",
                          }}
                        >
                          {revision.note}
                        </span>
                        {revision.baseRevisionId ? (
                          <>
                            <span style={{ color: "var(--ok)" }}>
                              +{revision.added}
                            </span>
                            <span style={{ color: "var(--err)" }}>
                              −{revision.removed}
                            </span>
                          </>
                        ) : (
                          <span style={{ color: "var(--ink3)" }}>initial</span>
                        )}
                      </div>
                      {open && (
                        <div
                          style={{
                            padding: "3px 8px 6px 24px",
                            borderTop: "1px solid var(--l1)",
                            background: "var(--panel)",
                          }}
                        >
                          {detailLoading && !showDetail ? (
                            <div style={{ fontSize: 10, color: "var(--ink3)" }}>
                              Loading diff…
                            </div>
                          ) : detailError ? (
                            <div style={{ fontSize: 10, color: "var(--err)" }}>
                              {detailError}
                            </div>
                          ) : showDetail ? (
                            <>
                              <div
                                className="row"
                                style={{
                                  gap: 8,
                                  alignItems: "center",
                                  marginBottom: 3,
                                  fontSize: 9,
                                  color: "var(--ink3)",
                                }}
                              >
                                <span>
                                  {revision.baseRevisionId
                                    ? `+${detail.diff.added} −${detail.diff.removed} · `
                                    : "initial version · "}
                                  {revision.lines} lines · {revision.bytes} bytes
                                </span>
                                <span style={{ flex: 1 }} />
                                {!isCurrent && (
                                  <button
                                    type="button"
                                    className="btn sm"
                                    disabled={restoring === revision.id}
                                    onClick={() => void restore(revision.id)}
                                    title="Make this version the current drawing. It is saved as a new version, so the current one stays in the history."
                                  >
                                    {restoring === revision.id
                                      ? "Restoring…"
                                      : "Restore this version"}
                                  </button>
                                )}
                              </div>
                              {detail.diff.lines.length === 0 ? (
                                <div style={{ fontSize: 10, color: "var(--ink3)" }}>
                                  No textual change.
                                </div>
                              ) : (
                                <div
                                  style={{
                                    maxHeight: 150,
                                    overflow: "auto",
                                    border: "1px solid var(--l2)",
                                    borderRadius: 4,
                                    background: "var(--card)",
                                    fontFamily: "var(--mono, monospace)",
                                    fontSize: 10,
                                    lineHeight: 1.4,
                                  }}
                                >
                                  {detail.diff.lines.map((line, index) => {
                                    // An adopted first version has nothing to
                                    // compare with: show it as plain text
                                    // instead of a wall of additions.
                                    const type = revision.baseRevisionId
                                      ? line.type
                                      : "context";
                                    return (
                                      <div
                                        key={index}
                                        style={{
                                          padding: "0 6px",
                                          whiteSpace: "pre-wrap",
                                          color:
                                            type === "add"
                                              ? "var(--ok)"
                                              : type === "remove"
                                                ? "var(--err)"
                                                : "var(--ink2)",
                                          background:
                                            type === "add"
                                              ? "var(--okBg)"
                                              : type === "remove"
                                                ? "var(--errBg)"
                                                : "transparent",
                                        }}
                                      >
                                        {type === "add"
                                          ? "+ "
                                          : type === "remove"
                                            ? "- "
                                            : "  "}
                                        {line.text}
                                      </div>
                                    );
                                  })}
                                </div>
                              )}
                            </>
                          ) : null}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      ) : (
        <div
          style={{
            padding: 24,
            fontSize: 11,
            color: "var(--ink2)",
            lineHeight: 1.6,
            maxWidth: 620,
          }}
        >
          {generating ? (
            <p style={{ marginTop: 0 }}>
              Writing SPICE+RNL for <strong>{moduleName}</strong>…
            </p>
          ) : (
            <>
              <p style={{ marginTop: 0 }}>
                No RNL file yet for <strong>{moduleName}</strong>.
              </p>
              <p>
                Open the <strong>Schematic</strong> tab and press <strong>RNL</strong> in
                the canvas toolbar. The backend writes the analog-canvas project, asks
                the external analog-canvas MCP for <code>netlist_code rnl:true</code>, and
                stores the SPICE+RNL text beside the project.
              </p>
              <p>
                The saved file is a snapshot: a later schematic export can replace
                it, but the tab warns first and keeps every version in the history
                below. Pin the snapshot to block regeneration entirely.
              </p>
              <p style={{ fontSize: 10, color: "var(--ink3, var(--ink2))" }}>
                Requires <code>CHIPTOOL_ANALOG_CANVAS_MCP</code> and{" "}
                <code>CHIPTOOL_ANALOG_CANVAS_HEADLESS</code> on the backend.
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}

const emptyHistoryStyle: CSSProperties = {
  padding: "6px 10px",
  fontSize: 10,
  lineHeight: 1.5,
  color: "var(--ink3)",
  maxWidth: 760,
};
