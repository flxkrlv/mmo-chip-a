/**
 * RnlSchematicPanel — the RNL tab.
 *
 * The drawing is the SPICE+RNL file written by analog-canvas (through the
 * backend, as a separate local process). The viewer is the official MIT RNL
 * web viewer embedded in its canvas-only mode; it receives the text with
 * postMessage, so nothing is fetched from this app and no viewer code is
 * copied here. The text is the artifact the MCP edits.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RnlFormat } from "../../api/rnl";

type SaveState = "idle" | "saving" | "saved" | "error";

const VIEWER_ORIGIN = "https://rich-netlist.github.io";
const VIEWER_URL = `${VIEWER_ORIGIN}/rnl/viewer/?embed=1&names=1&grid=off&background=light`;
const PACKAGE_NAME = "analog-canvas-extensions";

interface Props {
  moduleName: string;
  text: string;
  generating: boolean;
  error: string | null;
  format: RnlFormat;
  canExport: boolean;
  onFormatChange: (format: RnlFormat) => void;
  onTextChange: (text: string) => void;
  onSave: (text: string) => Promise<void>;
  onReload: () => void;
  onOpenSchematic: () => void;
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

export function RnlSchematicPanel({
  moduleName,
  text,
  generating,
  error,
  format,
  canExport,
  onFormatChange,
  onTextChange,
  onSave,
  onReload,
  onOpenSchematic,
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

  const save = useCallback(async () => {
    setSaveState("saving");
    try {
      await onSave(text);
      setSaveState("saved");
      setTimeout(() => setSaveState("idle"), 1200);
    } catch {
      setSaveState("error");
    }
  }, [onSave, text]);

  const download = useCallback(() => {
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${moduleName.replace(/[^\w.-]+/g, "_")}.sp`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }, [moduleName, text]);

  const copy = useCallback(() => {
    void navigator.clipboard?.writeText(text);
  }, [text]);

  const diagnostics = useMemo(
    () => (error ? [{ severity: "error", message: error }] : []),
    [error],
  );

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
          title="The SPICE netlist owns the circuit; RNL comments own the drawing."
          style={{ fontSize: 9 }}
        >
          netlist + drawing
        </span>
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
            canExport
              ? "Netlist dialect of the export: SPICE or Spectre. Changing it exports the schematic again with the same drawing."
              : "Generate the export from the schematic first; then this switches between SPICE and Spectre."
          }
        >
          <span>dialect</span>
          <select
            value={format}
            onChange={(event) => onFormatChange(event.target.value as RnlFormat)}
            disabled={generating || !canExport}
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
          onClick={onReload}
          disabled={generating}
          title="Reload the saved RNL file (for example after an MCP edit)"
        >
          {generating ? "Reloading…" : "Reload"}
        </button>
        <button
          type="button"
          className={"btn sm" + (saveState === "saved" ? " on" : "")}
          onClick={() => void save()}
          disabled={!text.trim() || saveState === "saving"}
          title="Save the RNL text beside the project (MCP tools read this file)"
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
            color: "var(--danger, #d14)",
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

      {text.trim() ? (
        <div style={{ display: "flex", minHeight: 0, flex: 1 }}>
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
