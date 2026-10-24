import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { BackendClient } from "../client.js";
import { guarded, json, requireFields } from "../result.js";

export function registerJobTools(server: McpServer, client: BackendClient): string[] {
  const names: string[] = [];
  const diePath = (dieId: string): string => `/api/dies/${encodeURIComponent(dieId)}`;

  server.registerTool(
    "ml_job",
    {
      title: "ML inference job",
      description:
        "Control the ML via-detection sweep for a die: status (last job per die), start, stop. Starting posts an inference job to the ML sidecar; if the sidecar is not running the call comes back as an error saying so. `overlayFilename` runs against a named overlay image instead of the base photo. Jobs are asynchronous — poll status; results land as heatmap/via layers the app reads.",
      inputSchema: {
        dieId: z.string().describe("Project id from list_projects"),
        action: z.enum(["status", "start", "stop"]),
        overlayFilename: z
          .string()
          .optional()
          .describe("Overlay image filename to run against (start only)")
      }
    },
    async ({ dieId, action, overlayFilename }) =>
      guarded(async () => {
        const jobPath = `${diePath(dieId)}/ml/job`;
        if (action === "status") {
          const job = await client.getJson<unknown>(jobPath);
          return json({ action, job });
        }
        if (action === "start") {
          const body =
            overlayFilename === undefined ? {} : { overlayFilename };
          const job = await client.postJson<unknown>(`${jobPath}/start`, body);
          return json({ action, job });
        }
        const job = await client.postJson<unknown>(`${jobPath}/stop`, {});
        return json({ action, job });
      })
  );
  names.push("ml_job");

  server.registerTool(
    "cell_detection",
    {
      title: "Cell detection job",
      description:
        "Propose placements of an annotated cell type across a die, from the cached ML vias: status, start, stop, list (stored detections per type). start needs cellTypeId (a type this die knows) and accepts allowFlipX / allowFlipY / avoidExistingCells / allDies flags. One detection job per die at a time — a second start returns 409 busy, so poll status or stop first. Results are proposals: they are reviewed and approved in the app's merge-cells tool, not written into annotations by this call.",
      inputSchema: {
        dieId: z.string().describe("Project id from list_projects"),
        action: z.enum(["status", "start", "stop", "list"]),
        cellTypeId: z.string().optional().describe("Required for start"),
        allowFlipX: z.boolean().optional(),
        allowFlipY: z.boolean().optional(),
        avoidExistingCells: z.boolean().optional(),
        allDies: z.boolean().optional().describe("Run across the whole cell library")
      }
    },
    async (args) =>
      guarded(async () => {
        const { dieId, action } = args;
        const jobPath = `${diePath(dieId)}/cell-detections/job`;
        if (action === "status") {
          const job = await client.getJson<unknown>(jobPath);
          return json({ action, job });
        }
        if (action === "stop") {
          const job = await client.postJson<unknown>(`${jobPath}/stop`, {});
          return json({ action, job });
        }
        if (action === "list") {
          const detections = await client.getJson<unknown>(`${diePath(dieId)}/cell-detections`);
          return json({ action, detections });
        }
        requireFields(action, { cellTypeId: args.cellTypeId }, ["cellTypeId"]);
        const body = {
          cellTypeId: args.cellTypeId,
          ...(args.allowFlipX === undefined ? {} : { allowFlipX: args.allowFlipX }),
          ...(args.allowFlipY === undefined ? {} : { allowFlipY: args.allowFlipY }),
          ...(args.avoidExistingCells === undefined
            ? {}
            : { avoidExistingCells: args.avoidExistingCells }),
          ...(args.allDies === undefined ? {} : { allDies: args.allDies })
        };
        const job = await client.postJson<unknown>(`${jobPath}/start`, body);
        return json({ action, job });
      })
  );
  names.push("cell_detection");

  return names;
}
