/// <reference types="node" />
import { describe, it, expect, beforeAll } from "vitest";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import type { AnalogDevice, CellType, DeviceGeometryBJT, DeviceGeometryMOS, LayerShape } from "shared";
import {
  buildAnalogPcell,
  defaultAnalogParams,
  validateAnalogParams,
  DEFAULT_ANALOG_LIB_RULES,
  type AnalogPcellSpec
} from "shared/analogLib";
import { loadClipperWithBinary } from "./extraction/clipper";
import {
  detectMOSFromLayers,
  extractMarkedDevices,
  resolveDeviceContacts
} from "./extraction/simpleAnalog";

const require = createRequire(import.meta.url);

/** 20 px per µm — the scale the test layouts are generated at. */
const SCALE = 20;
/** The matching die calibration: 1 µm = 20 px. */
const UM_PER_PX = 1 / SCALE;

beforeAll(async () => {
  const wasm = await readFile(require.resolve("clipper2-wasm/dist/es/clipper2z.wasm"));
  await loadClipperWithBinary(wasm);
});

function spec(
  params: AnalogPcellSpec["params"],
  scale = SCALE
): AnalogPcellSpec {
  return {
    template: params.kind === "mos" ? params.mosType : params.bjtType,
    params,
    scale,
    rules: { ...DEFAULT_ANALOG_LIB_RULES }
  };
}

/** The generated layout as a cell type the extractor can read. */
function asCellType(s: AnalogPcellSpec): CellType {
  const layout = buildAnalogPcell(s, "ct");
  return {
    id: "ct",
    name: "generated",
    cropRect: layout.cropRect,
    layers: layout.layers
  };
}

describe("buildAnalogPcell — MOS", () => {
  it("lays a pmos out with the layers the extractor needs", () => {
    const layout = buildAnalogPcell(
      spec({ ...defaultAnalogParams("pmos"), W_um: 10, L_um: 1, fingers: 1 }),
      "ct"
    );
    expect(layout.layers.diffusion).toHaveLength(1);
    expect(layout.layers.polysilicon?.length).toBeGreaterThanOrEqual(2); // gate + strap
    expect(layout.layers.nwell).toHaveLength(1);
    expect(layout.layers.pwell).toBeUndefined();
    expect(layout.layers.contact?.length).toBeGreaterThan(0);
    expect(layout.layers.metal1?.length).toBeGreaterThan(0);
    expect(layout.cropRect.width).toBeGreaterThan(0);
    expect(layout.cropRect.height).toBeGreaterThan(0);
  });

  it("is extracted as a pmos with the requested W and L", () => {
    const ct = asCellType(
      spec({ ...defaultAnalogParams("pmos"), W_um: 10, L_um: 1, fingers: 1 })
    );
    const devices = detectMOSFromLayers(ct.layers, ct.id, UM_PER_PX);
    expect(devices).toHaveLength(1);
    const geometry = devices[0].geometry as DeviceGeometryMOS;
    expect(geometry.mosType).toBe("pmos");
    expect(geometry.W_um).toBeCloseTo(10, 3);
    expect(geometry.L_um).toBeCloseTo(1, 3);
    expect(devices[0].terminals.map((t) => t.name).sort()).toEqual(["B", "D", "G", "S"]);
  });

  it("is extracted as an nmos in a p-well", () => {
    const ct = asCellType(
      spec({ ...defaultAnalogParams("nmos"), W_um: 5, L_um: 2, fingers: 1 })
    );
    expect(ct.layers?.pwell).toHaveLength(1);
    expect(ct.layers?.nwell).toBeUndefined();
    const devices = detectMOSFromLayers(ct.layers, ct.id, UM_PER_PX);
    expect(devices).toHaveLength(1);
    const geometry = devices[0].geometry as DeviceGeometryMOS;
    expect(geometry.mosType).toBe("nmos");
    expect(geometry.W_um).toBeCloseTo(5, 3);
    expect(geometry.L_um).toBeCloseTo(2, 3);
  });

  it("gives every finger of a multi-finger mos its own device", () => {
    const ct = asCellType(
      spec({ ...defaultAnalogParams("pmos"), W_um: 10, L_um: 1, fingers: 3 })
    );
    const devices = detectMOSFromLayers(ct.layers, ct.id, UM_PER_PX);
    expect(devices).toHaveLength(3);
    for (const device of devices) {
      const geometry = device.geometry as DeviceGeometryMOS;
      expect(geometry.W_um).toBeCloseTo(10, 3);
      expect(geometry.L_um).toBeCloseTo(1, 3);
    }
  });

  it("joins the gate fingers into one gate net", () => {
    const ct = asCellType(
      spec({ ...defaultAnalogParams("pmos"), W_um: 10, L_um: 1, fingers: 3 })
    );
    const devices = detectMOSFromLayers(ct.layers, ct.id, UM_PER_PX);
    const gateNets = new Set(
      devices.map((d) => d.terminals.find((t) => t.name === "G")?.netId)
    );
    expect(gateNets.size).toBe(1);
  });

  it("gives every source/drain region its own terminal", () => {
    const ct = asCellType(
      spec({ ...defaultAnalogParams("nmos"), W_um: 4, L_um: 1, fingers: 2 })
    );
    const devices = detectMOSFromLayers(ct.layers, ct.id, UM_PER_PX);
    expect(devices).toHaveLength(2);
    // Two fingers share the diffusion between them, so the net ids of the
    // source/drain terminals must differ from finger to finger.
    const sdNets = new Set(
      devices.flatMap((d) =>
        d.terminals.filter((t) => t.name === "D" || t.name === "S").map((t) => t.netId)
      )
    );
    expect(sdNets.size).toBeGreaterThan(1);
  });

  it("adds a bulk tap only when asked for", () => {
    const without = asCellType(spec({ ...defaultAnalogParams("pmos"), bulk: "none" }));
    const withTap = asCellType(spec({ ...defaultAnalogParams("pmos"), bulk: "tap" }));
    expect(without.layers?.contact?.length).toBe(
      (withTap.layers?.contact?.length ?? 0) - 1
    );
    // The tap sits inside the well but off the device's diffusion.
    const tap = withTap.layers?.contact?.at(-1);
    const well = withTap.layers?.nwell?.[0];
    const diff = withTap.layers?.diffusion?.[0];
    expect(tap && well).toBeTruthy();
    if (tap && well && diff && tap.kind === "rect" && well.kind === "rect" && diff.kind === "rect") {
      const inside = (outer: typeof well, inner: typeof tap) =>
        inner.x >= outer.x &&
        inner.y >= outer.y &&
        inner.x + inner.width <= outer.x + outer.width &&
        inner.y + inner.height <= outer.y + outer.height;
      expect(inside(well, tap)).toBe(true);
      expect(inside(diff, tap)).toBe(false);
    }
  });

  it("gives a multi-finger device no bulk contact unless a tap was asked for", () => {
    // The far finger's source/drain contact sits in the well too — it must
    // not be taken for a bulk contact (see the extractor regression test).
    const bulkContacts = (bulk: "none" | "tap", fingers: number) => {
      const ct = asCellType(spec({ ...defaultAnalogParams("pmos"), bulk, fingers }));
      const devices = detectMOSFromLayers(ct.layers, ct.id, UM_PER_PX);
      const segments: LayerShape[] = [];
      for (const d of devices) for (const s of (d as any)._segmentShapes ?? []) segments.push(s);
      const layers = {
        ...(ct.layers as Record<string, LayerShape[] | undefined>),
        diffusion: [...((ct.layers?.diffusion ?? []) as LayerShape[]), ...segments]
      };
      return devices.map((d) => {
        const { termContacts } = resolveDeviceContacts(d, layers, 0, 0);
        const bulkIndex = d.terminals.findIndex((t) => t.name === "B");
        return termContacts[bulkIndex]?.length ?? 0;
      });
    };
    expect(bulkContacts("none", 2)).toEqual([0, 0]);
    expect(bulkContacts("none", 3)).toEqual([0, 0, 0]);
    expect(bulkContacts("tap", 2)).toEqual([1, 1]);
  });

  it("scales every layer with the scale", () => {
    const small = buildAnalogPcell(
      spec({ ...defaultAnalogParams("pmos") }, 10),
      "ct"
    );
    const big = buildAnalogPcell(
      spec({ ...defaultAnalogParams("pmos") }, 20),
      "ct"
    );
    expect(big.cropRect.width).toBeCloseTo(small.cropRect.width * 2, 6);
    expect(big.cropRect.height).toBeCloseTo(small.cropRect.height * 2, 6);
  });
});

describe("buildAnalogPcell — BJT", () => {
  it("is extracted as an npn with the requested emitter", () => {
    const ct = asCellType(
      spec({ ...defaultAnalogParams("npn"), W_um: 2, L_um: 3, fingers: 1 })
    );
    expect(ct.layers?.npn_id).toHaveLength(1);
    expect(ct.layers?.base).toHaveLength(1);
    expect(ct.layers?.emitter).toHaveLength(1);
    expect(ct.layers?.collector).toHaveLength(1);

    const devices = extractMarkedDevices(ct.layers, ct.id, UM_PER_PX);
    expect(devices).toHaveLength(1);
    expect(devices[0].kind).toBe("bjt_npn");
    const geometry = devices[0].geometry as DeviceGeometryBJT;
    expect(geometry.bjtType).toBe("npn");
    expect(geometry.AE_um2).toBeCloseTo(2 * 3, 3);
    expect(geometry.emitterFingers).toBe(1);
    expect(devices[0].terminals.map((t) => t.name).sort()).toEqual(["B", "C", "E"]);
  });

  it("counts every emitter stripe of a multi-stripe npn", () => {
    const ct = asCellType(
      spec({ ...defaultAnalogParams("npn"), W_um: 2, L_um: 2, fingers: 3 })
    );
    const devices = extractMarkedDevices(ct.layers, ct.id, UM_PER_PX);
    expect(devices).toHaveLength(1);
    const geometry = devices[0].geometry as DeviceGeometryBJT;
    expect(geometry.emitterFingers).toBe(3);
    expect(geometry.AE_um2).toBeCloseTo(4, 3);
  });

  it("is extracted as a pnp", () => {
    const ct = asCellType(spec({ ...defaultAnalogParams("pnp"), W_um: 2, L_um: 2 }));
    expect(ct.layers?.pnp_id).toHaveLength(1);
    const devices = extractMarkedDevices(ct.layers, ct.id, UM_PER_PX);
    expect(devices).toHaveLength(1);
    expect(devices[0].kind).toBe("bjt_pnp");
  });

  it("lays an lpnp out without a base", () => {
    const ct = asCellType(spec({ ...defaultAnalogParams("lpnp"), W_um: 2, L_um: 2 }));
    expect(ct.layers?.lpnp_id).toHaveLength(1);
    expect(ct.layers?.base).toBeUndefined();
    const devices = extractMarkedDevices(ct.layers, ct.id, UM_PER_PX);
    expect(devices).toHaveLength(1);
    expect(devices[0].kind).toBe("bjt_pnp");
    const geometry = devices[0].geometry as DeviceGeometryBJT;
    expect(geometry.AE_um2).toBeCloseTo(4, 3);
  });
});

describe("analog parameters", () => {
  it("rejects impossible parameters", () => {
    expect(validateAnalogParams({ ...defaultAnalogParams("pmos"), W_um: 0 })).toMatch(/W/);
    expect(validateAnalogParams({ ...defaultAnalogParams("pmos"), L_um: -1 })).toMatch(/L/);
    expect(validateAnalogParams({ ...defaultAnalogParams("pmos"), fingers: 0 })).toMatch(/fingers/);
    expect(validateAnalogParams(defaultAnalogParams("pmos"))).toBeNull();
  });

  it("refuses to lay out a device with a broken scale", () => {
    expect(() =>
      buildAnalogPcell(spec(defaultAnalogParams("pmos"), 0), "ct")
    ).toThrow(/scale/);
  });
});
