// FolderPicker: add a "create" mode used when importing into a new project
// folder (the folder must be empty; validation is enforced server-side).
// Idempotent, CRLF-safe.
import { readFileSync, writeFileSync } from "node:fs";

const file = "frontend/src/components/library/FolderPicker.tsx";
const raw = readFileSync(file, "utf8");
const eol = raw.includes("\r\n") ? "\r\n" : "\n";
let src = raw.replace(/\r\n/g, "\n");

if (src.includes("pickerMode")) {
  console.log("already patched — nothing to do");
  process.exit(0);
}

function must(cond, label) {
  if (!cond) {
    console.error(`ANCHOR NOT FOUND (${label}) — aborting without writing`);
    process.exit(1);
  }
}

// 1) props
const propsAnchor = `export function FolderPicker({
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
}) {`;
must(src.includes(propsAnchor), "props");
src = src.replace(
  propsAnchor,
  `export function FolderPicker({
  title,
  confirmLabel,
  initialPath,
  mode = "open",
  onConfirm,
  onClose
}: {
  title: string;
  confirmLabel: string;
  /** Optional starting directory (e.g. the current location when relocating). */
  initialPath?: string;
  /**
   * "open"   — pick an existing folder (may or may not already be a project).
   * "create" — pick an EMPTY folder to host a brand-new project.
   */
  mode?: "open" | "create";
  onConfirm: (path: string) => void | Promise<void>;
  onClose: () => void;
}) {`
);

// 2) derive pickerMode + a helper warning near the actions
const modeAnchor = `  const entries: FsEntry[] = useMemo(() => {`;
must(src.includes(modeAnchor), "entries memo");
src = src.replace(
  modeAnchor,
  `  const pickerMode: "open" | "create" = mode;
  const selectedIsProject = useMemo(() => {
    if (pickerMode !== "create" || !browse.data?.path) return false;
    return entries.some(
      (entry) => pathEquals(entry.path, browse.data!.path) && entry.isProject
    );
  }, [pickerMode, entries, browse.data?.path]);

${modeAnchor}`
);

// 3) create-mode hint above the actions
const actionsAnchor = `        <div className="dialog-actions">
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>`;
must(src.includes(actionsAnchor), "actions");
src = src.replace(
  actionsAnchor,
  `        {pickerMode === "create" && (
          <div className="m" style={{ fontSize: 10.5, color: selectedIsProject ? "var(--err, #e66)" : "var(--ink3)" }}>
            {selectedIsProject
              ? "This folder is already a project — choosing it will fail. Pick an empty folder."
              : "The project will be created inside this folder. Choose an empty folder."}
          </div>
        )}

${actionsAnchor}`
);

// 4) pathEquals helper (case-insensitive on Windows)
const eofAnchor = `    document.body
  );
}`;
must(src.includes(eofAnchor), "component end");
src = src.replace(
  eofAnchor,
  `    document.body
  );
}

function pathEquals(left: string, right: string): boolean {
  const normalize = (value: string) =>
    value.replace(/[\\\\/]+$/, "").replace(/\\\\/g, "/").toLowerCase();
  return normalize(left) === normalize(right);
}`
);

writeFileSync(file, eol === "\r\n" ? src.replace(/\n/g, "\r\n") : src, "utf8");
console.log("patched OK");
