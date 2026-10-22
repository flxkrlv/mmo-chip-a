import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { BackendClient } from "../client.js";
import { fail, guarded, json, truncate } from "../result.js";

const EXPORT_TIMEOUT_MS = 180_000;
/** Full decks stay inline; anything larger is truncated and flagged. */
const TEXT_LIMIT = 120_000;

interface VirtualConnect {
  name: string;
  spiceNetIds: number[];
  physicalNets: string[];
}

interface NetlistExportResponse {
  ok?: boolean;
  error?: string;
  dieId?: string;
  umPerPx?: number;
  deviceCount?: number;
  namedNetCount?: number;
  byKind?: Record<string, number>;
  totalDevices?: number;
  warnings?: string[];
  virtualConnects?: VirtualConnect[];
  text?: string;
  netlistPath?: string | null;
  persisted?: boolean;
}

/**
 * Register the netlist-extraction tools.
 *
 * `export_netlist` re-runs the analog extraction pipeline on the BACKEND from
 * the project's persisted state (annotations.json + spice_config.json +
 * analog-devices.json). That is deliberately different from the app's export
 * button, which generates the netlist in the browser and merely POSTs the text
 * for storage — this tool always reflects the current annotations with no UI
 * round-trip.
 */
export function registerNetlistTools(
  server: McpServer,
  client: BackendClient
): string[] {
  const names: string[] = [];

  server.registerTool(
    "export_netlist",
    {
      title: "Export extracted netlist",
      description:
        "Extract a SPICE netlist from a die project's CURRENT annotations, running the analog extraction pipeline server-side. " +
        "Reads the persisted project state (annotations.json, spice_config.json, analog-devices.json) and re-runs device " +
        "detection + SPICE generation in one shot (~0.5 s), so the result always matches the latest annotations — unlike the " +
        "app's export button, which computes in the browser and only stores the text. " +
        "Saved device names (R1/Q1/C1/...) are applied, so designators match the app. " +
        "`virtualConnects` lists net NAMES claimed by more than one physical net (e.g. a current-sensing ground pad and a " +
        "potential ground pad): SPICE merges them by name, which is intentional, not an error — review it to confirm each case " +
        "is deliberate. `warnings` flags unconnected terminals and missing models. " +
        "Set `persist:true` to also write <projectDir>/export/<moduleName>.cdl on the backend host and get the path back.",
      inputSchema: {
        dieId: z.string().describe("Project id from list_projects"),
        moduleName: z
          .string()
          .optional()
          .describe("Top-level subckt / file name (default: netlist)"),
        dialect: z
          .enum(["cdl", "spectre", "hspice"])
          .optional()
          .describe("Output dialect (default cdl)"),
        persist: z
          .boolean()
          .default(false)
          .describe("Also write the deck to <projectDir>/export/ and return its path"),
        includeText: z
          .boolean()
          .default(true)
          .describe("Return the netlist body inline (truncated at 120k chars)"),
        timeoutMs: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Extraction timeout (default 120000)")
      }
    },
    async ({ dieId, moduleName, dialect, persist, includeText, timeoutMs }) =>
      guarded(async () => {
        const body: Record<string, unknown> = { persist };
        if (moduleName) body.moduleName = moduleName;
        if (dialect) body.dialect = dialect;
        if (timeoutMs) body.timeoutMs = timeoutMs;

        const response = await client.postJson<NetlistExportResponse>(
          `/api/dies/${encodeURIComponent(dieId)}/netlist-export`,
          body,
          Math.max(EXPORT_TIMEOUT_MS, timeoutMs ?? 0)
        );

        if (!response.ok) {
          return fail({ error: response.error ?? "netlist extraction failed" });
        }

        const full = response.text ?? "";
        const payload: Record<string, unknown> = {
          success: true,
          dieId: response.dieId ?? dieId,
          umPerPx: response.umPerPx ?? null,
          deviceCount: response.deviceCount ?? 0,
          namedNetCount: response.namedNetCount ?? 0,
          totalDevices: response.totalDevices ?? 0,
          byKind: response.byKind ?? {},
          warnings: response.warnings ?? [],
          virtualConnects: (response.virtualConnects ?? []).map((v) => ({
            name: v.name,
            spiceNetIds: v.spiceNetIds,
            physicalNets: v.physicalNets
          })),
          persisted: response.persisted ?? false,
          netlistPath: response.netlistPath ?? null,
          textChars: full.length
        };

        if (includeText) {
          const text = truncate(full, TEXT_LIMIT) ?? "";
          payload.text = text;
          payload.textTruncated = text.length < full.length;
        }

        return json(payload);
      })
  );
  names.push("export_netlist");

  return names;
}
