import { apiGet, apiPost, apiPut } from "./client";

export type RnlFormat = "spice" | "spectre";
export type RnlAuthor = "schematic" | "agent" | "user" | "saved" | "system";

export interface RnlRevisionMeta {
  id: string;
  at: string;
  author: RnlAuthor;
  note: string;
  format: RnlFormat;
  bytes: number;
  lines: number;
  added: number;
  removed: number;
  baseRevisionId: string | null;
  restores: string | null;
  sourceHash: string | null;
  unchanged: boolean;
}

export interface RnlState {
  version: 1;
  moduleName: string;
  format: RnlFormat;
  frozen: boolean;
  sourceHash: string | null;
  exportedAt: string | null;
  baselineRevisionId: string | null;
  latestRevisionId: string | null;
  latestAuthor: RnlAuthor | null;
  latestAt: string | null;
  updatedAt: string;
  revisionCount: number;
  edited: boolean;
}

export interface RnlDiffLine {
  type: "context" | "add" | "remove";
  text: string;
}

export interface RnlDiff {
  added: number;
  removed: number;
  lines: RnlDiffLine[];
}

export interface RnlExportResult {
  ok: true;
  moduleName: string;
  text: string;
  format: RnlFormat;
  diagnostics: Array<{ severity?: string; code?: string; message?: string }>;
  documentId?: string;
  status: string;
  state: RnlState;
  revision: RnlRevisionMeta | null;
}

export interface RnlExportOptions {
  /** Fingerprint of the analog netlist the project was built from. */
  sourceHash?: string | null;
  /** The user accepted replacing an edited drawing. */
  confirmOverwrite?: boolean;
}

/** Ask the backend to write the current analog-canvas project as SPICE/Spectre+RNL. */
export function exportRnl(
  dieId: string,
  project: unknown,
  moduleName: string,
  format: RnlFormat = "spice",
  options: RnlExportOptions = {},
): Promise<RnlExportResult> {
  return apiPost<RnlExportResult>(
    `/api/dies/${encodeURIComponent(dieId)}/rnl/export`,
    {
      project,
      moduleName,
      format,
      sourceHash: options.sourceHash ?? null,
      ...(options.confirmOverwrite ? { confirmOverwrite: true } : {}),
    },
  );
}

export interface RnlSaved {
  ok: true;
  moduleName: string;
  text: string;
  state: RnlState;
  revision: RnlRevisionMeta | null;
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
  note?: string,
): Promise<RnlSaved> {
  return apiPut<RnlSaved>(`/api/dies/${encodeURIComponent(dieId)}/rnl`, {
    moduleName,
    text,
    ...(note ? { note } : {}),
  });
}

export interface RnlHistoryResult {
  ok: true;
  moduleName: string;
  exists: boolean;
  state: RnlState;
  revisions: RnlRevisionMeta[];
}

export function readRnlHistory(
  dieId: string,
  moduleName: string,
): Promise<RnlHistoryResult> {
  return apiGet<RnlHistoryResult>(
    `/api/dies/${encodeURIComponent(dieId)}/rnl/history?moduleName=${encodeURIComponent(moduleName)}`,
  );
}

export interface RnlRevisionDetail {
  ok: true;
  moduleName: string;
  revision: RnlRevisionMeta;
  text: string;
  diff: RnlDiff;
}

export function readRnlRevision(
  dieId: string,
  moduleName: string,
  revisionId: string,
): Promise<RnlRevisionDetail> {
  return apiGet<RnlRevisionDetail>(
    `/api/dies/${encodeURIComponent(dieId)}/rnl/history/${encodeURIComponent(revisionId)}?moduleName=${encodeURIComponent(moduleName)}`,
  );
}

export function restoreRnlRevision(
  dieId: string,
  moduleName: string,
  revisionId: string,
): Promise<RnlSaved> {
  return apiPost<RnlSaved>(
    `/api/dies/${encodeURIComponent(dieId)}/rnl/history/${encodeURIComponent(revisionId)}/restore`,
    { moduleName },
  );
}

export function setRnlFrozen(
  dieId: string,
  moduleName: string,
  frozen: boolean,
): Promise<{ ok: true; moduleName: string; state: RnlState }> {
  return apiPut(`/api/dies/${encodeURIComponent(dieId)}/rnl/state`, {
    moduleName,
    frozen,
  });
}
