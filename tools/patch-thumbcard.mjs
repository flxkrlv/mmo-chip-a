// Surface folder-project status on the library card and add a Relocate action.
// CRLF-safe, idempotent.
import { readFileSync, writeFileSync } from "node:fs";

const file = "frontend/src/components/library/ThumbCard.tsx";
const raw = readFileSync(file, "utf8");
const eol = raw.includes("\r\n") ? "\r\n" : "\n";
let src = raw.replace(/\r\n/g, "\n");

if (src.includes("ProjectLocationBadge")) {
  console.log("already patched — nothing to do");
  process.exit(0);
}

function must(cond, label) {
  if (!cond) {
    console.error("ANCHOR NOT FOUND (" + label + ") — aborting");
    process.exit(1);
  }
}

// 1) imports: add relocate hook + FolderPicker
const importAnchor =
  'import { useDeleteDie, useDieTileInfo, useExportProject, useRenameDie, useTilePrebuildControl } from "../../api/dies";';
must(src.includes(importAnchor), "imports");
src = src.replace(
  importAnchor,
  'import { useDeleteDie, useDieTileInfo, useExportProject, useRelocateProject, useRenameDie, useTilePrebuildControl } from "../../api/dies";\n' +
    'import { FolderPicker } from "./FolderPicker";'
);

// 2) badge under the name line: show location status
const nameAnchor =
  "        <div className=\"m\" style={{ fontSize: 10.5, color: \"var(--ink3)\", marginTop: 3 }}>\n" +
  "          {props.kind === \"die\"\n" +
  "            ? formatPixels(props.die.width, props.die.height)\n" +
  "            : \"preparing import…\"}\n" +
  "        </div>";
must(src.includes(nameAnchor), "name line");
const badgeInsert =
  "\n" +
  '        {props.kind === "die" && (' +
  "\n" +
  "          <ProjectLocationBadge die={props.die} />" +
  "\n" +
  "        )}";
src = src.replace(nameAnchor, nameAnchor + badgeInsert);
// 3) add the badge component + relocate flow at the end of the file
const tail = "\nfunction JobStatusChip";
must(src.includes(tail), "tail anchor");
const badge = `
function ProjectLocationBadge({ die }: { die: DieSummary }) {
  const relocate = useRelocateProject();
  const toast = useToast();
  const [pickerOpen, setPickerOpen] = useState(false);

  const isFolder = die.location === "folder";
  const missing = die.available === false;

  if (!isFolder) return null;

  async function handleRelocate(path: string) {
    try {
      await relocate.mutateAsync({ dieId: die.id, path });
      setPickerOpen(false);
      toast.success("Project relinked", die.name);
    } catch (err) {
      const apiErr = err as { status?: number; body?: { error?: string } };
      if (apiErr?.status === 409) {
        toast.error("Wrong folder", "That folder belongs to a different project");
      } else {
        toast.error("Could not relink project", (err as Error).message);
      }
    }
  }

  return (
    <>
      <div className="m" style={{ fontSize: 10, marginTop: 3, display: "flex", alignItems: "center", gap: 6 }}>
        {missing ? (
          <>
            <span style={{ color: "var(--err, #e66)" }} title={die.folderPath}>folder missing</span>
            <button
              type="button"
              className="btn"
              style={{ padding: "1px 6px", fontSize: 10 }}
              onClick={(event) => { event.stopPropagation(); setPickerOpen(true); }}
            >
              Relocate…
            </button>
          </>
        ) : (
          <span style={{ color: "var(--ink3)" }} title={die.folderPath}>folder project</span>
        )}
      </div>
      {pickerOpen && (
        <FolderPicker
          title="Locate project folder"
          confirmLabel="Relink"
          initialPath={die.folderPath}
          onConfirm={handleRelocate}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </>
  );
}
`;
src = src.replace(tail, badge + tail);

writeFileSync(file, eol === "\r\n" ? src.replace(/\n/g, "\r\n") : src, "utf8");
console.log("patched OK");

