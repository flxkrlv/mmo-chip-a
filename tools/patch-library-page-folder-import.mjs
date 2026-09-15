// LibraryPage: add "import image -> folder" and "Import Project -> folder"
// buttons. They first pick an (empty) folder, then open the file dialog and
// import straight into that folder. Idempotent, CRLF-safe.
import { readFileSync, writeFileSync } from "node:fs";

const file = "frontend/src/routes/LibraryPage.tsx";
const raw = readFileSync(file, "utf8");
const eol = raw.includes("\r\n") ? "\r\n" : "\n";
let src = raw.replace(/\r\n/g, "\n");

if (src.includes("handleImportIntoFolder")) {
  console.log("already patched — nothing to do");
  process.exit(0);
}

function must(cond, label) {
  if (!cond) {
    console.error(`ANCHOR NOT FOUND (${label}) — aborting without writing`);
    process.exit(1);
  }
}

// 1) state: folder-picker "purpose" + hidden inputs for the two folder flows
const stateAnchor = `  const [folderPickerOpen, setFolderPickerOpen] = useState(false);`;
must(src.includes(stateAnchor), "state anchor");
src = src.replace(
  stateAnchor,
  `  const [folderPickerOpen, setFolderPickerOpen] = useState(false);
  // When set, the folder picker is choosing a destination for an import.
  const [importIntoFolder, setImportIntoFolder] = useState<
    "image" | "project" | null
  >(null);
  const pendingFolderRef = useRef<string | null>(null);`
);

// 2) refs for the two extra hidden file inputs
const refAnchor = `  const projectFileInputRef = useRef<HTMLInputElement>(null);`;
must(src.includes(refAnchor), "projectFileInputRef");
src = src.replace(
  refAnchor,
  `${refAnchor}
  const folderImageInputRef = useRef<HTMLInputElement>(null);
  const folderProjectInputRef = useRef<HTMLInputElement>(null);`
);

// 3) handlers: choose folder -> open file dialog -> import with targetFolder
const importClickAnchor = `  function handleImportClick() {
    fileInputRef.current?.click();
  }`;
must(src.includes(importClickAnchor), "handleImportClick");
src = src.replace(
  importClickAnchor,
  `  function handleImportClick() {
    fileInputRef.current?.click();
  }

  function startFolderImport(purpose: "image" | "project") {
    setImportIntoFolder(purpose);
    setFolderPickerOpen(true);
  }

  const handleFolderPickedForImport = useCallback((path: string) => {
    pendingFolderRef.current = path;
    setFolderPickerOpen(false);
    const purpose = importIntoFolder;
    setImportIntoFolder(null);
    if (purpose === "project") folderProjectInputRef.current?.click();
    else folderImageInputRef.current?.click();
  }, [importIntoFolder]);

  async function handleFolderImageChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    const folder = pendingFolderRef.current;
    pendingFolderRef.current = null;
    if (!file || !folder) return;
    try {
      await importMutation.mutateAsync({ file, targetFolder: folder });
    } catch (err) {
      toast.error("Import failed", (err as Error).message);
    }
  }

  const handleFolderProjectChange = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      const folder = pendingFolderRef.current;
      pendingFolderRef.current = null;
      if (!file || !folder) return;
      try {
        const result = await importProjectMutation.mutateAsync({ file, targetFolder: folder });
        navigate(\`/die/\${result.dieId}\`);
      } catch (err: unknown) {
        toast.error("Import failed", (err as Error).message);
      }
    },
    [importProjectMutation, navigate, toast]
  );`
);

// 4) buttons next to the existing import buttons
const imageBtnAnchor = `        <button
          className="btn accent"
          onClick={handleImportClick}
          disabled={importMutation.isPending}
        >
          {Ic.plus} {importMutation.isPending ? "uploading…" : "import image"}
        </button>`;
must(src.includes(imageBtnAnchor), "import image button");
src = src.replace(
  imageBtnAnchor,
  `${imageBtnAnchor}
        <button
          className="btn accent"
          onClick={() => startFolderImport("image")}
          disabled={importMutation.isPending}
          title="Import an image and create a project in a folder you choose"
        >
          {Ic.plus} {"import image → folder"}
        </button>`
);

const projBtnAnchor = `        <button
          className="btn"
          onClick={() => projectFileInputRef.current?.click()}
          disabled={importProjectMutation.isPending}
        >
          {importProjectMutation.isPending ? "importing…" : "Import Project"}
        </button>`;
must(src.includes(projBtnAnchor), "import project button");
src = src.replace(
  projBtnAnchor,
  `${projBtnAnchor}
        <button
          className="btn"
          onClick={() => startFolderImport("project")}
          disabled={importProjectMutation.isPending}
          title="Import a project ZIP into a folder you choose"
        >
          {"Import Project → folder"}
        </button>`
);

// 5) the two extra hidden inputs, next to the existing project input
const projInputAnchor = `        <input
          ref={projectFileInputRef}
          type="file"
          accept=".zip"
          style={{ display: "none" }}
          onChange={handleProjectFileChange}
        />`;
must(src.includes(projInputAnchor), "project input");
src = src.replace(
  projInputAnchor,
  `${projInputAnchor}
        <input
          ref={folderImageInputRef}
          type="file"
          accept="image/png,image/jpeg"
          style={{ display: "none" }}
          onChange={handleFolderImageChange}
        />
        <input
          ref={folderProjectInputRef}
          type="file"
          accept=".zip"
          style={{ display: "none" }}
          onChange={handleFolderProjectChange}
        />`
);

// 6) picker: route onConfirm based on mode
const pickerAnchor = `      {folderPickerOpen && (
        <FolderPicker
          title="Open project folder"
          confirmLabel="Open"
          onConfirm={handleOpenFolder}
          onClose={() => setFolderPickerOpen(false)}
        />
      )}`;
must(src.includes(pickerAnchor), "picker render");
src = src.replace(
  pickerAnchor,
  `      {folderPickerOpen && (
        importIntoFolder ? (
          <FolderPicker
            title="Choose a folder for the new project"
            confirmLabel="Use this folder"
            mode="create"
            onConfirm={handleFolderPickedForImport}
            onClose={() => {
              setFolderPickerOpen(false);
              setImportIntoFolder(null);
            }}
          />
        ) : (
          <FolderPicker
            title="Open project folder"
            confirmLabel="Open"
            onConfirm={handleOpenFolder}
            onClose={() => setFolderPickerOpen(false)}
          />
        )
      )}`
);

writeFileSync(file, eol === "\r\n" ? src.replace(/\n/g, "\r\n") : src, "utf8");
console.log("patched OK");
