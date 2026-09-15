// Add folder-project API helpers + hooks to frontend/src/api/dies.ts.
// CRLF-safe, idempotent.
import { readFileSync, writeFileSync } from "node:fs";

const file = "frontend/src/api/dies.ts";
const raw = readFileSync(file, "utf8");
const eol = raw.includes("\r\n") ? "\r\n" : "\n";
let src = raw.replace(/\r\n/g, "\n");

if (src.includes("openProjectFolder")) {
  console.log("already patched — nothing to do");
  process.exit(0);
}

function must(cond, label) {
  if (!cond) {
    console.error(`ANCHOR NOT FOUND (${label}) — aborting`);
    process.exit(1);
  }
}

// extend the shared type import with the folder-project shapes
const importAnchor = `import type { DieMetadata, DieSummary, DieTileInfo, DieTileProgress, ImportJob, OverlayTileProgress } from "shared";`;
must(src.includes(importAnchor), "type import");
src = src.replace(
  importAnchor,
  `import type {
  DieMetadata,
  DieSummary,
  DieTileInfo,
  DieTileProgress,
  FsBrowseResponse,
  ImportJob,
  OpenFolderResponse,
  OverlayTileProgress
} from "shared";`
);

// append the new section before the export/import section marker
const marker = `// ─── Project export / import ────────────────────────────────────────`;
must(src.includes(marker), "export marker");
src = src.replace(
  marker,
  `// ─── Folder projects ────────────────────────────────────────────────

/** Browse the server's filesystem (roots when path is omitted). */
export function browseFs(path: string | undefined, signal?: AbortSignal): Promise<FsBrowseResponse> {
  const query = path ? \`?path=\${encodeURIComponent(path)}\` : "";
  return apiGet<FsBrowseResponse>(\`/api/fs/browse\${query}\`, signal);
}

export function useFsBrowse(path: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ["fs-browse", path ?? "__roots__"],
    queryFn: ({ signal }) => browseFs(path ?? undefined, signal),
    enabled,
    staleTime: 5_000
  });
}

/** Register (or create) a project inside an existing folder. */
export function openProjectFolder(path: string, name?: string): Promise<OpenFolderResponse> {
  return apiPost<OpenFolderResponse>("/api/dies/open-folder", { path, name });
}

export function useOpenProjectFolder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ path, name }: { path: string; name?: string }) => openProjectFolder(path, name),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: dieKeys.list() });
    }
  });
}

/** Point an existing folder project at its new location after a move. */
export function relocateProject(dieId: string, path: string): Promise<{ ok: true; dieId: string; path: string }> {
  return apiPost<{ ok: true; dieId: string; path: string }>(\`/api/dies/\${dieId}/relocate\`, { path });
}

export function useRelocateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ dieId, path }: { dieId: string; path: string }) => relocateProject(dieId, path),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: dieKeys.list() });
    }
  });
}

// ─── Project export / import ────────────────────────────────────────`
);

writeFileSync(file, eol === "\r\n" ? src.replace(/\n/g, "\r\n") : src, "utf8");
console.log("patched OK");
