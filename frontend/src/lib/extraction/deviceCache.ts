import type { CellType, AnalogDevice, LayerShape } from "shared";

export interface DeviceCacheEntry {
  hash: string;
  devices: AnalogDevice[];
  computedAt: number;
}

export interface CellTypeDeviceCacheOptions {
  maxEntries?: number;
}

const FNV_OFFSET_BASIS_64 = 0xcbf29ce484222325n;
const FNV_PRIME_64 = 0x100000001b3n;

export function fnv1a64(data: Uint8Array): string {
  let hash = FNV_OFFSET_BASIS_64;
  for (let i = 0; i < data.length; i++) {
    hash ^= BigInt(data[i]);
    hash = (hash * FNV_PRIME_64) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}

const textEncoder = new TextEncoder();

function canonicalizeLayers(
  layers: Record<string, LayerShape[] | undefined>
): Record<string, LayerShape[]> {
  const keys = Object.keys(layers).sort();
  const out: Record<string, LayerShape[]> = {};
  for (const k of keys) {
    const shapes = layers[k];
    if (shapes && shapes.length > 0) {
      out[k] = shapes;
    }
  }
  return out;
}

function serializeCellTypeForHash(
  id: string,
  layers: Record<string, LayerShape[] | undefined> | undefined,
  umPerPx: number,
): string {
  const canonicalLayers = layers ? canonicalizeLayers(layers) : {};
  return JSON.stringify({ id, umPerPx, layers: canonicalLayers });
}

export function computeCellTypeHash(
  id: string,
  layers: Record<string, LayerShape[] | undefined> | undefined,
  umPerPx: number,
): string {
  const serialized = serializeCellTypeForHash(id, layers, umPerPx);
  const bytes = textEncoder.encode(serialized);
  return fnv1a64(bytes);
}

export class CellTypeDeviceCache {
  private maxEntries: number;
  private map = new Map<string, DeviceCacheEntry>();

  constructor(options: CellTypeDeviceCacheOptions = {}) {
    this.maxEntries = options.maxEntries ?? 500;
  }

  get(cellTypeId: string): DeviceCacheEntry | undefined {
    const entry = this.map.get(cellTypeId);
    if (entry) {
      this.map.delete(cellTypeId);
      this.map.set(cellTypeId, entry);
    }
    return entry;
  }

  set(cellTypeId: string, entry: DeviceCacheEntry): void {
    if (this.map.has(cellTypeId)) {
      this.map.delete(cellTypeId);
    } else if (this.map.size >= this.maxEntries) {
      const oldest = this.map.keys().next();
      if (!oldest.done) {
        this.map.delete(oldest.value);
      }
    }
    this.map.set(cellTypeId, entry);
  }

  invalidate(cellTypeId: string): void {
    this.map.delete(cellTypeId);
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}

export function extractDevicesForCellType(
  ct: CellType,
  umPerPx: number,
  cache: CellTypeDeviceCache,
  extractFn: (ct: CellType, umPerPx: number) => AnalogDevice[],
): AnalogDevice[] {
  const layers = ct.layers as Record<string, LayerShape[] | undefined> | undefined;
  const hash = computeCellTypeHash(ct.id, layers, umPerPx);
  const cached = cache.get(ct.id);
  if (cached && cached.hash === hash) {
    return cached.devices;
  }

  const devices = extractFn(ct, umPerPx);
  cache.set(ct.id, { hash, devices, computedAt: Date.now() });
  return devices;
}
