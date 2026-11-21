import { describe, expect, it } from "vitest";
import type { AnalogDevice } from "shared";
import { circuitFingerprint, fnv1a } from "./circuitFingerprint";

function resistor(netA: number, netB: number, ohms = 1000): AnalogDevice {
  return {
    id: "device-1",
    kind: "resistor",
    cellTypeId: "",
    instanceName: "R1",
    terminals: [
      { name: "p", netId: netA },
      { name: "n", netId: netB },
    ],
    geometry: { resistance_ohms: ohms } as AnalogDevice["geometry"],
  };
}

describe("circuitFingerprint", () => {
  it("is stable across device and terminal order", () => {
    const first = resistor(1, 2);
    const reordered: AnalogDevice = {
      ...first,
      terminals: [...first.terminals].reverse(),
    };
    expect(circuitFingerprint([first], { netA: 1, netB: 2 })).toBe(
      circuitFingerprint([reordered], { netB: 2, netA: 1 }),
    );
  });

  it("changes when a connection changes but not a calculated value", () => {
    const base = circuitFingerprint([resistor(1, 2)], {});
    expect(circuitFingerprint([resistor(1, 3)], {})).not.toBe(base);
    expect(circuitFingerprint([resistor(1, 2, 2000)], {})).toBe(base);
  });

  it("changes when a net name or an instance name changes", () => {
    const device = resistor(1, 2);
    expect(
      circuitFingerprint([device], new Map([[1, "VIN"]])),
    ).not.toBe(circuitFingerprint([device], new Map([[1, "IN"]])));
    expect(
      circuitFingerprint([{ ...device, instanceName: "R2" }], {}),
    ).not.toBe(circuitFingerprint([device], {}));
  });

  it("hashes to eight hex digits", () => {
    expect(fnv1a("bandgap")).toMatch(/^[0-9a-f]{8}$/);
  });
});
