const MAX_EVENTS = 1_000;

export type OverlayDebugKind =
  | "camera"
  | "wave-start"
  | "tile-queued"
  | "tile-start"
  | "tile-loaded"
  | "tile-error"
  | "tile-cancelled"
  | "wave-complete";

export interface OverlayDebugEvent {
  atMs: number;
  kind: OverlayDebugKind;
  layerId?: string;
  sourceId?: string;
  viewportGeneration?: number;
  tile?: { z: number; x: number; y: number };
  details?: Record<string, number | string | boolean | null>;
}

interface OverlayDebugApi {
  enable: () => void;
  disable: () => void;
  clear: () => void;
  events: () => OverlayDebugEvent[];
  exportJson: () => string;
  download: () => void;
}

const events: OverlayDebugEvent[] = [];
const storageKey = "mmo:overlay-debug";

function enabled(): boolean {
  return typeof window !== "undefined" && window.localStorage.getItem(storageKey) === "1";
}

function push(event: OverlayDebugEvent): void {
  events.push(event);
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
}

export function overlayDebug(
  kind: OverlayDebugKind,
  payload: Omit<OverlayDebugEvent, "atMs" | "kind"> = {}
): void {
  if (!enabled()) return;
  const event: OverlayDebugEvent = {
    atMs: performance.now(),
    kind,
    ...payload
  };
  push(event);
  console.log("[mmo:overlay]", event);
}

function installGlobalApi(): void {
  if (typeof window === "undefined") return;
  const target = window as Window & { mmoOverlayDebug?: OverlayDebugApi };
  if (target.mmoOverlayDebug) return;

  target.mmoOverlayDebug = {
    enable: () => {
      window.localStorage.setItem(storageKey, "1");
      events.length = 0;
      console.info("[mmo:overlay] diagnostics enabled");
    },
    disable: () => {
      window.localStorage.removeItem(storageKey);
      console.info("[mmo:overlay] diagnostics disabled");
    },
    clear: () => {
      events.length = 0;
      console.info("[mmo:overlay] diagnostics cleared");
    },
    events: () => [...events],
    exportJson: () => JSON.stringify(events, null, 2),
    download: () => {
      const blob = new Blob([JSON.stringify(events, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `mmo-overlay-debug-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
    }
  };
}

installGlobalApi();

declare global {
  interface Window {
    mmoOverlayDebug?: OverlayDebugApi;
  }
}
