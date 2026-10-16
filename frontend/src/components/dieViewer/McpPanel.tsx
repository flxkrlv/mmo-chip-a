import { useEffect, useRef, useState, type ReactNode } from "react";
import type { McpHistoryItem, McpWriteMode } from "shared";
import { setMcpSettings, stepMcpHistory, useInvalidateMcp, useMcpStatus } from "../../api/mcp";
import { Ic } from "../../icons";
import { useAuth } from "../../state/auth";

/**
 * Right-panel "MCP" tab: how to connect an MCP client to this die, what it
 * may write here, and the MCP-only undo / redo history. MCP changes never
 * enter the die viewer's Ctrl+Z stack; they are undone here (server-side, so
 * the history survives reloads and is shared by everyone on the die).
 */

const MODES: { mode: McpWriteMode; label: string; hint: string }[] = [
  { mode: "off", label: "Off", hint: "No markup writes. The client can always read the die image and every annotation." },
  {
    mode: "create",
    label: "Create",
    hint: "May also add comments, comment replies, floorplan regions and rulers."
  },
  {
    mode: "edit",
    label: "Create + edit own",
    hint: "May also modify / delete markup it created. Human-made items stay read-only."
  }
];

export function McpPanel({ dieId }: { dieId: string }) {
  const { data: status, error: loadError } = useMcpStatus(dieId);
  const invalidate = useInvalidateMcp(dieId);
  const token = useAuth((s) => s.token);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Reset a stale error when switching dies.
  useEffect(() => setErr(null), [dieId]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      await invalidate();
    }
  };

  if (loadError) return <Note danger>{loadError.message}</Note>;
  if (!status) return <Note>loading…</Note>;

  const url = `${window.location.origin}${status.endpointPath}`;
  const authHeader = token ? `Bearer ${token}` : null;
  const cli =
    `claude mcp add --transport http mmo-chip ${url}` +
    (authHeader ? ` --header "Authorization: ${authHeader}"` : "");
  const json = JSON.stringify(
    {
      mcpServers: {
        "mmo-chip": { type: "http", url, ...(authHeader ? { headers: { Authorization: authHeader } } : {}) }
      }
    },
    null,
    2
  );
  const undo = [...status.undo].reverse();
  const redo = [...status.redo].reverse();

  return (
    <div>
      <SectionHeader>Connect</SectionHeader>
      <div style={{ padding: "8px 12px" }}>
        <CopyRow label="Endpoint (Streamable HTTP)" value={url} />
        <CopyRow label="Claude Code" value={cli} />
        <CopyRow label="Client config JSON" value={json} multiline />
        <Note>
          Claude Desktop: build the extension with <code>npm run mcpb</code>, open <code>dist/mmo-chip.mcpb</code> and
          paste the endpoint above.
        </Note>
        {authHeader && (
          <Note>
            Includes your login token (valid 7 days from login). Anyone with it can act as you on this server.
          </Note>
        )}
      </div>

      <SectionHeader>Write access on this die</SectionHeader>
      <div style={{ padding: "8px 12px" }}>
        <div className="row" style={{ gap: 4, flexWrap: "wrap", marginBottom: 6 }}>
          {MODES.map(({ mode, label }) => (
            <button
              key={mode}
              type="button"
              className={"chip" + (status.mode === mode ? " on" : "")}
              disabled={busy}
              onClick={() => status.mode !== mode && void run(() => setMcpSettings(dieId, { mode }))}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="m" style={{ fontSize: 10.5, color: "var(--ink3)" }}>
          {MODES.find((m) => m.mode === status.mode)?.hint}
        </div>
        <label className="row" style={{ gap: 6, marginTop: 10, fontSize: 11, cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={status.wires}
            disabled={busy}
            onChange={(e) => void run(() => setMcpSettings(dieId, { wires: e.target.checked }))}
          />
          Allow wire edits
        </label>
        <div className="m" style={{ fontSize: 10.5, color: "var(--ink3)", marginTop: 2 }}>
          {status.wires
            ? "Changes the netlist: may add nets and vias, extend or connect into any net (merging nets), and edit or delete only the wires and vias it made."
            : "Wires and vias are read-only."}
        </div>
        <label className="row" style={{ gap: 6, marginTop: 10, fontSize: 11, cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={status.full}
            disabled={busy}
            onChange={(e) => {
              if (
                e.target.checked &&
                !window.confirm(
                  "Allow the MCP client to create, change or delete ANY annotation on this die, including ones people made? Every change can still be undone from this tab."
                )
              ) {
                return;
              }
              void run(() => setMcpSettings(dieId, { full: e.target.checked }));
            }}
          />
          Full edits
        </label>
        <div className="m" style={{ fontSize: 10.5, color: status.full ? "var(--danger, #e36854)" : "var(--ink3)", marginTop: 2 }}>
          {status.full
            ? "Overrides the settings above: any annotation — cells, pins, wires, comments… including human-made ones — may be changed or deleted."
            : "Off: cells, pins, cell types and other human-made items stay read-only."}
        </div>
      </div>

      <SectionHeader>
        <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <span style={{ flex: 1 }}>MCP history</span>
          <button
            type="button"
            className="btn ghost"
            title={undo[0] ? `Undo: ${undo[0].summary}` : "Nothing to undo"}
            disabled={busy || undo.length === 0}
            onClick={() => void run(() => stepMcpHistory(dieId, "undo"))}
          >
            {Ic.undo}
          </button>
          <button
            type="button"
            className="btn ghost"
            title={redo[0] ? `Redo: ${redo[0].summary}` : "Nothing to redo"}
            disabled={busy || redo.length === 0}
            onClick={() => void run(() => stepMcpHistory(dieId, "redo"))}
          >
            {Ic.redo}
          </button>
        </span>
      </SectionHeader>
      {err && <Note danger>{err}</Note>}
      {undo.length === 0 && redo.length === 0 ? (
        <Note>No MCP changes yet. They are listed here, separate from the Ctrl+Z history.</Note>
      ) : (
        <div style={{ padding: "4px 0" }}>
          {redo.map((item) => (
            <HistoryRow key={item.id} item={item} undone />
          ))}
          {undo.map((item) => (
            <HistoryRow key={item.id} item={item} />
          ))}
        </div>
      )}
    </div>
  );
}

function HistoryRow({ item, undone }: { item: McpHistoryItem; undone?: boolean }) {
  return (
    <div
      className="m"
      title={undone ? "Undone — Redo re-applies it" : undefined}
      style={{
        padding: "3px 12px",
        fontSize: 11,
        color: undone ? "var(--ink3)" : "var(--ink)",
        textDecoration: undone ? "line-through" : undefined,
        display: "flex",
        gap: 6
      }}
    >
      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {item.summary}
      </span>
      <span style={{ color: "var(--ink3)", fontSize: 10, whiteSpace: "nowrap" }}>
        {item.clientName ? `${item.clientName} · ` : ""}
        {new Date(item.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
      </span>
    </div>
  );
}

function CopyRow({ label, value, multiline }: { label: string; value: string; multiline?: boolean }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return (
    <div style={{ marginBottom: 8 }}>
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 2 }}>
        <span className="u" style={{ fontSize: 10 }}>{label}</span>
        <button
          type="button"
          className="btn sm plain"
          title={`Copy ${label.toLowerCase()}`}
          style={{ padding: "0 4px", minWidth: 0 }}
          onClick={() => {
            void navigator.clipboard?.writeText(value).then(() => {
              setCopied(true);
              if (timer.current) clearTimeout(timer.current);
              timer.current = setTimeout(() => setCopied(false), 1200);
            });
          }}
        >
          {copied ? "✓" : Ic.copy}
        </button>
      </div>
      <div
        className="m"
        style={{
          fontSize: 10.5,
          color: "var(--ink2)",
          background: "var(--l1)",
          borderRadius: 4,
          padding: "4px 6px",
          whiteSpace: multiline ? "pre" : "nowrap",
          overflow: "auto",
          maxHeight: multiline ? 120 : undefined,
          userSelect: "all"
        }}
      >
        {value}
      </div>
    </div>
  );
}

function SectionHeader({ children }: { children: ReactNode }) {
  return (
    <div style={{ padding: "7px 12px", borderBottom: "1px solid var(--l1)", background: "var(--panel)" }}>
      <span className="u">{children}</span>
    </div>
  );
}

function Note({ children, danger }: { children: ReactNode; danger?: boolean }) {
  return (
    <div
      className="m"
      style={{ padding: "6px 12px", fontSize: 10.5, color: danger ? "var(--danger, #e36854)" : "var(--ink3)" }}
    >
      {children}
    </div>
  );
}
