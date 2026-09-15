// Add an "Open folder" button + FolderPicker flow to the library page.
// CRLF-safe, idempotent. Avoids nested template literals to stay valid JS.
import { readFileSync, writeFileSync } from "node:fs";

const file = "frontend/src/routes/LibraryPage.tsx";
const raw = readFileSync(file, "utf8");
const eol = raw.includes("\r\n") ? "\r\n" : "\n";
let src = raw.replace(/\r\n/g, "\n");

if (src.includes("FolderPicker")) {
  console.log("already patched — nothing to do");
  process.exit(0);
}

function must(cond, label) {
  if (!cond) {
    console.error("ANCHOR NOT FOUND (" + label + ") — aborting");
    process.exit(1);
  }
}

// 1) imports
const importAnchor = 'import { useImportDie, useImportProject } from "../api/dies";';
must(src.includes(importAnchor), "imports");
src = src.replace(
  importAnchor,
  'import { useImportDie, useImportProject, useOpenProjectFolder } from "../api/dies";\n' +
    'import { FolderPicker } from "../components/library/FolderPicker";'
);

// 2) state + mutation
const stateAnchor =
  "  const importMutation = useImportDie();\n  const importProjectMutation = useImportProject();";
must(src.includes(stateAnchor), "state");
src = src.replace(
  stateAnchor,
  stateAnchor +
    "\n  const openFolderMutation = useOpenProjectFolder();\n  const [folderPickerOpen, setFolderPickerOpen] = useState(false);"
);

// 3) handler before the main return
const handlerAnchor = "  return (\n    <AppShell>";
must(src.includes(handlerAnchor), "handler anchor");
const handler =
  "  const handleOpenFolder = useCallback(\n" +
  "    async (path: string) => {\n" +
  "      try {\n" +
  "        const result = await openFolderMutation.mutateAsync({ path });\n" +
  "        setFolderPickerOpen(false);\n" +
  "        if (result.renamed) {\n" +
  "          const detail = result.existing\n" +
  '            ? \'Opened "\' + result.name + \'" (id renamed to avoid a clash)\'\n' +
  '            : \'Created "\' + result.name + \'"\';\n' +
  '          toast.success("Project opened", detail);\n' +
  "        }\n" +
  "        navigate('/die/' + result.dieId);\n" +
  "      } catch (err) {\n" +
  '        toast.error("Could not open folder", (err as Error).message);\n' +
  "      }\n" +
  "    },\n" +
  "    [openFolderMutation, navigate, toast]\n" +
  "  );\n\n";
src = src.replace(handlerAnchor, handler + handlerAnchor);

// 4) button before "Import Project"
const buttonAnchor =
  '        <button\n' +
  '          className="btn"\n' +
  '          onClick={() => projectFileInputRef.current?.click()}\n' +
  '          disabled={importProjectMutation.isPending}\n' +
  '        >\n' +
  '          {importProjectMutation.isPending ? "importing…" : "Import Project"}\n' +
  '        </button>';
must(src.includes(buttonAnchor), "button");
const newButton =
  '        <button\n' +
  '          className="btn"\n' +
  '          onClick={() => setFolderPickerOpen(true)}\n' +
  '          disabled={openFolderMutation.isPending}\n' +
  '        >\n' +
  '          {Ic.folderOpen} {openFolderMutation.isPending ? "opening…" : "Open folder"}\n' +
  '        </button>\n';
src = src.replace(buttonAnchor, newButton + buttonAnchor);

// 5) render the picker before </AppShell>
const closeAnchor =
  '      <StatusBar items={buildStatusItems(totals, importMutation.error?.message, transfer)} />\n' +
  '    </AppShell>\n' +
  '  );\n' +
  '}';
must(src.includes(closeAnchor), "picker render");
const withPicker =
  '      <StatusBar items={buildStatusItems(totals, importMutation.error?.message, transfer)} />\n' +
  '      {folderPickerOpen && (\n' +
  '        <FolderPicker\n' +
  '          title="Open project folder"\n' +
  '          confirmLabel="Open"\n' +
  '          onConfirm={handleOpenFolder}\n' +
  '          onClose={() => setFolderPickerOpen(false)}\n' +
  '        />\n' +
  '      )}\n' +
  '    </AppShell>\n' +
  '  );\n' +
  '}';
src = src.replace(closeAnchor, withPicker);

writeFileSync(file, eol === "\r\n" ? src.replace(/\n/g, "\r\n") : src, "utf8");
console.log("patched OK");
