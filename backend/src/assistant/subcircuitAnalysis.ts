import type {
  AssistantAnalysisBrief,
  AssistantAnalysisRequest,
  AssistantAnalysisResult,
  AssistantCircuitDeviceInput,
} from "shared";

/** The only non-LLM guard in Phase 1: protect the server from accidental huge snapshots. */
const MAX_DEVICES_PER_REQUEST = 10_000;

type Device = AssistantCircuitDeviceInput;
type NetNames = Map<number, string>;

function netLabel(netId: number, names: NetNames): string {
  return netId < 0 ? "UNCONNECTED" : names.get(netId) ?? `NET${netId}`;
}

function deviceLine(device: Device, names: NetNames): string {
  const terminals = device.terminals.map((terminal) => `${terminal.name}=${netLabel(terminal.netId, names)}`).join(" ");
  const geometry = device.geometry as unknown as Record<string, unknown>;
  const parameters = ["mosType", "W_um", "L_um", "multiplier", "AE_um2", "PE_um", "resistance_ohms"]
    .filter((key) => typeof geometry[key] === "string" || typeof geometry[key] === "number")
    .map((key) => `${key}=${String(geometry[key])}`)
    .join(" ");
  return `${device.instanceName} ${device.kind} ${terminals}${parameters ? ` ${parameters}` : ""}`;
}

function selectedScope(request: AssistantAnalysisRequest): Device[] {
  const devices = request.circuit.devices;
  if ((request.scope ?? "die") !== "selected") return devices;
  const selectedUuids = new Set(request.selectedDeviceUuids ?? []);
  const selectedNetIds = new Set(request.selectedNetIds ?? []);
  const selected = devices.filter((device) => selectedUuids.has(device.uuid) || device.terminals.some((terminal) => selectedNetIds.has(terminal.netId)));
  return selected.length ? selected : devices;
}

function diagnosticsFor(devices: Device[], request: AssistantAnalysisRequest): string[] {
  const counts = new Map<string, number>();
  let terminals = 0;
  let connected = 0;
  for (const device of devices) {
    counts.set(device.kind, (counts.get(device.kind) ?? 0) + 1);
    terminals += device.terminals.length;
    connected += device.terminals.filter((terminal) => terminal.netId >= 0).length;
  }
  const kindSummary = [...counts.entries()].map(([kind, count]) => `${count} ${kind}`).join(", ") || "no recognised devices";
  return [
    `LLM analysis snapshot: ${devices.length} devices (${kindSummary}); ${connected}/${terminals} terminals have resolved net IDs.`,
    `The model will receive ${request.circuit.namedNets.length} named nets and ${request.circuit.warnings?.length ?? 0} extraction/netlist warnings.`,
    "No hard-coded functional-block findings are generated. Structured LLM hypotheses are shown as read-only cards; device and net references are used only for optional navigation.",
  ];
}

/**
 * Prepares the user-selected snapshot for LLM analysis. It intentionally does
 * not match current mirrors, differential pairs, bandgaps, or any other circuit
 * function. Those are reasoning tasks delegated to the configured model.
 */
export function analyseSubcircuits(
  dieId: string,
  annotationsRev: number,
  request: AssistantAnalysisRequest,
): AssistantAnalysisResult {
  if (!request.circuit || !Array.isArray(request.circuit.devices) || !Array.isArray(request.circuit.namedNets)) {
    throw new Error("A circuit extraction snapshot with devices and namedNets is required.");
  }
  if (request.circuit.devices.length > MAX_DEVICES_PER_REQUEST) {
    throw new Error(`Circuit snapshot exceeds the ${MAX_DEVICES_PER_REQUEST} device read-only safety limit.`);
  }
  const brief: AssistantAnalysisBrief = request.brief ?? {};
  const names: NetNames = new Map(request.circuit.namedNets.map((item) => [item.id, item.name]));
  const devices = selectedScope(request).filter((device) => device.uuid && device.instanceName && Array.isArray(device.terminals));
  return {
    schemaVersion: 1,
    readOnly: true,
    dieId,
    annotationsRev,
    scope: request.scope ?? "die",
    mode: request.mode ?? "functional_blocks",
    brief,
    devicesAnalyzed: devices.length,
    netlistPreview: devices.map((device) => deviceLine(device, names)),
    findings: [],
    diagnostics: diagnosticsFor(devices, request),
    llm: {
      requested: request.requestLlmExplanation === true,
      used: false,
      ...(request.requestLlmExplanation ? { unavailableReason: "LLM full-netlist analysis has not started." } : {}),
    },
    summary: `Prepared ${devices.length} extracted device(s) for ${request.mode === "netlist_problems" ? "netlist-problem" : "functional-block"} LLM analysis.`,
  };
}

