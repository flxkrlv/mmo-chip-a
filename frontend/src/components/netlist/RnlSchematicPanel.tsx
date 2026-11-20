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

type SaveState = "idle" | "saving" | "saved" | "error";

const VIEWER_ORIGIN = "https://rich-netlist.github.io";
const VIEWER_URL = `${VIEWER_ORIGIN}/rnl/viewer/?embed=1&names=1&grid=off&background=light`;
const PACKAGE_NAME = "analog-canvas-extensions";

interface Props {
  moduleName: string;
  text: string;
  generating: boolean;
  error: string | null;
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
  message?: string;
  reason?: string;
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
  onTextChange,
  onSave,
  onReload,
  onOpenSchematic,
}: Props) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
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
          name: `${moduleName}.sp`,
          text: value,
          packages: [{ name: PACKAGE_NAME, version: packageVersion(value) }],
        },
        VIEWER_ORIGIN,
      );
    },
    [moduleName],
  );

  useEffect(() => {
    const onMessage = (event: MessageEvent<ViewerMessage>) => {
      if (event.origin !== VIEWER_ORIGIN) return;
      if (event.source !== frameRef.current?.contentWindow) return;
      if (event.data?.rnl !== 1) return;
      if (event.data.type === "ready") {
        setReady(true);
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
  }, []);

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
              borderRight: "1px solid var(--l2)",
              outline: "none",
              background: "var(--l0, #11151b)",
              color: "var(--ink, #d8e0ea)",
              fontFamily: "var(--mono, monospace)",
              fontSize: 10,
              lineHeight: 1.45,
              padding: 8,
              tabSize: 2,
            }}
            aria-label="RNL netlist text"
          />
          <iframe
            ref={frameRef}
            title="RNL schematic"
            src={viewerUrl}
            style={{ flex: 1, minWidth: 0, border: 0, background: "#fff" }}
            sandbox="allow-scripts allow-same-origin allow-downloads"
          />
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
