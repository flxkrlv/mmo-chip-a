/**
 * capacitorDefaults.test.ts × the specific capacitance of a capacitor.
 *
 * A capacitor's capacitance is its plate area × the specific capacitance
 * (fF/μm²), the same way a resistor's resistance is its squares × the sheet
 * resistance. The number the user edits in Settings must reach the SPICE
 * netlist.
 */
import { describe, expect, test } from "vitest";
import type { AnalogDevice } from "shared";
import { generateSpiceNetlist } from "./spice";
import { formatDevicesAsNetlist2Svg } from "../schematic/netlist2svgFormat";
import {
  DEFAULT_CAP_DENSITY,
  effectiveCapDensity,
  effectiveCapacitance,
} from "./capacitorDefaults";

/** A capacitor with a 100 μm² plate. */
function cap(area_um2: number): AnalogDevice {
  return {
    id: "cap-1",
    kind: "capacitor",
    cellTypeId: "",
    instanceName: "C1",
    modelName: "capacitor",
    geometry: {
      area_um2,
      perimeter_um: 4 * Math.sqrt(area_um2),
      // The extractor fills this with the default density — the netlist must
      // not trust it.
      capacitance_fF: area_um2 * DEFAULT_CAP_DENSITY,
      multiplier: 1,
      capType: "mim",
    },
    terminals: [
      { name: "PLUS", netId: 1 },
      { name: "MINUS", netId: 2 },
    ],
  };
}

describe("the specific capacitance", () => {
  test("an unusable value falls back to the default", () => {
    expect(effectiveCapDensity(undefined)).toBe(DEFAULT_CAP_DENSITY);
    expect(effectiveCapDensity(0)).toBe(DEFAULT_CAP_DENSITY);
    expect(effectiveCapDensity(-3)).toBe(DEFAULT_CAP_DENSITY);
    expect(effectiveCapDensity(2.5)).toBe(2.5);
  });

  test("the capacitance is the plate area times the density", () => {
    expect(effectiveCapacitance({ area_um2: 100 }, 2)).toBe(200);
    expect(effectiveCapacitance({ area_um2: 100 }, 0.5)).toBe(50);
    // A capacitance the user pinned by hand wins over the derived one.
    expect(effectiveCapacitance({ area_um2: 100, capacitance_fF: 7 }, 2, true)).toBe(7);
  });

  test("the netlist carries the derived capacitance", () => {
    const { text } = generateSpiceNetlist([cap(100)], "test", {
      capDensity_fF_um2: 2,
    }, "spectre");
    expect(text).toMatch(/C1 \(net1 net2\) capacitor c=200\.000f/);
  });

  test("the netlist follows the density the user set", () => {
    const { text } = generateSpiceNetlist([cap(100)], "test", {
      capDensity_fF_um2: 0.25,
    }, "cdl");
    expect(text).toMatch(/C1 net1 net2 capacitor c=25\.000f/);
  });

  test("without a density the default keeps the old value", () => {
    const { text } = generateSpiceNetlist([cap(100)], "test", {}, "spectre");
    expect(text).toMatch(/C1 \(net1 net2\) capacitor c=100\.000f/);
  });

  test("the schematic label shows the derived capacitance", () => {
    const json = formatDevicesAsNetlist2Svg([cap(100)], new Map(), "test", {
      vdd: "VDD",
      gnd: "GND",
      hierarchical: false,
      capDensity_fF_um2: 2,
    });
    const cell = Object.values(json.modules.test.cells)[0] as {
      attributes?: Record<string, string>;
    };
    expect(cell.attributes?.value).toBe("200pF");
  });
});
