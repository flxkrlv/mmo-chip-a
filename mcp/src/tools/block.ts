import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DieAnnotations, DieSummary } from "shared";
import type { BackendClient } from "../client.js";
import { cellDieRect, collectTypeBoxes } from "../footprint.js";
import {
  buildBlockSubcircuit,
  parseCdlDevices,
  selectedModels
} from "../block.js";
import { InputError, fail, guarded, json, truncate } from "../result.js";

const NGSPICE_TIMEOUT_MS = 180_000;
const NETLIST_LIMIT = 120_000;
const OUTPUT_LIMIT = 8_000;
const ANALYSIS_OUTPUT_LIMIT = 4_000;

interface AnalogDeviceStore {
  version?: number;
  devices?: Record<string, string>;
}

interface NetlistExportResponse {
  ok?: boolean;
  error?: string;
  text?: string;
  deviceCount?: number;
  namedNetCount?: number;
  warnings?: string[];
}

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
}

function pointInPoly(
  px: number,
  py: number,
  poly: ReadonlyArray<{ x: number; y: number }>
): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x;
    const yi = poly[i].y;
    const xj = poly[j].x;
    const yj = poly[j].y;
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function regionPolygon(region: NonNullable<DieAnnotations["floorplanRegions"]>[number]) {
  if (region.kind === "rect" && region.geometry.length >= 2) {
    const a = region.geometry[0];
    const b = region.geometry[1];
    return [
      { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) },
      { x: Math.max(a.x, b.x), y: Math.min(a.y, b.y) },
      { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y) },
      { x: Math.min(a.x, b.x), y: Math.max(a.y, b.y) }
    ];
  }
  return region.geometry;
}

function sanitizeNetName(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9_]/g, "_");
  return /^[A-Za-z_]/.test(cleaned) && cleaned ? cleaned : `n_${cleaned || "net"}`;
}

function safeBlockName(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9_]/g, "_");
  return /^[A-Za-z_]/.test(cleaned) && cleaned ? cleaned : "agent_block";
}

const DEFAULT_CARDS: Record<string, string> = {
  npn: ".MODEL npn NPN (BF=200 IS=1e-14 VAF=50)",
  pnp: ".MODEL pnp PNP (BF=100 IS=1e-14 VAF=50)",
  diode: ".MODEL diode D (IS=1e-14 N=1)",
  zener: ".MODEL zener D (IS=1e-14 BV=5.6 N=1)",
  schottky: ".MODEL schottky D (IS=1e-12 N=1.05 BV=30)"
};

/**
 * Simulate a floorplan / cell selection as a real subcircuit.
 *
 * The port rule is the same rigid rule the floorplan partition uses: a net
 * touched only by selected devices is internal; a net that also reaches an
 * unselected device becomes a port. The generated `.SUBCKT` is instantiated
 * with a single `X1`, so the agent's testbench only supplies sources, loads
 * and the analysis.
 */
export function registerBlockTools(server: McpServer, client: BackendClient): string[] {
  const names: string[] = [];
  const diePath = (dieId: string): string => `/api/dies/${encodeURIComponent(dieId)}`;

  server.registerTool(
    "simulate_block",
    {
      title: "Simulate a floorplan block",
      description:
        "Extract a selected block (by floorplan regionId, cellIds and/or annotation netIds) from the " +
        "CURRENT netlist and simulate it as a `.SUBCKT`. Ports follow the rigid floorplan rule: a net " +
        "that only touches selected devices stays internal; a net that also reaches an unselected " +
        "device becomes a port. `testbench` supplies only sources, loads, analysis and `.measure` — the " +
        "tool instantiates `X1 <ports> <block>` itself. The response includes the `.SUBCKT`, the full " +
        "simulated deck, measurements and a `handoff` object suitable for the SPICE simulator. Device " +
        "models are the standard power-BJT defaults (IS=1e-14); pass `models` to override with library " +
        "option ids. Use `list_overlay_layers`/`get_crop` to inspect the block visually first."
      ,
      inputSchema: {
        dieId: z.string().describe("Project id from list_projects"),
        regionId: z.string().optional().describe("Floorplan region id (its cells are selected)"),
        cellIds: z.array(z.string()).optional().describe("Cell instance ids to include"),
        netIds: z
          .array(z.string())
          .optional()
          .describe("Annotation net ids; devices touching any of them are selected"),
        name: z.string().optional().describe("Subcircuit name (default agent_block)"),
        testbench: z
          .string()
          .describe(
            "Sources, loads, one analysis and optional .measure lines. Do NOT include the X1 instance, " +
              "the DUT or the .SUBCKT."
          ),
        models: z
          .array(z.string())
          .optional()
          .describe("Standard model option ids (npn-gp, pnp-gp, diode-generic, …)"),
        publish: z
          .boolean()
          .default(true)
          .describe(
            "Store the run as the project's latest SPICE handoff so the SPICE tab can show it"
          ),
        binPath: z.string().optional().describe("ngspice binary path (overrides the backend default)")
      }
    },
    async ({ dieId, regionId, cellIds, netIds, name, testbench, models, publish, binPath }) =>
      guarded(async () => {
        if (!regionId && (!cellIds || cellIds.length === 0) && (!netIds || netIds.length === 0)) {
          throw new InputError("simulate_block needs regionId, cellIds or netIds");
        }
        if (!testbench.trim()) throw new InputError("simulate_block needs a testbench");

        const [die, annotations, analog, netlist] = await Promise.all([
          client.getJson<DieSummary>(diePath(dieId)),
          client.getJson<DieAnnotations>(`${diePath(dieId)}/annotations`),
          client.getJson<AnalogDeviceStore>(`${diePath(dieId)}/analog-devices`),
          client.postJson<NetlistExportResponse>(
            `${diePath(dieId)}/netlist-export`,
            { dialect: "cdl", includeText: true, moduleName: "block_probe" },
            NGSPICE_TIMEOUT_MS
          )
        ]);

        if (netlist.ok === false) {
          return fail({ error: netlist.error ?? "netlist extraction failed" });
        }
        const devices = parseCdlDevices(netlist.text ?? "");
        if (devices.length === 0) throw new InputError("the extracted netlist has no devices");

        // cell instance id → all device names that live in that cell.
        const devicesByCell = new Map<string, string[]>();
        for (const [key, deviceName] of Object.entries(analog.devices ?? {})) {
          const at = key.lastIndexOf("@");
          if (at < 0) continue;
          const cellId = key.slice(at + 1);
          const list = devicesByCell.get(cellId) ?? [];
          list.push(deviceName);
          devicesByCell.set(cellId, list);
        }

        const selected = new Set<string>();
        const resolvedCellIds: string[] = [];
        for (const cellId of cellIds ?? []) {
          const found = devicesByCell.get(cellId);
          if (!found || found.length === 0) {
            throw new InputError(`Cell "${cellId}" has no extracted devices`);
          }
          resolvedCellIds.push(cellId);
          for (const device of found) selected.add(device);
        }

        if (regionId) {
          const region = (annotations.floorplanRegions ?? []).find((item) => item.id === regionId);
          if (!region) throw new InputError(`Floorplan region "${regionId}" not found`);
          const poly = regionPolygon(region);
          const boxes = await collectTypeBoxes(client, die, annotations);
          let insideCells = 0;
          for (const cell of annotations.cells) {
            const box = boxes.get(cell.cellTypeId);
            if (!box) continue;
            const rect = cellDieRect(cell, box.width, box.height);
            if (!pointInPoly(rect.x + rect.width / 2, rect.y + rect.height / 2, poly)) continue;
            insideCells += 1;
            resolvedCellIds.push(cell.id);
            for (const device of devicesByCell.get(cell.id) ?? []) selected.add(device);
          }
          if (insideCells === 0) {
            throw new InputError(`Floorplan region "${regionId}" contains no resolvable cells`);
          }
        }

        if (netIds && netIds.length > 0) {
          const annotationNets = new Map(annotations.nets.map((net) => [net.id, net]));
          const wantedNets = new Set<string>();
          for (const netId of netIds) {
            const net = annotationNets.get(netId);
            if (!net) throw new InputError(`Annotation net "${netId}" not found`);
            wantedNets.add(sanitizeNetName(net.name));
          }
          let matched = 0;
          for (const device of devices) {
            if (device.nets.some((net) => wantedNets.has(net))) {
              selected.add(device.name);
              matched += 1;
            }
          }
          if (matched === 0) {
            throw new InputError(
              `No extracted device touches the requested nets (${[...wantedNets].join(", ")})`
            );
          }
        }

        if (selected.size === 0) throw new InputError("The selection contains no extracted devices");
        const blockName = safeBlockName(name ?? "agent_block");
        const block = buildBlockSubcircuit(devices, selected, blockName);
        if (block.deviceCount === 0) throw new InputError("The selection contains no extracted devices");

        const modelNames = selectedModels(devices, block.selectedNames);
        const cards = modelNames
          .map((model) => DEFAULT_CARDS[model])
          .filter((card): card is string => Boolean(card));
        const body = testbench
          .trim()
          .replace(/\r?\n\s*\.end\s*$/i, "")
          .trim();
        const hasInstance = /^\s*X\S+\s/m.test(body);
        const instance = hasInstance
          ? ""
          : ["X1", ...block.ports, blockName].filter(Boolean).join(" ");
        const deck = [
          `* mcp simulate_block: ${blockName}`,
          ...cards,
          block.subckt,
          instance,
          "* ── Testbench ──",
          body,
          ".end"
        ]
          .filter((line) => line !== "")
          .join("\n");

        const response = await client.postJson<NgspiceResponse>(
          "/api/ngspice/run",
          {
            netlist: deck,
            ...(models && models.length > 0 ? { models } : {}),
            ...(binPath ? { binPath } : {})
          },
          NGSPICE_TIMEOUT_MS
        );
        const success = Boolean(response.success ?? response.ok);
        const notes = [...(response.notes ?? [])];
        const summary = success
          ? `${response.plot ?? "block"} — ${block.deviceCount} devices, ${block.ports.length} ports`
          : "block simulation failed";
        const modelCards = Object.fromEntries(
          modelNames.map((model) => [model, DEFAULT_CARDS[model] ?? ""])
        );
        const handoff = {
          dieId,
          netlist: deck,
          dut: block.subckt,
          directives: body,
          modelCards,
          modelSelection: {},
          customModels: cards.join("\n"),
          summary,
          plot: response.plot ?? null,
          measurements: response.measurements ?? {},
          origin: "assistant",
          at: Date.now()
        };
        let published = false;
        if (success && publish) {
          try {
            await client.postJson(
              `${diePath(dieId)}/spice-handoff`,
              handoff,
              30_000
            );
            published = true;
          } catch (error) {
            notes.push(
              `SPICE handoff was not published: ${error instanceof Error ? error.message : String(error)}`
            );
          }
        }
        const payload: Record<string, unknown> = {
          success,
          dieId,
          block: {
            name: blockName,
            deviceCount: block.deviceCount,
            ports: block.ports,
            internalNets: block.internalNets,
            selectedDevices: block.selectedNames,
            missingDevices: block.missingNames,
            regionId: regionId ?? null,
            cellIds: [...new Set(resolvedCellIds)],
            netIds: netIds ?? []
          },
          models: modelNames,
          subckt: block.subckt,
          deck: truncate(deck, NETLIST_LIMIT),
          testbench: truncate(body, NETLIST_LIMIT),
          plot: response.plot ?? null,
          numPoints: response.numPoints ?? 0,
          variables: response.variables ?? [],
          measurements: response.measurements ?? {},
          notes,
          output: truncate(response.output, OUTPUT_LIMIT) ?? null,
          simulatedNetlist: truncate(response.simulatedNetlist, NETLIST_LIMIT) ?? null,
          analyses: (response.analyses ?? []).map((entry) => ({
            ...entry,
            output: truncate(entry.output, ANALYSIS_OUTPUT_LIMIT) ?? ""
          })),
          published,
          handoff
        };
        if (!success) {
          payload.error = response.error ?? "ngspice block simulation failed";
          return fail(payload);
        }
        return json(payload);
      })
  );
  names.push("simulate_block");

  return names;
}
