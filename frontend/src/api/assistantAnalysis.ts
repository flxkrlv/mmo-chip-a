import type {
  AnalogDevice,
  AssistantAnalysisBrief,
  AssistantAnalysisMode,
  AssistantAnalysisRequest,
  AssistantAnalysisResponse,
  AssistantAnalysisResult,
  AssistantAnalysisScope,
  AssistantLlmConfig,
} from "shared";
import { apiPost } from "./client";

/**
 * Converts the current browser extraction to a serialisable read-only snapshot.
 * The backend receives only data already visible in the application; it never
 * receives a client credential and it never writes this snapshot to annotations.
 */
export function buildAssistantCircuitSnapshot(
  devices: AnalogDevice[],
  netNames: Map<number, string>,
  warnings?: string[],
): AssistantAnalysisRequest["circuit"] {
  return {
    devices: devices.map((device) => ({
      uuid: String((device as any)._uuid ?? device.id),
      instanceName: device.instanceName ?? device.id,
      kind: device.kind,
      modelName: device.modelName,
      terminals: device.terminals.map((terminal) => ({
        name: terminal.name,
        netId: terminal.netId,
        shapeIds: terminal.shapeIds ?? [],
      })),
      geometry: device.geometry,
      bbox: device.bbox,
      cellId: (device as any)._cellId as string | undefined,
    })),
    namedNets: [...netNames.entries()].map(([id, name]) => ({ id, name })),
    warnings,
  };
}

export async function analyseAssistantCircuit(
  dieId: string,
  input: {
    expectedRev?: number;
    scope: AssistantAnalysisScope;
    mode: AssistantAnalysisMode;
    devices: AnalogDevice[];
    netNames: Map<number, string>;
    warnings?: string[];
    selectedDeviceUuids?: string[];
    selectedNetIds?: number[];
    brief?: AssistantAnalysisBrief;
    requestLlmExplanation?: boolean;
    llmConfig?: AssistantLlmConfig;
  },
): Promise<AssistantAnalysisResult> {
  const request: AssistantAnalysisRequest = {
    expectedRev: input.expectedRev,
    scope: input.scope,
    mode: input.mode,
    selectedDeviceUuids: input.selectedDeviceUuids,
    selectedNetIds: input.selectedNetIds,
    circuit: buildAssistantCircuitSnapshot(input.devices, input.netNames, input.warnings),
    brief: input.brief,
    requestLlmExplanation: input.requestLlmExplanation,
    llmConfig: input.llmConfig,
  };
  const response = await apiPost<AssistantAnalysisResponse>(
    `/api/dies/${encodeURIComponent(dieId)}/assistant/analyze`,
    request,
  );
  return response.data;
}
