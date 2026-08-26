import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryOptions
} from "@tanstack/react-query";
import type { DieMetadata, DieSummary, ImportJob } from "shared";
import { ApiError, apiDelete, apiGet, apiPost, apiPut, apiUpload, authHeaders } from "./client";
import { useProjectTransfer } from "../state/projectTransfer";
import { importJobKeys } from "./importJobs";
import { usePreferences } from "../state/preferences";

export const dieKeys = {
  all: ["dies"] as const,
  list: () => [...dieKeys.all, "list"] as const,
  detail: (id: string) => [...dieKeys.all, "detail", id] as const
};

export function listDies(signal?: AbortSignal): Promise<DieSummary[]> {
  return apiGet<DieSummary[]>("/api/dies", signal);
}

export function getDie(dieId: string, signal?: AbortSignal): Promise<DieMetadata> {
  return apiGet<DieMetadata>(`/api/dies/${dieId}`, signal);
}

type DieQueryOptions = Omit<
  UseQueryOptions<DieMetadata, Error, DieMetadata, ReturnType<typeof dieKeys.detail>>,
  "queryKey" | "queryFn"
>;

export function useDie(dieId: string | undefined, options?: DieQueryOptions) {
  return useQuery({
    queryKey: dieKeys.detail(dieId ?? ""),
    queryFn: ({ signal }) => getDie(dieId!, signal),
    enabled: !!dieId,
    ...options
  });
}

export function importDie(file: File): Promise<ImportJob> {
  const form = new FormData();
  form.append("file", file);
  return apiUpload<ImportJob>("/api/dies/import", form);
}

export function deleteDie(dieId: string): Promise<{ ok: true }> {
  return apiDelete<{ ok: true }>(`/api/dies/${dieId}`);
}

type DiesQueryOptions = Omit<
  UseQueryOptions<DieSummary[], Error, DieSummary[], ReturnType<typeof dieKeys.list>>,
  "queryKey" | "queryFn"
>;

export function useDies(options?: DiesQueryOptions) {
  return useQuery({
    queryKey: dieKeys.list(),
    queryFn: ({ signal }) => listDies(signal),
    ...options
  });
}

export function useImportDie() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: importDie,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: dieKeys.list() });
      void qc.invalidateQueries({ queryKey: importJobKeys.list() });
    }
  });
}

export function useDeleteDie() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: deleteDie,
    onSuccess: (_data, dieId) => {
      void qc.invalidateQueries({ queryKey: dieKeys.list() });
      // Drop any saved viewport so its localStorage entry doesn't leak.
      usePreferences.getState().clearSavedViewport(dieId);
    }
  });
}

// ─── Rename ─────────────────────────────────────────────────────────

export async function renameDie(dieId: string, name: string): Promise<{ ok: true; name: string }> {
  return apiPut(`/api/dies/${dieId}/rename`, { name });
}

export function useRenameDie() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ dieId, name }: { dieId: string; name: string }) => renameDie(dieId, name),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: dieKeys.list() });
    }
  });
}

// ─── Project export / import ────────────────────────────────────────

export interface ExportProjectResult {
  blob: Blob;
  filename: string;
}

/**
 * Export a die project as a ZIP bundle.
 * mode: "light" | "full"
 * includePreferences: if true, reads mmo-chip-preferences from localStorage and embeds it
 */
export async function exportProject(
  dieId: string,
  mode: "light" | "full",
  includePreferences: boolean,
  signal?: AbortSignal
): Promise<ExportProjectResult> {
  const preferences =
    includePreferences ? localStorage.getItem("mmo-chip-preferences") : null;
  const deviceRegistry = localStorage.getItem("mmo-chip-device-registry");
  const analogNames = localStorage.getItem("mmo-chip-analog-names");
  const transfer = useProjectTransfer.getState();
  transfer.start("export", "Подготовка ZIP-архива…");

  return new Promise<ExportProjectResult>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", `/api/dies/${dieId}/export-project`);
    request.responseType = "blob";
    request.setRequestHeader("Content-Type", "application/json");
    for (const [name, value] of Object.entries(authHeaders())) request.setRequestHeader(name, value);

    const abort = () => request.abort();
    signal?.addEventListener("abort", abort, { once: true });
    request.onprogress = (event) => {
      transfer.update({
        phase: "Скачивание ZIP-архива…",
        loaded: event.loaded,
        total: event.lengthComputable ? event.total : null
      });
    };
    request.onerror = () => {
      const error = new Error("Export failed: network error");
      transfer.fail(error.message);
      reject(error);
    };
    request.onabort = () => {
      const error = new DOMException("Export cancelled", "AbortError");
      transfer.fail("Экспорт отменён");
      reject(error);
    };
    request.onload = () => {
      signal?.removeEventListener("abort", abort);
      if (request.status < 200 || request.status >= 300) {
        // responseType is "blob" for a successful ZIP download, so responseText is
        // unavailable here. Preserve the HTTP status without attempting to read it.
        const error = new ApiError(request.status, request.statusText || `HTTP ${request.status}`, null);
        transfer.fail(error.message);
        reject(error);
        return;
      }
      transfer.complete("ZIP-архив готов");
      resolve({
        blob: request.response,
        filename: request.getResponseHeader("X-Filename") || `mmochip-${dieId}.zip`
      });
    };
    request.send(JSON.stringify({ mode, preferences, deviceRegistry, analogNames }));
  });
}

export interface ImportProjectResult {
  ok: boolean;
  dieId: string;
  preferences: string | null;
  deviceRegistry: string | null;
  analogNames: string | null;
}

/**
 * Import a project ZIP bundle.
 * Returns { ok, dieId, preferences }.
 * On conflict (409) the error object has { error: "die_already_exists", dieId, name }.
 * Pass ?name=xxx to import as a copy on conflict. Also available as second arg.
 */
export async function importProject(
  file: File,
  renameTo?: string
): Promise<ImportProjectResult> {
  const form = new FormData();
  form.append("file", file);

  let url = "/api/dies/import-project";
  if (renameTo) url += `?name=${encodeURIComponent(renameTo)}`;

  const transfer = useProjectTransfer.getState();
  transfer.start("import", "Загрузка ZIP-архива…", file.size);

  return new Promise<ImportProjectResult>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", url);
    for (const [name, value] of Object.entries(authHeaders())) request.setRequestHeader(name, value);

    request.upload.onprogress = (event) => {
      transfer.update({
        phase: "Загрузка ZIP-архива…",
        loaded: event.loaded,
        total: event.lengthComputable ? event.total : file.size
      });
    };
    request.upload.onload = () => {
      // The server now validates and extracts the archive sequentially. Its duration depends on
      // disk speed and image count, so keep the lower-bar indicator indeterminate instead of
      // displaying a misleading completed percentage while this work is still in progress.
      transfer.update({ phase: "Проверка и распаковка архива на сервере…", loaded: 0, total: null });
    };
    request.onerror = () => {
      const error = new Error("Import failed: network error");
      transfer.fail(error.message);
      reject(error);
    };
    request.onabort = () => {
      const error = new DOMException("Import cancelled", "AbortError");
      transfer.fail("Импорт отменён");
      reject(error);
    };
    request.onload = () => {
      if (request.status < 200 || request.status >= 300) {
        const error = responseError(request.status, request.statusText, request.responseText);
        transfer.fail(error.message);
        reject(error);
        return;
      }
      try {
        const result = JSON.parse(request.responseText) as ImportProjectResult;
        transfer.complete("Импорт завершён");
        resolve(result);
      } catch {
        const error = new Error("Import failed: invalid server response");
        transfer.fail(error.message);
        reject(error);
      }
    };
    request.send(form);
  });
}

function responseError(status: number, statusText: string, responseText: string): ApiError {
  let body: unknown = null;
  try {
    body = responseText ? JSON.parse(responseText) : null;
  } catch {
    body = responseText;
  }
  const message =
    body && typeof body === "object" && "error" in body && typeof body.error === "string"
      ? body.error
      : statusText || `HTTP ${status}`;
  return new ApiError(status, message, body);
}

export function useExportProject() {
  return useMutation({
    mutationFn: async ({
      dieId,
      mode,
      includePreferences
    }: {
      dieId: string;
      mode: "light" | "full";
      includePreferences: boolean;
    }) => {
      return exportProject(dieId, mode, includePreferences);
    }
  });
}

export function useImportProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      file,
      renameTo
    }: {
      file: File;
      renameTo?: string;
    }) => {
      return importProject(file, renameTo);
    },
    onSuccess: (result) => {
      void qc.invalidateQueries({ queryKey: dieKeys.list() });
      // If preferences were embedded in the bundle, restore them.
      if (result.preferences) {
        try {
          localStorage.setItem("mmo-chip-preferences", result.preferences);
        } catch {
          // localStorage might be full — silently ignore
        }
      }
      // Restore device registry (instance names, overrides, identity).
      if (result.deviceRegistry) {
        try {
          localStorage.setItem("mmo-chip-device-registry", result.deviceRegistry);
        } catch {
          // silently ignore
        }
      }
      // Restore legacy analog name map.
      if (result.analogNames) {
        try {
          localStorage.setItem("mmo-chip-analog-names", result.analogNames);
        } catch {
          // silently ignore
        }
      }
    }
  });
}
