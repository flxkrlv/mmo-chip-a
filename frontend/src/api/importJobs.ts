import { useQuery, type UseQueryOptions } from "@tanstack/react-query";
import type { ImportJob } from "shared";
import { apiGet } from "./client";

export const importJobKeys = {
  all: ["importJobs"] as const,
  list: () => [...importJobKeys.all, "list"] as const,
  detail: (id: string) => [...importJobKeys.all, "detail", id] as const
};

export function listImportJobs(signal?: AbortSignal): Promise<ImportJob[]> {
  return apiGet<ImportJob[]>("/api/import-jobs", signal);
}

export function isImportJobActive(job: ImportJob): boolean {
  return job.status === "queued" || job.status === "running";
}

type ImportJobsQueryOptions = Omit<
  UseQueryOptions<ImportJob[], Error, ImportJob[], ReturnType<typeof importJobKeys.list>>,
  "queryKey" | "queryFn"
>;

export function useImportJobs(options?: ImportJobsQueryOptions) {
  return useQuery({
    queryKey: importJobKeys.list(),
    queryFn: ({ signal }) => listImportJobs(signal),
    ...options
  });
}
