import type { AnalogDevice } from "shared";
import { useOverlayLayers } from "../../state/overlayLayers";

const TERM_COLORS: Record<string, string> = {
  D: "#ffcc44", S: "#66ee66", G: "#ffffff", B: "#aaaaaa",
  C: "#ff8844", E: "#44dd88",
  PLUS: "#44ddff", MINUS: "#ff6666",
};

const DEVICE_COLORS: Record<string, string> = {
  mos: "#4488ff", bjt_npn: "#22cc66", bjt_pnp: "#ff8844",
  resistor: "#ffaa44", capacitor: "#44ddff", diode: "#ff4444",
};

type TermPoint = { x: number; y: number; name: string };

/** Get the name of the topmost visible overlay layer, or "base image" if none. */
export function getTopVisibleLayerName(): string {
  const layers = useOverlayLayers.getState().layers;
  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i];
    if (!layer.hidden && layer.opacity > 0 && layer.loaded) return layer.name;
  }
  return "base image";
}

/** Resolve a layer name/id to its serverFilename (overlay source ID). Returns undefined for base image. */
export function resolveLayerNameToSourceId(layerName: string): string | undefined {
  const layers = useOverlayLayers.getState().layers;
  const lower = layerName.toLowerCase();
  // Special: base image (no overlay)
  if (lower === "__base__" || lower === "base" || lower === "base image" || lower === "original") return undefined;
  // Exact match by name
  const byName = layers.find((l) => l.name === layerName && l.serverFilename);
  if (byName) return byName.serverFilename;
  // Exact match by serverFilename or id
  const byId = layers.find((l) => (l.serverFilename === layerName || l.id === layerName) && l.serverFilename);
  if (byId) return byId.serverFilename;
  // Case-insensitive contains match on name
  const byNameContains = layers.find((l) => l.name.toLowerCase().includes(lower) && l.serverFilename);
  if (byNameContains) return byNameContains.serverFilename;
  // Case-insensitive contains match on serverFilename or id
  const byIdContains = layers.find((l) => ((l.serverFilename ?? "").toLowerCase().includes(lower) || l.id.toLowerCase().includes(lower)) && l.serverFilename);
  return byIdContains?.serverFilename;
}

/**
 * Render a cell crop with device name + terminal labels on an offscreen canvas.
 * When overlaySourceId is provided, the crop endpoint composites the overlay on
 * top of the base image, so the model sees exactly what the user sees.
 * Returns { image: base64 PNG, layerName?: string }.
 */
export async function renderDeviceCrop(
  dieId: string,
  device: AnalogDevice & { _termPoints?: TermPoint[]; _cellId?: string },
  allDevices: Array<AnalogDevice & { _termPoints?: TermPoint[]; _cellId?: string }>,
  overlaySourceId?: string,
): Promise<{ image: string; layerName?: string } | null> {
  const cellId = device._cellId;
  if (!cellId) return null;

  const bbox = device.bbox;
  if (!bbox) return null;

  const layerName = getTopVisibleLayerName();

  // Build crop URL — overlaySourceId makes the endpoint composite the overlay
  const overlayParam = overlaySourceId ? `&overlaySourceId=${encodeURIComponent(overlaySourceId)}` : "";
  const cropUrl = `/api/dies/${encodeURIComponent(dieId)}/cells/${encodeURIComponent(cellId)}/crop?x=${Math.round(bbox.x)}&y=${Math.round(bbox.y)}${overlayParam}`;

  const img = await loadImage(cropUrl);
  if (!img) return null;

  // Create offscreen canvas at the crop size
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth || img.width;
  canvas.height = img.naturalHeight || img.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  // Draw the crop image (with overlay already composited by the server)
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  // Scale factor — terminal labels need to be readable at the crop resolution
  const scale = Math.max(1, Math.min(canvas.width, canvas.height) / 200);

  // _termPoints are in die-world coordinates; crop starts at (bbox.x, bbox.y)
  const offsetX = bbox.x;
  const offsetY = bbox.y;

  // ── Draw device name label ──
  const termPoints = device._termPoints ?? [];
  const gateNames = getGateNames(device.kind);
  let labelX: number;
  let labelY: number;

  const gateAnchor = termPoints.find((pt) => gateNames.has(pt.name));
  if (gateAnchor) {
    labelX = gateAnchor.x - offsetX;
    labelY = gateAnchor.y - offsetY;
  } else {
    labelX = canvas.width / 2;
    labelY = canvas.height / 2;
  }

  const deviceColor = DEVICE_COLORS[device.kind] ?? "#ffffff";
  const name = device.instanceName ?? device.id.slice(0, 6);

  ctx.font = `700 ${10 * scale}px monospace`;
  const nameMetrics = ctx.measureText(name);
  const nameW = nameMetrics.width + 6;
  const nameH = 12 * scale + 4;
  ctx.fillStyle = "rgba(0,0,0,0.75)";
  ctx.fillRect(labelX - nameW / 2, labelY - nameH - 2, nameW, nameH);
  ctx.fillStyle = deviceColor;
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  ctx.fillText(name, labelX, labelY - 2);

  // ── Draw terminal labels ──
  ctx.font = `600 ${7 * scale}px monospace`;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";

  for (const pt of termPoints) {
    const color = TERM_COLORS[pt.name] ?? deviceColor;
    const displayName = pt.name;
    const px = pt.x - offsetX;
    const py = pt.y - offsetY;

    ctx.beginPath();
    ctx.arc(px, py, 2.5 * scale, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.6)";
    ctx.lineWidth = 0.5;
    ctx.stroke();

    const tm = ctx.measureText(displayName);
    const tw = tm.width + 4;
    const th = 7 * scale + 4;
    ctx.fillStyle = "rgba(0,0,0,0.7)";
    ctx.fillRect(px + 3, py - th / 2, tw, th);

    ctx.fillStyle = color;
    ctx.fillText(displayName, px + 5, py);
  }

  return { image: canvas.toDataURL("image/png").split(",")[1], layerName };
}

function getGateNames(kind: string): Set<string> {
  switch (kind) {
    case "mos": return new Set(["G"]);
    case "bjt_npn":
    case "bjt_pnp": return new Set(["B"]);
    case "jfet_n":
    case "jfet_p": return new Set(["G"]);
    default: return new Set();
  }
}

function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => { console.warn(`[vision] loadImage failed: ${url}`); resolve(null); };
    img.src = url;
  });
}
