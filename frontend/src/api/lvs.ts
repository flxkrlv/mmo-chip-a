import type { LvsCompareRequest, LvsResponse, LvsErrorResponse } from "shared";
import { apiPost } from "./client";

export type LvsApiResponse = LvsResponse | LvsErrorResponse;

export async function compareNetlists(dieId: string, req: LvsCompareRequest): Promise<LvsApiResponse> {
  const res = await apiPost<LvsApiResponse>(`/api/dies/${encodeURIComponent(dieId)}/lvs/compare`, req);
  console.log("[lvs] response:", JSON.stringify(res, null, 2));
  return res;
}
