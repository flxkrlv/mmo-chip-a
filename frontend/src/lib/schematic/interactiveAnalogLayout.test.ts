import { describe, it, expect } from "vitest";
import {
  routeNetLocal,
  gridFallback,
  buildNetIndex,
  powerDevices,
  deviceKey,
  runInteractiveLayout,
  type Obstacle,
} from "./interactiveAnalogLayout";
import { parseSymbolSkin } from "./interactiveSymbols";
import type { AnalogDevice } from "shared";

const table = parseSymbolSkin();

function mos(name: string, mosType: "nmos" | "pmos", terminals: Array<[string, number]>): AnalogDevice {
  return {
    id: name,
    kind: "mos",
    instanceName: name,
    layer: "poly",
    bbox: { x: 0, y: 0, width: 1, height: 1 },
    geometry: { mosType, W_um: 1, L_um: 0.5 },
    terminals: terminals.map(([t, netId]) => ({ name: t, netId })),
  } as unknown as AnalogDevice;
}

function res(name: string, terminals: Array<[string, number]>): AnalogDevice {
  return {
    id: name,
    kind: "resistor",
    instanceName: name,
    layer: "poly",
    bbox: { x: 0, y: 0, width: 1, height: 1 },
    geometry: { resistance_ohms: 1000, squares: 10, resistorType: "poly" },
    terminals: terminals.map(([t, netId]) => ({ name: t, netId })),
  } as unknown as AnalogDevice;
}

describe("buildNetIndex", () => {
  it("maps terminals to nets incl. power devices", () => {
    const devices = [
      mos("M_1", "nmos", [["D", 5], ["G", 6], ["S", 7], ["B", 8]]),
    ];
    const nets = new Map([[7, "VDD"]]);
    const powers = powerDevices(devices, nets, { vdd: "VDD", gnd: "GND" });
    expect(powers).toHaveLength(1);
    expect(powers[0].instanceName).toBe("VDD");
    const idx = buildNetIndex(devices, {}, powers);
    expect(idx.get(5)).toEqual([{ deviceKey: "M_1", terminal: "D" }]);
    expect(idx.get(7)).toEqual([
      { deviceKey: "M_1", terminal: "S" },
      { deviceKey: "VDD", terminal: "PLUS" },
    ]);
  });
});

describe("routeNetLocal", () => {
  const noObs: Obstacle[] = [];

  it("two anchors → single polyline, orthogonal, deterministic", () => {
    const w1 = routeNetLocal([{ x: 0, y: 0 }, { x: 100, y: 50 }], noObs);
    expect(w1.polylines).toHaveLength(1);
    expect(w1.junctions).toHaveLength(0);
    const path = w1.polylines[0];
    expect(path[0]).toEqual({ x: 0, y: 0 });
    expect(path[path.length - 1]).toEqual({ x: 100, y: 50 });
    for (let i = 1; i < path.length; i++) {
      // each segment axis-aligned
      expect(path[i].x === path[i - 1].x || path[i].y === path[i - 1].y).toBe(true);
    }
    const w2 = routeNetLocal([{ x: 0, y: 0 }, { x: 100, y: 50 }], noObs);
    expect(w2).toEqual(w1);
  });

  it("avoids an obstacle between anchors when a clean candidate exists", () => {
    // Straight H-first route would cross the box at (40..60, 20..30)
    const obs: Obstacle[] = [{ x: 40, y: 20, w: 20, h: 10 }];
    const w = routeNetLocal([{ x: 0, y: 25 }, { x: 100, y: 25 }], obs);
    // Path must not pass through the obstacle interior
    for (const line of w.polylines) {
      for (let i = 1; i < line.length; i++) {
        const a = line[i - 1], b = line[i];
        const y = a.y;
        if (y > 20 - 4 && y < 30 + 4) {
          const lo = Math.min(a.x, b.x), hi = Math.max(a.x, b.x);
          expect(hi <= 40 - 4 || lo >= 60 + 4).toBe(true);
        }
      }
    }
  });

  it("three anchors → hub with junction", () => {
    const w = routeNetLocal(
      [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 50, y: 100 }],
      noObs,
    );
    expect(w.polylines).toHaveLength(3);
    expect(w.junctions).toHaveLength(1);
    // hub is median of xs=50, ys=0
    expect(w.junctions[0]).toEqual({ x: 50, y: 0 });
  });

  it("empty / single anchors → no wires", () => {
    expect(routeNetLocal([], noObs).polylines).toHaveLength(0);
    expect(routeNetLocal([{ x: 5, y: 5 }], noObs).polylines).toHaveLength(0);
  });
});

describe("gridFallback", () => {
  it("places all devices deterministically and routes wires locally", () => {
    const devices = [
      mos("M_1", "nmos", [["D", 1], ["G", 2], ["S", 3], ["B", 3]]),
      mos("M_2", "pmos", [["D", 1], ["G", 2], ["S", 4], ["B", 4]]),
      res("R_1", [["PLUS", 1], ["MINUS", 2]]),
    ];
    const nets = new Map([
      [1, "n1"], [2, "n2"], [3, "VDD"], [4, "GND"],
    ]);
    const result = gridFallback(devices, nets, table, { vdd: "VDD", gnd: "GND" });
    expect(result.usedFallback).toBe(true);
    expect(Object.keys(result.positions).sort()).toEqual(["GND", "M_1", "M_2", "R_1", "VDD"].sort());
    // Every net got routed
    for (const netId of [1, 2, 3, 4]) {
      const w = result.wires.get(netId);
      expect(w, `net ${netId} unrouted`).toBeDefined();
      expect(w!.polylines.length).toBeGreaterThan(0);
    }
    // VDD (net 3) wires reach both M_1.S and VDD pin — ≥2 terminals
    expect(result.wires.get(3)!.polylines.length).toBeGreaterThanOrEqual(2);
    // bbox sane
    expect(result.bbox.width).toBeGreaterThan(0);
    expect(result.bbox.height).toBeGreaterThan(0);
  });
});

describe("deviceKey", () => {
  it("prefers instanceName over id", () => {
    expect(deviceKey(mos("M_9", "nmos", []))).toBe("M_9");
  });
});

describe("runInteractiveLayout (ELK, node)", () => {
  it("applies requested strategy/direction/compaction and echoes them back", async () => {
    const devices = [
      mos("M_1", "nmos", [["D", 1], ["G", 2], ["S", 3], ["B", 3]]),
      mos("M_2", "pmos", [["D", 1], ["G", 2], ["S", 3], ["B", 3]]),
    ];
    const nets = new Map([[1, "n1"], [2, "n2"], [3, "VDD"]]);
    const res = await runInteractiveLayout(devices, nets, table, {
      vdd: "VDD", gnd: "GND",
      strategy: "BRANDES_KOEPF",
      direction: "DOWN",
      compaction: 4,
    });
    expect(res.usedFallback).toBe(false);
    expect(res.applied).toEqual({ strategy: "BRANDES_KOEPF", direction: "DOWN", compaction: 4 });
    expect(Object.keys(res.positions).sort()).toEqual(["M_1", "M_2", "VDD"]);
    // DOWN direction: VDD symbol (driver) above the nmos S pin it feeds
    expect(res.positions["VDD"].y).toBeLessThan(res.positions["M_1"].y);
    expect(res.wires.get(1)?.polylines.length).toBeGreaterThan(0);
  }, 30000);

  it("direction RIGHT puts the driver left of its consumer", async () => {
    const devices = [
      mos("M_1", "nmos", [["D", 1], ["G", 2], ["S", 3], ["B", 3]]),
      mos("M_2", "pmos", [["D", 1], ["G", 2], ["S", 3], ["B", 3]]),
    ];
    const nets = new Map([[1, "n1"], [2, "n2"], [3, "VDD"]]);
    const res = await runInteractiveLayout(devices, nets, table, {
      vdd: "VDD", gnd: "GND",
      strategy: "SIMPLE",
      direction: "RIGHT",
      compaction: 0,
    });
    expect(res.applied?.direction).toBe("RIGHT");
    expect(res.positions["VDD"].x).toBeLessThan(res.positions["M_2"].x);
  }, 30000);

  // Regression: nets used to lose ALL their ELK edges (and thus wires)
  // when the chosen driver was locked or portless — the wire only
  // appeared after the user dragged one of the net's devices.
  function mirrorCircuit(): Array<[AnalogDevice[], Map<number, string>]> {
    const devices = [
      // classic NMOS current mirror: M_1 diode-connected
      mos("M_1", "nmos", [["D", 2], ["G", 2], ["S", 3], ["B", 3]]),
      mos("M_2", "nmos", [["D", 1], ["G", 2], ["S", 3], ["B", 3]]),
      res("R_1", [["PLUS", 4], ["MINUS", 1]]),
    ];
    const nets = new Map([[1, "out"], [2, "gate"], [3, "GND"], [4, "VDD"]]);
    return [[devices, nets]];
  }

  it("mirror circuit: EVERY net gets routed wires after ELK", async () => {
    const [devices, nets] = mirrorCircuit()[0];
    const res = await runInteractiveLayout(devices, nets, table, {
      vdd: "VDD", gnd: "GND", strategy: "BRANDES_KOEPF", direction: "DOWN", compaction: 2,
    });
    expect(res.usedFallback).toBe(false);
    for (const netId of [1, 2, 3, 4]) {
      const w = res.wires.get(netId);
      expect(w, `net ${netId} has no wires`).toBeDefined();
      expect(w!.polylines.length, `net ${netId} empty polylines`).toBeGreaterThan(0);
    }
  }, 30000);

  it("locked driver does not orphan its net (fallback driver)", async () => {
    const [devices, nets] = mirrorCircuit()[0];
    // M_3 joins the gate net; M_1 (its first member / pseudo-driver) is
    // locked. ELK edges cannot reference a locked node, but the net
    // must still be routed between the UNLOCKED members.
    devices.push(mos("M_3", "nmos", [["D", 5], ["G", 2], ["S", 3], ["B", 3]]));
    nets.set(5, "out2");
    const res = await runInteractiveLayout(devices, nets, table, {
      vdd: "VDD", gnd: "GND",
      excludeKeys: new Set(["M_1"]),
    });
    expect(res.usedFallback).toBe(false);
    // gate net still has ELK wires between unlocked members
    expect(res.wires.get(2)?.polylines.length ?? 0).toBeGreaterThan(0);
    // locked M_1 itself has no ELK position (excluded from the graph)
    expect(res.positions["M_1"]).toBeUndefined();
  }, 30000);
});
