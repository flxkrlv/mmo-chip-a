import type { AssistantCircuitDeviceInput, AssistantCircuitSnapshot } from "shared";

/**
 * Pending vision request stored in memory while the frontend renders the
 * device crop + terminal overlay.  The tool loop awaits the Promise that
 * resolves when the frontend POSTs the rendered images back.
 */
export interface PendingVisionRequest {
  requestId: string;
  dieId: string;
  deviceUuids: string[];
  /** Optional layer name requested by the model. */
  layerName?: string;
  /** Resolved device info returned to the frontend for rendering. */
  devices: Array<{
    uuid: string;
    instanceName: string;
    kind: string;
    cellId?: string;
    bbox?: { x: number; y: number; width: number; height: number };
  }>;
  resolve: (images: string[], layerName?: string) => void;
  reject: (err: Error) => void;
}

/** In-memory map of pending vision requests, keyed by requestId. */
export const pendingVisionRequests = new Map<string, PendingVisionRequest>();

const VISION_TIMEOUT_MS = 30_000;

/**
 * Resolve device UUIDs to their cell info from the snapshot.
 */
function resolveDevices(
  deviceUuids: string[],
  snapshot: AssistantCircuitSnapshot,
): PendingVisionRequest["devices"] {
  const devicesByName = new Map(snapshot.devices.map((d) => [d.uuid, d]));
  return deviceUuids
    .map((uuid) => {
      const dev = devicesByName.get(uuid);
      if (!dev) return null;
      return {
        uuid: dev.uuid,
        instanceName: dev.instanceName,
        kind: dev.kind,
        cellId: dev.cellId,
        bbox: dev.bbox,
      };
    })
    .filter((d): d is NonNullable<typeof d> => d !== null);
}

/**
 * Build per-cell netlist text for the LLM — a simple SPICE-like listing of
 * all devices in the same cell, so the model understands context.
 */
function buildCellNetlist(
  cellId: string | undefined,
  snapshot: AssistantCircuitSnapshot,
  targetUuids: Set<string>,
): string {
  const cellDevices = snapshot.devices.filter((d) => d.cellId === cellId);
  if (cellDevices.length === 0) return "";
  const lines = cellDevices.map((d) => {
    const terms = d.terminals.map((t) => `${t.name}=net${t.netId}`).join(" ");
    const geo = d.geometry as unknown as Record<string, unknown>;
    const params = ["mosType", "W_um", "L_um", "AE_um2", "PE_um", "resistance_ohms"]
      .filter((k) => typeof geo[k] === "string" || typeof geo[k] === "number")
      .map((k) => `${k}=${String(geo[k])}`)
      .join(" ");
    const marker = targetUuids.has(d.uuid) ? " ← requested" : "";
    return `* ${d.instanceName} (${d.kind}) ${terms}${params ? ` ${params}` : ""}${marker}`;
  });
  return `* Per-cell netlist for ${cellId} (${cellDevices.length} devices):\n${lines.join("\n")}`;
}

/**
 * Execute the mmochip_vision tool call.  Stores a pending request and
 * waits for the frontend to render device crops + terminal overlays.
 */
export async function executeVisionTool(
  args: { deviceUuids?: string[]; layerName?: string },
  snapshot: AssistantCircuitSnapshot,
  dieId: string,
): Promise<{ text: string; images: string[]; layerName?: string }> {
  const deviceUuids = args.deviceUuids ?? [];
  if (deviceUuids.length === 0) {
    return { text: JSON.stringify({ error: "deviceUuids is required" }), images: [] };
  }

  const resolved = resolveDevices(deviceUuids, snapshot);
  if (resolved.length === 0) {
    return {
      text: JSON.stringify({ error: `No devices found for the supplied UUIDs: ${deviceUuids.join(", ")}` }),
      images: [],
    };
  }

  const requestId = `vision-${dieId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const targetUuids = new Set(deviceUuids);

  const { images, layerName } = await new Promise<{ images: string[]; layerName?: string }>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingVisionRequests.delete(requestId);
      reject(new Error(`Frontend did not respond to vision request ${requestId} within ${VISION_TIMEOUT_MS / 1000}s`));
    }, VISION_TIMEOUT_MS);

    pendingVisionRequests.set(requestId, {
      requestId,
      dieId,
      deviceUuids,
      layerName: args.layerName,
      devices: resolved,
      resolve: (imgs, layer) => { clearTimeout(timeout); resolve({ images: imgs, layerName: layer }); },
      reject: (err) => { clearTimeout(timeout); reject(err); },
    });
  });

  // Build per-cell netlist context for the LLM
  const cellIds = new Set(resolved.map((d) => d.cellId).filter(Boolean));
  const netlistParts: string[] = [];
  for (const cid of cellIds) {
    const text = buildCellNetlist(cid, snapshot, targetUuids);
    if (text) netlistParts.push(text);
  }

  const deviceLabels = resolved.map((d) => `${d.instanceName} (${d.kind})`).join(", ");
  const layerInfo = layerName ? ` Visible layer: ${layerName}.` : "";
  const text = [
    `Device crop(s) for ${deviceLabels} — rendered with device name and terminal labels (C/B/E or D/G/S).${layerInfo}`,
    netlistParts.join("\n\n"),
  ].filter(Boolean).join("\n\n");

  return { text, images, layerName };
}
