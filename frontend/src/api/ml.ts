import { useEffect } from "react";
import {
  useQuery,
  useQueryClient,
  type UseQueryOptions,
  type UseQueryResult
} from "@tanstack/react-query";
import type {
  AKAZEReverifyRequest,
  AKAZEReverifyResponse,
  AKAZEDebugResponse,
  CVDebugData,
  CVMatchRequest,
  CVMatchResponse,
  MLExportRequest,
  MLInferenceJob,
  MLModelsResponse,
  MLPrediction,
  MLSelectModelRequest,
  MLServiceStatus
} from "shared";
import { subscribeToDie } from "./annotationsWebSocket";
import { ApiError, apiGet, apiPost } from "./client";

/**
 * Kick off the backend ML training-data export for a die. The backend crops
 * every ROI and writes its per-ROI image + label JSON (sized by the die's
 * `mlConfig`, falling back to `approxViaRadiusPx`).
 *
 * The job is fire-and-forget server-side: this resolves once it's *scheduled*
 * (HTTP 202), not when the files are written — progress shows in server logs.
 */
export function exportMlData(
  dieId: string,
  approxViaRadiusPx: number,
  overlayFilename?: string
): Promise<{ ok: true }> {
  const body: MLExportRequest = { approxViaRadiusPx, overlayFilename };
  return apiPost<{ ok: true }>(`/api/dies/${dieId}/ml-export`, body);
}

// ── ML via predictions ───────────────────────────────────────────────

export type DieViasBbox = readonly [number, number, number, number];

export interface UseDieViasOptions {
  /** Peak heatmap probability above which a point counts as a via. Server
   *  default is 0.5; raise to suppress weak detections. */
  threshold?: number;
  /** Min spacing (px) between accepted peaks (server default 4). */
  minDistance?: number;
  /** Skip the fetch (useful when the user has the overlay turned off). */
  enabled?: boolean;
  /** Overlay filename to run inference on, instead of base image. */
  overlaySource?: string;
}

/**
 * ML via predictions for a die bbox in source-image (px) coords. Hits the
 * **uncached** `GET /api/dies/:dieId/vias?bbox=…` endpoint — every server
 * call triggers a fresh inference run — so the client caches aggressively:
 * results are keyed by `(dieId, bbox, threshold, minDistance, overlaySource)` and reused
 * across the session. Pass `enabled: false` to silence the request entirely
 * while the user has the overlay toggled off.
 *
 * Returns `null` data when disabled or when the inputs aren't ready. The
 * server returns 503 if the ML sidecar is unreachable — let callers surface
 * that themselves rather than retrying to death.
 */
export function useDieVias(
  dieId: string | null,
  bbox: DieViasBbox | null,
  options: UseDieViasOptions = {}
): UseQueryResult<MLPrediction | null, ApiError> {
  const { threshold, minDistance, enabled = true, overlaySource } = options;
  return useQuery<MLPrediction | null, ApiError>({
    queryKey: [
      "dieVias",
      dieId,
      bbox,
      threshold ?? null,
      minDistance ?? null,
      overlaySource ?? null
    ] as const,
    queryFn: async ({ signal }) => {
      if (!dieId || !bbox) return null;
      const params = new URLSearchParams();
      params.set("bbox", bbox.join(","));
      if (threshold != null) params.set("threshold", String(threshold));
      if (minDistance != null) params.set("min_distance", String(minDistance));
      if (overlaySource) params.set("overlaySource", overlaySource);
      return apiGet<MLPrediction>(
        `/api/dies/${dieId}/vias?${params.toString()}`,
        signal
      );
    },
    enabled: enabled && !!dieId && !!bbox,
    staleTime: 5 * 60_000,
    retry: 1
  });
}

// ── ML service status & models ───────────────────────────────────────

/** Sidecar health — checkpoint name, device, training flag. */
export function useMLStatus(): UseQueryResult<MLServiceStatus, ApiError> {
  return useQuery<MLServiceStatus, ApiError>({
    queryKey: ["mlStatus"],
    queryFn: ({ signal }) => apiGet<MLServiceStatus>("/api/ml/status", signal),
    staleTime: 10_000,
    refetchInterval: 20_000,
    retry: 1
  });
}

/** Checkpoint files the sidecar can load (the model dropdown). */
export function useMLModels(): UseQueryResult<MLModelsResponse, ApiError> {
  return useQuery<MLModelsResponse, ApiError>({
    queryKey: ["mlModels"],
    queryFn: ({ signal }) => apiGet<MLModelsResponse>("/api/ml/models", signal),
    staleTime: 30_000,
    retry: 1
  });
}

export interface MLSelectModelResult {
  checkpoint: string | null;
  checkpointHash: string | null;
  modelLoaded: boolean;
}

/**
 * Switch the sidecar's resident checkpoint. The backend wipes the prediction
 * cache + ML jobs (they belonged to the old model), so callers must warn the
 * user first and refresh ML-related queries afterwards.
 */
export function selectMLModel(name: string): Promise<MLSelectModelResult> {
  const body: MLSelectModelRequest = { name };
  return apiPost<MLSelectModelResult>("/api/ml/model", body);
}

// ── Die-wide inference job ────────────────────────────────────────────

export const mlJobKey = (dieId: string) => ["mlJob", dieId] as const;

export function getMLJob(
  dieId: string,
  signal?: AbortSignal
): Promise<MLInferenceJob> {
  return apiGet<MLInferenceJob>(`/api/dies/${dieId}/ml/job`, signal);
}

export function startMLJob(dieId: string, overlayFilename?: string): Promise<MLInferenceJob> {
  return apiPost<MLInferenceJob>(`/api/dies/${dieId}/ml/job/start`, { overlayFilename });
}

export function stopMLJob(dieId: string): Promise<MLInferenceJob> {
  return apiPost<MLInferenceJob>(`/api/dies/${dieId}/ml/job/stop`, {});
}

/**
 * Live inference-job state for a die. Seeded by `GET …/ml/job`, then kept in
 * sync by WS `mlJob` broadcasts — so a job another user started shows up here
 * too. A slow polling fallback covers a dropped WS while a job is running.
 */
export function useMLJob(
  dieId: string | null
): UseQueryResult<MLInferenceJob | null, ApiError> {
  const qc = useQueryClient();
  const query = useQuery<MLInferenceJob | null, ApiError>({
    queryKey: ["mlJob", dieId],
    queryFn: ({ signal }) =>
      dieId ? getMLJob(dieId, signal) : Promise.resolve(null),
    enabled: !!dieId,
    refetchInterval: (q) =>
      q.state.data?.status === "running" ? 4000 : false,
    retry: 1
  });

  useEffect(() => {
    if (!dieId) return;
    return subscribeToDie(dieId, (msg) => {
      if (msg.type === "mlJob" && msg.dieId === dieId) {
        qc.setQueryData(mlJobKey(dieId), msg.job);
      }
    });
  }, [dieId, qc]);

  return query;
}

/** Every die's inference job — for the library page's status badges. */
export function listMLInferenceJobs(
  signal?: AbortSignal
): Promise<MLInferenceJob[]> {
  return apiGet<MLInferenceJob[]>("/api/ml/inference-jobs", signal);
}

type MLInferenceJobsQueryOptions = Omit<
  UseQueryOptions<MLInferenceJob[], ApiError, MLInferenceJob[], string[]>,
  "queryKey" | "queryFn"
>;

// ── CV cell detection ─────────────────────────────────────────────

export function cvMatch(params: CVMatchRequest): Promise<CVMatchResponse> {
  return apiPost<CVMatchResponse>("/api/ml/cv/match", params);
}

export function cvDebug(params: CVMatchRequest): Promise<CVDebugData> {
  return apiPost<CVDebugData>("/api/ml/cv/debug", params);
}

export function cvDebugDump(params: CVMatchRequest): Promise<CVDebugData & { dump_path: string }> {
  return apiPost<CVDebugData & { dump_path: string }>("/api/ml/cv/debug-dump", params);
}

export function cvTemplateMatch(params: CVMatchRequest): Promise<CVMatchResponse> {
  return apiPost<CVMatchResponse>("/api/ml/cv/template-match", params);
}

export function cvTemplateDebug(params: CVMatchRequest): Promise<CVDebugData> {
  return apiPost<CVDebugData>("/api/ml/cv/template-debug", params);
}

export interface CVTemplateMatchJob {
  id: string;
  status: "queued" | "running" | "completed" | "cancelled" | "failed";
  stage: string;
  percentage: number;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
  elapsedMs: number;
  cancelRequested: boolean;
  error: string | null;
  result?: CVMatchResponse;
}

export function startCVTemplateMatchJob(params: CVMatchRequest): Promise<CVTemplateMatchJob> {
  return apiPost<CVTemplateMatchJob>("/api/ml/cv/template-match-jobs", params);
}

export function getCVTemplateMatchJob(jobId: string): Promise<CVTemplateMatchJob> {
  return apiGet<CVTemplateMatchJob>(`/api/ml/cv/template-match-jobs/${jobId}`);
}

export function cancelCVTemplateMatchJob(jobId: string): Promise<CVTemplateMatchJob> {
  return apiPost<CVTemplateMatchJob>(`/api/ml/cv/template-match-jobs/${jobId}/cancel`, {});
}

export interface CVTemplateDebugJob {
  id: string;
  status: "queued" | "running" | "completed" | "cancelled" | "failed";
  stage: string;
  percentage: number;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
  elapsedMs: number;
  cancelRequested: boolean;
  error: string | null;
  result?: CVDebugData;
}

export function startCVTemplateDebugJob(params: CVMatchRequest): Promise<CVTemplateDebugJob> {
  return apiPost<CVTemplateDebugJob>("/api/ml/cv/template-debug-jobs", params);
}

export function getCVTemplateDebugJob(jobId: string): Promise<CVTemplateDebugJob> {
  return apiGet<CVTemplateDebugJob>(`/api/ml/cv/template-debug-jobs/${jobId}`);
}

export function cancelCVTemplateDebugJob(jobId: string): Promise<CVTemplateDebugJob> {
  return apiPost<CVTemplateDebugJob>(`/api/ml/cv/template-debug-jobs/${jobId}/cancel`, {});
}

export function cvAkazeVerify(params: AKAZEReverifyRequest): Promise<AKAZEReverifyResponse> {
  return apiPost<AKAZEReverifyResponse>("/api/ml/cv/akaze-verify", params);
}

export function cvAkazeDebug(params: AKAZEReverifyRequest & { max_pairs?: number }): Promise<AKAZEDebugResponse> {
  return apiPost<AKAZEDebugResponse>("/api/ml/cv/akaze-debug", params);
}

export function useMLInferenceJobs(
  options?: MLInferenceJobsQueryOptions
): UseQueryResult<MLInferenceJob[], ApiError> {
  return useQuery<MLInferenceJob[], ApiError, MLInferenceJob[], string[]>({
    queryKey: ["mlInferenceJobs"],
    queryFn: ({ signal }) => listMLInferenceJobs(signal),
    retry: 1,
    ...options
  });
}
