import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryOptions
} from "@tanstack/react-query";
import type { DieMetadata, DieSummary, ImportJob } from "shared";
import { apiDelete, apiGet, apiPost, apiPut, apiUpload, authHeaders } from "./client";
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

  const response = await fetch(`/api/dies/${dieId}/export-project`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ mode, preferences, deviceRegistry, analogNames }),
    signal,
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(err.error || "Export failed");
  }

  const blob = await response.blob();
  const filename = response.headers.get("X-Filename") || `mmochip-${dieId}.zip`;

  return { blob, filename };
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

  return apiUpload<ImportProjectResult>(url, form);
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
