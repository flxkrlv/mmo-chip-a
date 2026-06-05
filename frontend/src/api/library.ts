import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { DieSummary, ImportJob, MLInferenceJob } from "shared";
import { dieKeys, useDies } from "./dies";
import { isImportJobActive, useImportJobs } from "./importJobs";
import { useMLInferenceJobs } from "./ml";

const POLL_INTERVAL_MS = 1500;

export type LibraryItem =
  | {
      kind: "die";
      id: string;
      die: DieSummary;
      /** Running inference job for this die, if any (drives the badge). */
      inferenceJob?: MLInferenceJob;
    }
  | { kind: "importing"; id: string; job: ImportJob };

export function useLibraryItems() {
  const qc = useQueryClient();

  const dies = useDies({
    refetchInterval: (query) => {
      const hasTilingDie = query.state.data?.some((d) => d.tileProgress);
      return hasTilingDie ? POLL_INTERVAL_MS : false;
    }
  });
  const jobs = useImportJobs({
    refetchInterval: (query) => {
      const hasActive = query.state.data?.some(isImportJobActive);
      return hasActive ? POLL_INTERVAL_MS : false;
    }
  });
  const inferenceJobs = useMLInferenceJobs({
    refetchInterval: (query) => {
      const hasRunning = query.state.data?.some((j) => j.status === "running");
      return hasRunning ? POLL_INTERVAL_MS : false;
    }
  });

  // When an import job transitions out of the active set (running → completed/failed)
  // the merge below filters it out. The new die may not yet be visible in `/api/dies`
  // because the dies query stops polling without an active tile job. Invalidate dies
  // so the newly-persisted record shows up without waiting for the next manual refresh.
  const prevStatuses = useRef(new Map<string, ImportJob["status"]>());
  useEffect(() => {
    const data = jobs.data;
    if (!data) return;
    let shouldRefreshDies = false;
    for (const job of data) {
      const prev = prevStatuses.current.get(job.id);
      const wasActive = prev === "queued" || prev === "running";
      if (wasActive && !isImportJobActive(job)) {
        shouldRefreshDies = true;
        break;
      }
    }
    prevStatuses.current = new Map(data.map((j) => [j.id, j.status]));
    if (shouldRefreshDies) {
      void qc.invalidateQueries({ queryKey: dieKeys.list() });
    }
  }, [jobs.data, qc]);

  // Only running jobs matter for the badge — keyed by die.
  const runningInference = new Map<string, MLInferenceJob>();
  for (const job of inferenceJobs.data ?? []) {
    if (job.status === "running") runningInference.set(job.dieId, job);
  }

  const items: LibraryItem[] = [];
  const dieIds = new Set<string>();
  for (const die of dies.data ?? []) {
    items.push({
      kind: "die",
      id: die.id,
      die,
      inferenceJob: runningInference.get(die.id)
    });
    dieIds.add(die.id);
  }
  for (const job of jobs.data ?? []) {
    if (!isImportJobActive(job)) continue;
    if (job.dieId && dieIds.has(job.dieId)) continue;
    items.push({ kind: "importing", id: job.id, job });
  }

  items.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "importing" ? -1 : 1;
    if (a.kind === "die" && b.kind === "die") {
      return b.die.updatedAt.localeCompare(a.die.updatedAt);
    }
    if (a.kind === "importing" && b.kind === "importing") {
      return b.job.createdAt.localeCompare(a.job.createdAt);
    }
    return 0;
  });

  return {
    items,
    isLoading: dies.isLoading || jobs.isLoading,
    error: dies.error ?? jobs.error,
    refetch: async () => {
      await Promise.all([dies.refetch(), jobs.refetch()]);
    }
  };
}
