import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryOptions
} from "@tanstack/react-query";
import type { DieMetadata, DieSummary, ImportJob } from "shared";
import { apiDelete, apiGet, apiUpload } from "./client";
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
