import { describe, it, expect } from "vitest";
import {
  CellTypeDeviceCache,
  computeCellTypeHash,
  extractDevicesForCellType,
} from "./deviceCache";
import type { CellType, AnalogDevice, LayerShape } from "shared";

function makeCellType(id: string, overrides: Partial<CellType> = {}): CellType {
  return {
    id,
    name: id,
    cropRect: { x: 0, y: 0, width: 10, height: 10 },
    ...overrides,
  };
}

function makeLayerShape(id: string): LayerShape {
  return { id, kind: "rect", x: 0, y: 0, width: 1, height: 1 };
}

describe("computeCellTypeHash", () => {
  it("produces consistent hash for same input", () => {
    const layers = { diffusion: [makeLayerShape("s1")] };
    const a = computeCellTypeHash("ct1", layers, 1.0);
    const b = computeCellTypeHash("ct1", layers, 1.0);
    expect(a).toBe(b);
  });

  it("changes when id changes", () => {
    const layers = { diffusion: [makeLayerShape("s1")] };
    const a = computeCellTypeHash("ct1", layers, 1.0);
    const b = computeCellTypeHash("ct2", layers, 1.0);
    expect(a).not.toBe(b);
  });

  it("changes when layers change", () => {
    const layersA = { diffusion: [makeLayerShape("s1")] };
    const layersB = { diffusion: [makeLayerShape("s2")] };
    const a = computeCellTypeHash("ct1", layersA, 1.0);
    const b = computeCellTypeHash("ct1", layersB, 1.0);
    expect(a).not.toBe(b);
  });

  it("changes when umPerPx changes", () => {
    const layers = { diffusion: [makeLayerShape("s1")] };
    const a = computeCellTypeHash("ct1", layers, 1.0);
    const b = computeCellTypeHash("ct1", layers, 2.0);
    expect(a).not.toBe(b);
  });

  it("ignores key order in layers", () => {
    const layersA: Record<string, LayerShape[]> = {
      polysilicon: [makeLayerShape("p1")],
      diffusion: [makeLayerShape("d1")],
    };
    const layersB: Record<string, LayerShape[]> = {
      diffusion: [makeLayerShape("d1")],
      polysilicon: [makeLayerShape("p1")],
    };
    const a = computeCellTypeHash("ct1", layersA, 1.0);
    const b = computeCellTypeHash("ct1", layersB, 1.0);
    expect(a).toBe(b);
  });

  it("handles undefined layers", () => {
    const hash = computeCellTypeHash("ct1", undefined, 1.0);
    expect(hash).toBeTruthy();
    expect(typeof hash).toBe("string");
  });
});

describe("CellTypeDeviceCache", () => {
  it("returns undefined on miss", () => {
    const cache = new CellTypeDeviceCache();
    expect(cache.get("unknown")).toBeUndefined();
  });

  it("returns entry after set", () => {
    const cache = new CellTypeDeviceCache();
    const entry = { hash: "abc", devices: [], computedAt: 100 };
    cache.set("ct1", entry);
    expect(cache.get("ct1")).toEqual(entry);
  });

  it("returns same reference on repeated get (LRU refresh)", () => {
    const cache = new CellTypeDeviceCache();
    const entry = { hash: "abc", devices: [], computedAt: 100 };
    cache.set("ct1", entry);
    expect(cache.get("ct1")).toBe(entry);
    expect(cache.get("ct1")).toBe(entry);
  });

  it("evicts oldest entry when over maxEntries", () => {
    const cache = new CellTypeDeviceCache({ maxEntries: 2 });
    cache.set("a", { hash: "1", devices: [], computedAt: 1 });
    cache.set("b", { hash: "2", devices: [], computedAt: 2 });
    cache.set("c", { hash: "3", devices: [], computedAt: 3 });
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBeDefined();
    expect(cache.get("c")).toBeDefined();
  });

  it("evicts least recently used when over maxEntries", () => {
    const cache = new CellTypeDeviceCache({ maxEntries: 2 });
    cache.set("a", { hash: "1", devices: [], computedAt: 1 });
    cache.set("b", { hash: "2", devices: [], computedAt: 2 });
    cache.get("a"); // touch a
    cache.set("c", { hash: "3", devices: [], computedAt: 3 });
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBeDefined();
    expect(cache.get("c")).toBeDefined();
  });

  it("updates existing entry on set", () => {
    const cache = new CellTypeDeviceCache();
    cache.set("ct1", { hash: "old", devices: [], computedAt: 100 });
    cache.set("ct1", { hash: "new", devices: [], computedAt: 200 });
    expect(cache.get("ct1")?.hash).toBe("new");
    expect(cache.size).toBe(1);
  });

  it("invalidate removes entry", () => {
    const cache = new CellTypeDeviceCache();
    cache.set("ct1", { hash: "abc", devices: [], computedAt: 100 });
    cache.invalidate("ct1");
    expect(cache.get("ct1")).toBeUndefined();
  });

  it("clear removes all entries", () => {
    const cache = new CellTypeDeviceCache();
    cache.set("a", { hash: "1", devices: [], computedAt: 1 });
    cache.set("b", { hash: "2", devices: [], computedAt: 2 });
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBeUndefined();
  });
});

describe("extractDevicesForCellType", () => {
  it("returns extracted devices on first call", () => {
    const cache = new CellTypeDeviceCache();
    const ct = makeCellType("ct1", {
      layers: { diffusion: [makeLayerShape("s1")] },
    });
    const extractFn = () => [{ id: "d1" } as AnalogDevice, { id: "d2" } as AnalogDevice];
    const result = extractDevicesForCellType(ct, 1.0, cache, extractFn);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("d1");
  });

  it("returns cached devices on second call (no extraction)", () => {
    const cache = new CellTypeDeviceCache();
    const ct = makeCellType("ct1", {
      layers: { diffusion: [makeLayerShape("s1")] },
    });
    let callCount = 0;
    const extractFn = () => {
      callCount++;
      return [{ id: "d1" } as AnalogDevice];
    };
    const first = extractDevicesForCellType(ct, 1.0, cache, extractFn);
    expect(first).toHaveLength(1);
    expect(callCount).toBe(1);
    const second = extractDevicesForCellType(ct, 1.0, cache, extractFn);
    expect(second).toHaveLength(1);
    expect(callCount).toBe(1);
  });

  it("re-extracts when layers change", () => {
    const cache = new CellTypeDeviceCache();
    const ct1 = makeCellType("ct1", {
      layers: { diffusion: [makeLayerShape("s1")] },
    });
    let callCount = 0;
    const extractFn = () => {
      callCount++;
      return [{ id: `d${callCount}` } as AnalogDevice];
    };
    extractDevicesForCellType(ct1, 1.0, cache, extractFn);
    expect(callCount).toBe(1);
    const ct2 = makeCellType("ct1", {
      layers: { diffusion: [makeLayerShape("s2")] },
    });
    extractDevicesForCellType(ct2, 1.0, cache, extractFn);
    expect(callCount).toBe(2);
  });

  it("re-extracts when umPerPx changes", () => {
    const cache = new CellTypeDeviceCache();
    const ct = makeCellType("ct1", {
      layers: { diffusion: [makeLayerShape("s1")] },
    });
    let callCount = 0;
    const extractFn = () => {
      callCount++;
      return [{ id: `d${callCount}` } as AnalogDevice];
    };
    extractDevicesForCellType(ct, 1.0, cache, extractFn);
    expect(callCount).toBe(1);
    extractDevicesForCellType(ct, 2.0, cache, extractFn);
    expect(callCount).toBe(2);
  });
});
