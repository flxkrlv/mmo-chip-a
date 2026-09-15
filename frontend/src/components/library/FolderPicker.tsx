import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { FsEntry } from "shared";
import { useFsBrowse } from "../../api/dies";
import { Ic } from "../../icons";

/**
 * FolderPicker — a server-side directory browser.
 *
 * The app runs locally, so the browser cannot read absolute paths from a
 * native <input type="file">. This modal browses the server's filesystem and
 * returns a chosen absolute directory path to the caller.
 */
export function FolderPicker({
  title,
  confirmLabel,
  initialPath,
  onConfirm,
  onClose
}: {
  title: string;
  confirmLabel: string;
  /** Optional starting directory (e.g. the current location when relocating). */
  initialPath?: string;
  onConfirm: (path: string) => void | Promise<void>;
  onClose: () => void;
}) {
  // null => show drive roots (Windows) / "/" (POSIX)
  const [currentPath, setCurrentPath] = useState<string | null>(initialPath ?? null);
  const browse = useFsBrowse(currentPath, true);
  const [manualPath, setManualPath] = useState(initialPath ?? "");
  const [busy, setBusy] = useState(false);

  // Keep the manual field in sync as the user navigates by clicking.
  useEffect(() => {
    if (browse.data?.path) setManualPath(browse.data.path);
  }, [browse.data?.path]);

  const entries: FsEntry[] = useMemo(() => {
    if (!browse.data) return [];
    if (browse.data.roots) return browse.data.roots;
    return browse.data.directories;
  }, [browse.data]);

  async function confirm(path: string) {
    if (busy || !path.trim()) return;
    setBusy(true);
    try {
      await onConfirm(path.trim());
    } finally {
      setBusy(false);
    }
  }

  return createPortal(
    <div
      className="dark dialog-overlay"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="popover dialog-box"
        style={{ width: "min(640px, 100%)", display: "flex", flexDirection: "column", gap: 10 }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="dialog-title">{title}</div>

        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <button
            className="btn"
            disabled={!browse.data?.parent}
            onClick={() => browse.data?.parent && setCurrentPath(browse.data.parent)}
            title="Parent directory"
          >
            ↑
          </button>
          <button
            className="btn"
            disabled={currentPath === null}
            onClick={() => setCurrentPath(null)}
            title="Drives / roots"
          >
            ⌂
          </button>
          <input
            className="dialog-input"
            style={{ flex: 1, minWidth: 0 }}
            value={manualPath}
            onChange={(e) => setManualPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                setCurrentPath(manualPath.trim() || null);
              }
            }}
            placeholder="Type a path to jump to it…"
            spellCheck={false}
          />
          <button className="btn" onClick={() => setCurrentPath(manualPath.trim() || null)}>
            Go
          </button>
        </div>

        <div
          style={{
            border: "1px solid var(--line, #444)",
            borderRadius: 4,
            height: 280,
            overflow: "auto"
          }}
        >
          {browse.isLoading && (
            <div className="m" style={{ padding: 12, color: "var(--ink3)", fontSize: 11 }}>
              loading…
            </div>
          )}
          {browse.isError && (
            <div className="m" style={{ padding: 12, color: "var(--err, #e66)", fontSize: 11 }}>
              {browse.error.message}
            </div>
          )}
          {browse.data?.error && (
            <div className="m" style={{ padding: 12, color: "var(--err, #e66)", fontSize: 11 }}>
              {browse.data.error}
            </div>
          )}
          {!browse.isLoading && !browse.isError && entries.length === 0 && (
            <div className="m" style={{ padding: 12, color: "var(--ink3)", fontSize: 11 }}>
              no sub-folders
            </div>
          )}
          {entries.map((entry) => (
            <div
              key={entry.path}
              onDoubleClick={() => setCurrentPath(entry.path)}
              onClick={() => setCurrentPath(entry.path)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "6px 10px",
                cursor: "pointer",
                fontSize: 12,
                color: "var(--ink)",
                borderBottom: "1px solid var(--line, #333)"
              }}
              title={entry.path}
            >
              <span style={{ color: "var(--ink3)" }}>{Ic.folder ?? "▸"}</span>
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap"
                }}
              >
                {entry.name}
              </span>
              {entry.isProject && (
                <span className="chip" style={{ fontSize: 9.5 }} title="Existing project folder">
                  project
                </span>
              )}
            </div>
          ))}
        </div>

        <div className="m" style={{ fontSize: 10.5, color: "var(--ink3)", wordBreak: "break-all" }}>
          {browse.data?.path ?? "Select a drive or type a path"}
        </div>

        <div className="dialog-actions">
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn accent"
            onClick={() => confirm(manualPath)}
            disabled={busy || !manualPath.trim()}
            title="Create or open a project in this folder"
          >
            {busy ? "working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
