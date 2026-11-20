import { apiGet, apiPost, apiPut } from "./client";

export interface RnlExportResult {
  ok: true;
  moduleName: string;
  text: string;
  format: "spice" | "spectre";
  diagnostics: Array<{ severity?: string; code?: string; message?: string }>;
  documentId?: string;
  status: string;
}

/** Ask the backend to write the current analog-canvas project as SPICE+RNL. */
export function exportRnl(
  dieId: string,
  project: unknown,
  moduleName: string,
  format: "spice" | "spectre" = "spice",
): Promise<RnlExportResult> {
  return apiPost<RnlExportResult>(
    `/api/dies/${encodeURIComponent(dieId)}/rnl/export`,
    { project, moduleName, format },
  );
}

export interface RnlSaved {
  ok: true;
  moduleName: string;
  text: string;
}

export function readRnl(dieId: string, moduleName: string): Promise<RnlSaved> {
  return apiGet<RnlSaved>(
    `/api/dies/${encodeURIComponent(dieId)}/rnl?moduleName=${encodeURIComponent(moduleName)}`,
  );
}

export function saveRnl(
  dieId: string,
  moduleName: string,
  text: string,
): Promise<{ ok: true; moduleName: string; file: string }> {
  return apiPut(`/api/dies/${encodeURIComponent(dieId)}/rnl`, {
    moduleName,
    text,
  });
}
