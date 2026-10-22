import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { BackendClient } from "../client.js";
import { InputError, definedOnly, fail, guarded, json, truncate } from "../result.js";

const NGSPICE_TIMEOUT_MS = 180_000;
const LVS_TIMEOUT_MS = 300_000;
const OUTPUT_LIMIT = 8_000;
const ANALYSIS_OUTPUT_LIMIT = 4_000;
const NETLIST_LIMIT = 100_000;

interface NgspiceAnalysis {
  analysis: string;
  plot?: string;
  numPoints: number;
  variables: string[];
  measurements: Record<string, number>;
  output: string;
  error?: string;
}

interface NgspiceResponse {
  ok?: boolean;
  success?: boolean;
  error?: string;
  output?: string;
  variables?: string[];
  numPoints?: number;
  measurements?: Record<string, number>;
  notes?: string[];
  simulatedNetlist?: string;
  plot?: string;
  analyses?: NgspiceAnalysis[];
  rawData?: string;
  varTypes?: string[];
  dataColumns?: unknown;
}

export function registerSimulationTools(
  server: McpServer,
  client: BackendClient
): string[] {
  const names: string[] = [];

  server.registerTool(
    "run_ngspice",
    {
      title: "Run ngspice",
      description:
        "Run an ngspice simulation through the backend (normalises the netlist, runs every analysis, parses measurements). Supply `netlist` for a full deck, or `subcircuit` (the DUT) + `directives` (sources, .tran/.dc/.ac, .meas) — that is the contract the backend enforces. The tool auto-adds .op when no analysis is present and reports what it changed in `notes`. Results come back trimmed: measurements, variables, notes, per-analysis summaries and truncated ngspice output; the raw waveform arrays are dropped unless includeRawData is set. success:false is returned as an error result so a failed deck is not mistaken for data. Requires ngspice installed on the backend host.",
      inputSchema: {
        netlist: z.string().optional().describe("Full SPICE deck (takes priority)"),
        subcircuit: z.string().optional().describe("DUT .subckt block, paired with directives"),
        directives: z
          .string()
          .optional()
          .describe("Stimuli + analysis directives, e.g. .tran 1n 100n"),
        testbench: z
          .string()
          .optional()
          .describe("Testbench only; pair with dutNetlist for the backend's split path"),
        dutNetlist: z.string().optional().describe("DUT netlist used with testbench"),
        analysis: z.enum(["tran", "dc", "ac"]).optional().describe("Output parsing hint"),
        models: z.array(z.string()).optional().describe("Standard model option ids"),
        binPath: z.string().optional().describe("ngspice binary path (overrides NGSPICE_BIN)"),
        includeRawData: z
          .boolean()
          .default(false)
          .describe("Also return raw waveform arrays (can be very large)")
      }
    },
    async (args) =>
      guarded(async () => {
        const { netlist, subcircuit, directives, testbench, dutNetlist, analysis, models, binPath, includeRawData } =
          args;
        if (!netlist && !subcircuit && !directives) {
          throw new InputError("Provide netlist, or subcircuit + directives.");
        }
        const body = definedOnly({
          netlist,
          subcircuit,
          directives,
          testbench,
          dutNetlist,
          analysis,
          models,
          binPath
        });
        const response = await client.postJson<NgspiceResponse>(
          "/api/ngspice/run",
          body,
          NGSPICE_TIMEOUT_MS
        );
        const success = Boolean(response.success ?? response.ok);
        const payload: Record<string, unknown> = {
          success,
          error: response.error ?? null,
          variables: response.variables ?? [],
          numPoints: response.numPoints ?? 0,
          measurements: response.measurements ?? {},
          plot: response.plot ?? null,
          notes: response.notes ?? [],
          output: truncate(response.output, OUTPUT_LIMIT) ?? null,
          simulatedNetlist: truncate(response.simulatedNetlist, NETLIST_LIMIT) ?? null,
          analyses: (response.analyses ?? []).map((entry) => ({
            ...entry,
            output: truncate(entry.output, ANALYSIS_OUTPUT_LIMIT) ?? ""
          }))
        };
        if (includeRawData) {
          payload.rawData = response.rawData ?? null;
          payload.varTypes = response.varTypes ?? [];
          payload.dataColumns = response.dataColumns ?? null;
        }
        if (!success) {
          return fail(payload);
        }
        return json(payload);
      })
  );
  names.push("run_ngspice");

  server.registerTool(
    "run_lvs",
    {
      title: "Run LVS comparison",
      description:
        "Compare a layout netlist against a schematic netlist (LVS). engine vyges-lvs (default, needs the vyges-lvs CLI installed) or name-based (pure Node, device/net name matching). dialect hints the parser: cdl, spectre or hspice. On success the full report (match verdict, per-net/per-device diffs, JSON) is returned; on failure — timeout, missing CLI, unknown engine — the error and its detail come back as an error result. The dieId only scopes the call to a project.",
      inputSchema: {
        dieId: z.string().describe("Project id (scopes the endpoint)"),
        layoutNetlist: z.string().describe("Netlist extracted from the layout"),
        schematicNetlist: z.string().describe("Reference schematic netlist"),
        dialect: z.enum(["cdl", "spectre", "hspice"]).optional(),
        moduleName: z.string().optional().describe("Top-level subckt name"),
        engine: z.enum(["vyges-lvs", "name-based"]).optional()
      }
    },
    async ({ dieId, layoutNetlist, schematicNetlist, dialect, moduleName, engine }) =>
      guarded(async () => {
        if (!layoutNetlist || !schematicNetlist) {
          throw new InputError("Both layoutNetlist and schematicNetlist are required");
        }
        const body = definedOnly({ layoutNetlist, schematicNetlist, dialect, moduleName, engine });
        const response = await client.postJson<
          { ok: boolean; data?: unknown; error?: string; detail?: string }
        >(`/api/dies/${encodeURIComponent(dieId)}/lvs/compare`, body, LVS_TIMEOUT_MS);
        if (!response.ok) {
          return fail({
            error: response.error ?? "LVS comparison failed",
            ...(response.detail ? { detail: response.detail } : {})
          });
        }
        return json(response.data ?? {});
      })
  );
  names.push("run_lvs");

  return names;
}
