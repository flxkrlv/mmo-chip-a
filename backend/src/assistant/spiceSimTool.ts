/**
 * spiceSimTool — Backend tool for AI agent to run ngspice simulations.
 *
 * The tool accepts a netlist (or subcircuit + directives), writes them to a
 * temp file, runs ngspice in batch mode, parses the raw output, and returns
 * key measurements to the LLM.
 *
 * Requires ngspice to be installed on the server (ngspice -b).
 * Falls back gracefully if not available.
 */

import { writeFile, unlink, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

const execFileAsync = promisify(execFile);

const SPICE_BIN = process.env.NGSPICE_BIN ?? "ngspice";
const TIMEOUT_MS = 30_000;

export interface SpiceSimToolArgs {
  /** Full SPICE netlist (takes priority over subcircuit + directives). */
  netlist?: string;
  /** Subcircuit block to simulate (will be prepended to directives). */
  subcircuit?: string;
  /** User directives (.tran, .dc, .ac, sources, etc.). */
  directives?: string;
  /** Analysis type hint for output parsing. */
  analysis?: "tran" | "dc" | "ac";
}

export interface SpiceSimToolResult {
  success: boolean;
  /** Parsed output variables (v(out), i(Vdd), etc.) */
  variables?: string[];
  /** Number of data points per variable */
  numPoints?: number;
  /** Key measurements extracted from .measure or .print */
  measurements?: Record<string, number>;
  /** ngspice stdout/stderr combined */
  output?: string;
  /** Error message if simulation failed */
  error?: string;
  /** The netlist that was actually simulated */
  simulatedNetlist?: string;
}

/**
 * Build the full netlist from tool arguments.
 */
function buildNetlist(args: SpiceSimToolArgs): string {
  if (args.netlist) return args.netlist;

  const parts: string[] = [];
  if (args.subcircuit) {
    parts.push(args.subcircuit);
    parts.push("");
  }
  if (args.directives) {
    parts.push(args.directives);
  }
  return parts.join("\n");
}

/**
 * Parse ngspice raw ASCII output to extract variable names and data.
 * For the tool response we only need a summary, not full data.
 */
function parseRawOutput(raw: string): { variables: string[]; numPoints: number; measurements: Record<string, number> } {
  const variables: string[] = [];
  let numPoints = 0;
  const measurements: Record<string, number> = {};

  const lines = raw.split("\n");
  let inHeader = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith("No. Variables:")) {
      const m = trimmed.match(/No\. Variables:\s+(\d+)/);
      if (m) { /* already captured from header */ }
    }
    if (trimmed.startsWith("No. Points:")) {
      const m = trimmed.match(/No\. Points:\s+(\d+)/);
      if (m) numPoints = parseInt(m[1], 10);
    }
    if (trimmed.startsWith("Variables:")) {
      inHeader = true;
      continue;
    }
    if (inHeader && trimmed.match(/^\d+\s+/)) {
      const varName = trimmed.split(/\s+/)[1];
      if (varName) variables.push(varName);
    }
    if (trimmed === "Values:" || trimmed === "Binary:") {
      inHeader = false;
    }

    // Parse .measure results from stdout
    const measureMatch = trimmed.match(/^(\w[\w.]*)\s*=\s*([+-]?[\d.eE+]+)/i);
    if (measureMatch) {
      measurements[measureMatch[1]] = parseFloat(measureMatch[2]);
    }
  }

  return { variables, numPoints, measurements };
}

/**
 * Execute a SPICE simulation via ngspice subprocess.
 */
export async function executeSpiceSimTool(args: SpiceSimToolArgs): Promise<{ text: string; result: SpiceSimToolResult }> {
  const netlist = buildNetlist(args);

  if (!netlist.trim()) {
    return {
      text: JSON.stringify({ error: "No netlist provided. Supply a full netlist, or subcircuit + directives." }),
      result: { success: false, error: "Empty netlist" },
    };
  }

  // Write netlist to temp file
  const id = randomBytes(8).toString("hex");
  const tmpDir = tmpdir();
  const cirFile = join(tmpDir, `mmochip_spice_${id}.cir`);
  const rawFile = join(tmpDir, `mmochip_spice_${id}.raw`);

  // Ensure .control block exists for batch mode
  let fullNetlist = netlist;
  if (!fullNetlist.toLowerCase().includes(".control")) {
    fullNetlist += `\n.control\nrun\nwrdata ${rawFile} all\nquit\n.endc`;
  }

  try {
    await writeFile(cirFile, fullNetlist, "utf-8");

    const { stdout, stderr } = await execFileAsync(
      SPICE_BIN,
      ["-b", cirFile],
      { timeout: TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
    );

    const combined = [stdout, stderr].filter(Boolean).join("\n");

    // Try to read the raw output file
    let parsed = { variables: [] as string[], numPoints: 0, measurements: {} as Record<string, number> };
    try {
      const rawContent = await readFile(rawFile, "utf-8");
      parsed = parseRawOutput(rawContent);
    } catch {
      // Raw file may not exist if simulation didn't produce one — parse stdout
      parsed = parseRawOutput(combined);
    }

    const result: SpiceSimToolResult = {
      success: true,
      variables: parsed.variables,
      numPoints: parsed.numPoints,
      measurements: Object.keys(parsed.measurements).length > 0 ? parsed.measurements : undefined,
      output: combined.slice(0, 2000), // cap for LLM context
      simulatedNetlist: netlist.slice(0, 1000),
    };

    return {
      text: JSON.stringify({
        success: true,
        variables: parsed.variables,
        numPoints: parsed.numPoints,
        measurements: parsed.measurements,
        outputSnippet: combined.slice(0, 500),
      }),
      result,
    };
  } catch (err: any) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const result: SpiceSimToolResult = {
      success: false,
      error: errMsg,
      output: err.stdout ?? err.stderr ?? "",
      simulatedNetlist: netlist.slice(0, 1000),
    };

    return {
      text: JSON.stringify({ success: false, error: errMsg }),
      result,
    };
  } finally {
    // Cleanup temp files
    try { await unlink(cirFile); } catch { /* ok */ }
    try { await unlink(rawFile); } catch { /* ok */ }
  }
}

/**
 * OpenAI-compatible tool definition for the LLM.
 */
export const SPICE_SIM_TOOL = {
  type: "function",
  function: {
    name: "mmochip_spice_sim",
      description:
        "Run an ngspice simulation on a circuit netlist. Supply either a full netlist, or a subcircuit block plus analysis directives (.tran, .dc, .ac, sources, loads, etc.). The netlist MUST be in standard SPICE/CDL format (NOT Spectre syntax). Example formats: R1 n1 n2 4858 (resistor), Q1 c b e npn_model (BJT), D1 anode cathode d_model (diode). Returns simulation status, variable names, data point count, and any measurements. Use this to verify circuit behavior — e.g. compute gain, bandwidth, PSRR, transient response, DC operating point. The simulation runs server-side with ngspice in batch mode.",
    parameters: {
      type: "object",
      properties: {
        netlist: {
          type: "string",
          description: "Full SPICE netlist to simulate. Takes priority over subcircuit + directives.",
        },
        subcircuit: {
          type: "string",
          description: ".subckt block to simulate. Will be combined with the directives field.",
        },
        directives: {
          type: "string",
          description: "ngspice directives: source definitions (VDD, VIN), analysis commands (.tran, .dc, .ac), load caps, .control blocks, etc.",
        },
        analysis: {
          type: "string",
          enum: ["tran", "dc", "ac"],
          description: "Hint for the type of analysis being performed (for output parsing guidance).",
        },
      },
    },
  },
} as const;
