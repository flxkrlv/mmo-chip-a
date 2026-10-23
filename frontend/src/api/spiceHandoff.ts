import { apiGet } from "./client";
import type { SpiceHandoff } from "../state/spiceHandoff";

/** The last SPICE run published by an external agent, if any. */
export async function fetchLatestSpiceHandoff(dieId: string): Promise<SpiceHandoff> {
  return apiGet<SpiceHandoff>(
    `/api/dies/${encodeURIComponent(dieId)}/spice-handoff/latest`
  );
}
