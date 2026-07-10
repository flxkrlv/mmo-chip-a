import type { LvsCompareRequest, LvsResponse, LvsErrorResponse, LvsRawResult } from "shared";
import { apiPost } from "./client";

export type LvsApiResponse = LvsResponse | LvsErrorResponse;

interface LvsSnapshot {
  layoutNetlist: string;
  schematicNetlist: string;
  matched: boolean;
  json: LvsRawResult;
  report: string;
  devices: { name: string; category: string; layoutLine: string; schematicLine: string }[];
  stderr?: string;
}

export async function compareNetlists(dieId: string, req: LvsCompareRequest): Promise<LvsApiResponse> {
  const res = await apiPost<LvsApiResponse>(`/api/dies/${encodeURIComponent(dieId)}/lvs/compare`, req);
  return res;
}

export async function saveLvsSnapshot(snapshot: LvsSnapshot): Promise<void> {
  try {
    await apiPost("/api/lvs/debug/snapshot", snapshot);
  } catch {
    // best-effort, don't disrupt the user
  }
}
