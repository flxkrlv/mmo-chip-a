import type {
  AnalogDevice,
  AssistantAnalysisBrief,
  AssistantAnalysisMode,
  AssistantAnalysisRequest,
  AssistantAnalysisResponse,
  AssistantAnalysisResult,
  AssistantAnalysisScope,
  AssistantChatMessage,
  AssistantDataFlags,
  AssistantDiscussFinding,
  AssistantDiscussRequest,
  AssistantDiscussResponse,
  AssistantFindingPatch,
  AssistantLlmConfig,
  AssistantLvsCheckRequest,
  AssistantLvsCheckResponse,
  AssistantLvsLibrarySummary,
  AssistantToolFlags,
} from "shared";
import { apiGet, apiPost, authHeaders, ApiError } from "./client";

/**
 * Converts the current browser extraction to a serialisable read-only snapshot.
 * The backend receives only data already visible in the application; it never
 * receives a client credential and it never writes this snapshot to annotations.
 */
export function buildAssistantCircuitSnapshot(
  devices: AnalogDevice[],
  netNames: Map<number, string>,
  warnings?: string[],
  overlayLayers?: Array<{ id: string; name: string }>,
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
    overlayLayers,
  };
}

function buildAnalyseRequest(
  input: Parameters<typeof analyseAssistantCircuit>[1],
): AssistantAnalysisRequest {
  return {
    expectedRev: input.expectedRev,
    scope: input.scope,
    mode: input.mode,
    selectedDeviceUuids: input.selectedDeviceUuids,
    selectedNetIds: input.selectedNetIds,
    circuit: buildAssistantCircuitSnapshot(input.devices, input.netNames, input.warnings, input.overlayLayers),
    brief: input.brief,
    requestLlmExplanation: input.requestLlmExplanation,
    llmConfig: input.llmConfig,
    assistantDataFlags: input.assistantDataFlags,
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
    overlayLayers?: Array<{ id: string; name: string }>;
    assistantDataFlags?: AssistantDataFlags;
  },
): Promise<AssistantAnalysisResult> {
  const response = await apiPost<AssistantAnalysisResponse>(
    `/api/dies/${encodeURIComponent(dieId)}/assistant/analyze`,
    buildAnalyseRequest(input),
  );
  return response.data;
}

/**
 * Sends one user turn of a per-finding discussion to the backend. The backend
 * forwards the FULL extracted netlist to the model (so it can reason about
 * components outside the finding's immediate fragment) while using the finding
 * to set the conversational focus. Never writes annotations.
 */
export async function discussFinding(
  dieId: string,
  input: {
    expectedRev?: number;
    finding: AssistantDiscussFinding;
    messages: AssistantChatMessage[];
    devices: AnalogDevice[];
    netNames: Map<number, string>;
    warnings?: string[];
    brief?: AssistantAnalysisBrief;
    mode?: AssistantAnalysisMode;
    llmConfig?: AssistantLlmConfig;
    toolFlags?: AssistantToolFlags;
    overlayLayers?: Array<{ id: string; name: string }>;
    assistantDataFlags?: AssistantDataFlags;
  },
  signal?: AbortSignal,
): Promise<{ reply: string; cardUpdate: AssistantFindingPatch | null; lvsResults: Array<AssistantLvsCheckResponse["data"]> }> {
  const response = await apiPost<AssistantDiscussResponse>(
    `/api/dies/${encodeURIComponent(dieId)}/assistant/discuss`,
    buildDiscussRequest(input),
    signal,
  );
  return { reply: response.reply, cardUpdate: response.cardUpdate ?? null, lvsResults: response.lvsResults ?? [] };
}

function buildDiscussRequest(
  input: Parameters<typeof discussFinding>[1],
): AssistantDiscussRequest {
  return {
    expectedRev: input.expectedRev,
    finding: input.finding,
    messages: input.messages,
    circuit: buildAssistantCircuitSnapshot(input.devices, input.netNames, input.warnings, input.overlayLayers),
    brief: input.brief,
    mode: input.mode,
    toolFlags: input.toolFlags,
    llmConfig: input.llmConfig,
    assistantDataFlags: input.assistantDataFlags,
  };
}

// ── Streaming (SSE) client for analyse/discuss ──

export interface AssistantStreamEvent {
  type: "token" | "thinking" | "tool_start" | "tool_result" | "done" | "error";
  content?: string;
  tool?: string;
  args?: unknown;
  ok?: boolean;
  images?: number;
  reply?: string;
  cardUpdate?: AssistantFindingPatch | null;
  lvsResults?: Array<AssistantLvsCheckResponse["data"]>;
  data?: unknown;
  error?: string;
}

export interface AssistantStreamHandlers {
  onEvent: (ev: AssistantStreamEvent) => void;
  signal?: AbortSignal;
}

function parseSseBlock(block: string): { event: string; data: unknown } {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  let data: unknown = null;
  const joined = dataLines.join("\n");
  try {
    data = joined ? JSON.parse(joined) : null;
  } catch {
    data = joined;
  }
  return { event, data };
}

/** Reads a backend Server-Sent Events stream, dispatching each event via onEvent. */
export async function streamAssistantRequest(
  path: string,
  body: unknown,
  handlers: AssistantStreamHandlers,
): Promise<void> {
  const response = await fetch(path, {
    method: "POST",
    signal: handlers.signal,
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text();
    let errBody: unknown = null;
    try {
      errBody = text ? JSON.parse(text) : null;
    } catch {
      /* ignore */
    }
    const message =
      (errBody && typeof errBody === "object" && "error" in errBody && typeof (errBody as { error: unknown }).error === "string"
        ? (errBody as { error: string }).error
        : null) || response.statusText || `HTTP ${response.status}`;
    throw new ApiError(response.status, message, errBody);
  }
  if (!response.body) throw new ApiError(500, "Empty streaming response", null);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const { event, data } = parseSseBlock(block);
      if (event && data && typeof data === "object") {
        handlers.onEvent({ type: event as AssistantStreamEvent["type"], ...(data as Record<string, unknown>) } as AssistantStreamEvent);
      }
    }
  }
}

/**
 * Streaming full-graph analysis. Resolves with the full result once the backend
 * emits `done`; progress tokens/thinking arrive via onEvent while it runs.
 */
export async function analyseAssistantCircuitStream(
  dieId: string,
  input: Parameters<typeof analyseAssistantCircuit>[1],
  handlers: AssistantStreamHandlers,
): Promise<AssistantAnalysisResult> {
  let final: AssistantAnalysisResult | null = null;
  let streamError: string | null = null;
  await streamAssistantRequest(
    `/api/dies/${encodeURIComponent(dieId)}/assistant/analyze/stream`,
    buildAnalyseRequest(input),
    {
      signal: handlers.signal,
      onEvent: (ev) => {
        handlers.onEvent(ev);
        if (ev.type === "done" && ev.data) final = ev.data as AssistantAnalysisResult;
        if (ev.type === "error" && typeof ev.error === "string") streamError = ev.error;
      },
    },
  );
  if (streamError) throw new ApiError(502, streamError, null);
  if (!final) throw new ApiError(500, "Analysis stream ended without a result", null);
  return final;
}

/**
 * Streaming discussion. Reply tokens arrive via onEvent as they are generated;
 * resolves with the final reply + optional cardUpdate + LVS results.
 */
export async function discussFindingStream(
  dieId: string,
  input: Parameters<typeof discussFinding>[1],
  handlers: AssistantStreamHandlers,
): Promise<{ reply: string; cardUpdate: AssistantFindingPatch | null; lvsResults: Array<AssistantLvsCheckResponse["data"]> }> {
  let final: { reply: string; cardUpdate: AssistantFindingPatch | null; lvsResults: Array<AssistantLvsCheckResponse["data"]> } | null = null;
  let streamError: string | null = null;
  await streamAssistantRequest(
    `/api/dies/${encodeURIComponent(dieId)}/assistant/discuss/stream`,
    buildDiscussRequest(input),
    {
      signal: handlers.signal,
      onEvent: (ev) => {
        handlers.onEvent(ev);
        if (ev.type === "done" && typeof ev.reply === "string") {
          final = { reply: ev.reply, cardUpdate: ev.cardUpdate ?? null, lvsResults: ev.lvsResults ?? [] };
        }
        if (ev.type === "error" && typeof ev.error === "string") streamError = ev.error;
      },
    },
  );
  if (streamError) throw new ApiError(502, streamError, null);
  if (!final) throw new ApiError(500, "Discussion stream ended without a result", null);
  return final;
}

/** Lists available reference LVS libraries (e.g. analog-circuits-sky130). */
export async function listAssistantLvsLibraries(
  dieId: string,
  signal?: AbortSignal,
): Promise<AssistantLvsLibrarySummary[]> {
  const response = await apiGet<{ ok: boolean; data: AssistantLvsLibrarySummary[] }>(
    `/api/dies/${encodeURIComponent(dieId)}/assistant/lvs-libraries`,
    signal,
  );
  return response.data ?? [];
}

/** Add a user-supplied SPICE subcircuit as a reference cell in the given library. */
export async function addLvsCell(
  dieId: string,
  libId: string,
  cellId: string,
  spice: string,
): Promise<{ libId: string; cellCount: number }> {
  const response = await apiPost<{ ok: boolean; data: { libId: string; cellCount: number } }>(
    `/api/dies/${encodeURIComponent(dieId)}/assistant/lvs-library/${encodeURIComponent(libId)}/cell`,
    { cellId, spice },
  );
  return response.data;
}

/**
 * Streaming LVS reference-library check for the selected devices. See
 * {@link checkAssistantLvsStream}.
 */
export interface LvsCheckProgress {
  checked: number;
  total: number;
}

/**
 * Streaming LVS check. The backend emits Server-Sent Events (`progress` frames
 * with live counts, then a final `result` frame), so a large group check
 * (thousands of reference cells) stays responsive and never hits the request
 * timeout. Resolves with the final result data.
 */
export async function checkAssistantLvsStream(
  dieId: string,
  input: {
    devices: AnalogDevice[];
    netNames: Map<number, string>;
    warnings?: string[];
    deviceUuids: string[];
    libraryId?: string;
    topologies?: string[];
    tolerance?: number;
    budget?: number;
    overlayLayers?: Array<{ id: string; name: string }>;
  },
  handlers: { onProgress?: (p: LvsCheckProgress) => void; signal?: AbortSignal } = {},
): Promise<AssistantLvsCheckResponse["data"]> {
  const request: AssistantLvsCheckRequest = {
    circuit: buildAssistantCircuitSnapshot(input.devices, input.netNames, input.warnings, input.overlayLayers),
    deviceUuids: input.deviceUuids,
    libraryId: input.libraryId,
    topologies: input.topologies,
    tolerance: input.tolerance,
    budget: input.budget,
  };
  const path = `/api/dies/${encodeURIComponent(dieId)}/assistant/lvs-check`;
  const response = await fetch(path, {
    method: "POST",
    signal: handlers.signal,
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(request),
  });

  if (!response.ok || !response.body) {
    const text = await response.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      /* ignore */
    }
    const message =
      (body && typeof body === "object" && "error" in body && typeof (body as { error: unknown }).error === "string"
        ? (body as { error: string }).error
        : null) || response.statusText || `HTTP ${response.status}`;
    throw new ApiError(response.status, message, body);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finalData: AssistantLvsCheckResponse["data"] | null = null;

  const parseBlock = (block: string): { event: string; data: unknown } => {
    let event = "message";
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    let data: unknown = null;
    const joined = dataLines.join("\n");
    try {
      data = joined ? JSON.parse(joined) : null;
    } catch {
      data = joined;
    }
    return { event, data };
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const { event, data } = parseBlock(block);
      if (event === "progress" && data) handlers.onProgress?.(data as LvsCheckProgress);
      else if (event === "result" && data) finalData = (data as AssistantLvsCheckResponse).data;
      else if (event === "error") {
        const err = data as { error?: string } | null;
        throw new ApiError(400, err?.error ?? "LVS check failed", data);
      }
    }
  }

  if (!finalData) throw new ApiError(500, "LVS stream ended without a result", null);
  return finalData;
}
