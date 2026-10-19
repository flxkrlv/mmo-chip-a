/// <reference types="node" />
import { describe, it, expect, beforeAll } from "vitest";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import type { AnalogDevice, AnalogLibTemplate, CellLayers, CellType, DeviceGeometryBJT, DeviceGeometryMOS, LayerShape } from "shared";
import {
  buildAnalogPcell,
  defaultAnalogParams,
  normalizeAnalogParams,
  resolveAnalogTemplate,
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

  it("lays an lpnp out as an emitter in a collector ring inside a base", () => {
    const ct = asCellType(spec({ ...defaultAnalogParams("lpnp"), W_um: 2, L_um: 2 }));
    // The emitter is p+, the collector ring is p+ too, the base is the n
    // region around them.
    expect(ct.layers?.lpnp_id).toHaveLength(1);
    expect(ct.layers?.emitter).toHaveLength(1);
    expect(ct.layers?.collector?.length).toBeGreaterThanOrEqual(4);
    expect(ct.layers?.bulk).toHaveLength(1);

    // The ring surrounds the emitter: the bars' outer bounds contain it,
    // and the hole in the middle of the ring does not.
    const emitter = ct.layers?.emitter?.[0];
    const bars = (ct.layers?.collector ?? []).filter((s) => s.kind === "rect");
    expect(emitter?.kind).toBe("rect");
    if (emitter?.kind !== "rect" || bars.length === 0) return;
    const minX = Math.min(...bars.map((s) => s.x));
    const minY = Math.min(...bars.map((s) => s.y));
    const maxX = Math.max(...bars.map((s) => s.x + s.width));
    const maxY = Math.max(...bars.map((s) => s.y + s.height));
    expect(emitter.x).toBeGreaterThan(minX);
    expect(emitter.y).toBeGreaterThan(minY);
    expect(emitter.x + emitter.width).toBeLessThan(maxX);
    expect(emitter.y + emitter.height).toBeLessThan(maxY);
    // The bars leave a hole around the emitter (they do not fill it).
    const covers = bars.some(
      (s) =>
        s.x <= emitter.x &&
        s.y <= emitter.y &&
        s.x + s.width >= emitter.x + emitter.width &&
        s.y + s.height >= emitter.y + emitter.height
    );
    expect(covers).toBe(false);
  });

  it("keeps the lpnp emitter inside the collector ring and the base", () => {
    const ct = asCellType(
      spec({
        ...defaultAnalogParams("lpnp"),
        W_um: 2,
        L_um: 2,
        emitterCollectorGap_um: 1.5,
        collectorBaseGap_um: 2
      })
    );
    const emitter = ct.layers?.emitter?.[0];
    const bulk = ct.layers?.bulk?.[0];
    expect(emitter?.kind).toBe("rect");
    expect(bulk?.kind).toBe("rect");
    if (emitter?.kind === "rect" && bulk?.kind === "rect") {
      // The emitter sits well inside the base region.
      expect(emitter.x).toBeGreaterThan(bulk.x);
      expect(emitter.y).toBeGreaterThan(bulk.y);
      expect(emitter.x + emitter.width).toBeLessThan(bulk.x + bulk.width);
      expect(emitter.y + emitter.height).toBeLessThan(bulk.y + bulk.height);
    }
  });

  it("is extracted as a lateral pnp with the emitter area and the base contact", () => {
    const ct = asCellType(spec({ ...defaultAnalogParams("lpnp"), W_um: 2, L_um: 3 }));
    const devices = extractMarkedDevices(ct.layers, ct.id, UM_PER_PX);
    expect(devices).toHaveLength(1);
    expect(devices[0].kind).toBe("bjt_pnp");
    const geometry = devices[0].geometry as DeviceGeometryBJT;
    expect(geometry.bjtType).toBe("pnp");
    // The emitter is p+ inside the n-base: the base covers it, so the
    // emitter area is the emitter's own area.
    expect(geometry.AE_um2).toBeCloseTo(2 * 3, 3);
    expect(devices[0].terminals.map((t) => t.name).sort()).toEqual(["B", "C", "E"]);
  });
});

describe("buildAnalogPcell — the multiplier", () => {
  it("lays the copies of a multiplier side by side", () => {
    const params = { ...defaultAnalogParams("nmos"), multiplier: 3, multiplierGap_um: 2 };
    const layout = buildAnalogPcell(spec(params), "ct");
    // One diffusion, one gate and one strap per copy.
    expect(layout.layers.diffusion).toHaveLength(3);
    expect(layout.layers.polysilicon).toHaveLength(6);
    // The copies are one structure wide plus the gap apart.
    const diffs = (layout.layers.diffusion ?? []).filter((s) => s.kind === "rect");
    const first = diffs[0];
    const second = diffs[1];
    expect(first?.kind).toBe("rect");
    expect(second?.kind).toBe("rect");
    if (first?.kind === "rect" && second?.kind === "rect") {
      const structureWidth = first.width;
      const gap = second.x - (first.x + first.width);
      expect(gap).toBeCloseTo(2 * SCALE, 3);
      expect(structureWidth).toBeGreaterThan(0);
    }
  });

  it("keeps a multiplier of one the same as a single structure", () => {
    const single = buildAnalogPcell(
      spec({ ...defaultAnalogParams("nmos"), multiplier: 1 }),
      "ct"
    );
    const one = buildAnalogPcell(
      spec({ ...defaultAnalogParams("nmos"), multiplier: 1, multiplierGap_um: 5 }),
      "ct"
    );
    expect(single.cropRect.width).toBeCloseTo(one.cropRect.width, 6);
    expect(single.layers.diffusion).toHaveLength(1);
  });

  it("is extracted as one device per structure", () => {
    const ct = asCellType(
      spec({ ...defaultAnalogParams("nmos"), multiplier: 2, multiplierGap_um: 2 })
    );
    const devices = detectMOSFromLayers(ct.layers, ct.id, UM_PER_PX);
    expect(devices).toHaveLength(2);
    for (const d of devices) {
      const geometry = d.geometry as DeviceGeometryMOS;
      expect(geometry.W_um).toBeCloseTo(10, 3);
      expect(geometry.L_um).toBeCloseTo(1, 3);
    }
  });
});

describe("buildAnalogPcell — the bipolar gaps and the base contact", () => {
  it("moves the collector away from the emitter", () => {
    const near = asCellType(
      spec({ ...defaultAnalogParams("npn"), emitterCollectorGap_um: 1 })
    );
    const far = asCellType(
      spec({ ...defaultAnalogParams("npn"), emitterCollectorGap_um: 5 })
    );
    const emitter = near.layers?.emitter?.[0];
    const collector = near.layers?.collector?.[0];
    expect(emitter?.kind).toBe("rect");
    expect(collector?.kind).toBe("rect");
    if (emitter?.kind === "rect" && collector?.kind === "rect") {
      const distance = (ct: typeof near) => {
        const e = ct.layers?.emitter?.[0];
        const c = ct.layers?.collector?.[0];
        if (e?.kind !== "rect" || c?.kind !== "rect") return 0;
        return c.x - (e.x + e.width);
      };
      expect(distance(near)).toBeCloseTo(1 * SCALE, 3);
      expect(distance(far)).toBeCloseTo(5 * SCALE, 3);
    }
  });

  it("keeps the base's margin around the emitter", () => {
    const ct = asCellType(
      spec({ ...defaultAnalogParams("npn"), emitterBaseGap_um: 3 })
    );
    const emitter = ct.layers?.emitter?.[0];
    const base = ct.layers?.base?.[0];
    expect(emitter?.kind).toBe("rect");
    expect(base?.kind).toBe("rect");
    if (emitter?.kind === "rect" && base?.kind === "rect") {
      expect(base.x).toBeCloseTo(emitter.x - 3 * SCALE, 3);
      expect(base.y).toBeCloseTo(emitter.y - 3 * SCALE, 3);
    }
  });

  it("puts the base contact on the chosen side", () => {
    const contactAt = (side: "left" | "right" | "top" | "bottom") => {
      const ct = asCellType(
        spec({ ...defaultAnalogParams("npn"), baseContactSide: side })
      );
      const contact = ct.layers?.contact?.find((s) => s.id.endsWith(":ct:b"));
      const emitter = ct.layers?.emitter?.[0];
      if (contact?.kind !== "rect" || emitter?.kind !== "rect") return null;
      return { cx: contact.x + contact.width / 2, cy: contact.y + contact.height / 2, e: emitter };
    };
    const left = contactAt("left");
    const right = contactAt("right");
    const top = contactAt("top");
    const bottom = contactAt("bottom");
    expect(left && right && top && bottom).toBeTruthy();
    if (!left || !right || !top || !bottom) return;
    // Left and right are horizontally apart, top and bottom vertically.
    expect(left.cx).toBeLessThan(left.e.x);
    expect(right.cx).toBeGreaterThan(right.e.x + right.e.width);
    expect(top.cy).toBeLessThan(top.e.y);
    expect(bottom.cy).toBeGreaterThan(bottom.e.y + bottom.e.height);
  });

  it("grows the base's pocket without dragging the collector along", () => {
    const near = asCellType(
      spec({ ...defaultAnalogParams("npn"), emitterBaseGap_um: 0.4 })
    );
    const far = asCellType(
      spec({ ...defaultAnalogParams("npn"), emitterBaseGap_um: 3 })
    );
    const of = (ct: typeof near) => {
      const base = ct.layers?.base?.[0];
      const collector = ct.layers?.collector?.[0];
      const emitter = ct.layers?.emitter?.[0];
      if (base?.kind !== "rect" || collector?.kind !== "rect" || emitter?.kind !== "rect")
        return null;
      return {
        pocket: emitter.x - base.x,
        // The collector's distance from the emitter, not from the cell's
        // origin (the whole cell is shifted to fit its content).
        collectorGap: collector.x - (emitter.x + emitter.width),
        collectorH: collector.height
      };
    };
    const a = of(near);
    const b = of(far);
    expect(a && b).toBeTruthy();
    if (!a || !b) return;
    // The pocket around the emitter grew…
    expect(b.pocket).toBeGreaterThan(a.pocket);
    // …and the collector stayed exactly where it was.
    expect(b.collectorGap).toBeCloseTo(a.collectorGap, 6);
    expect(b.collectorH).toBeCloseTo(a.collectorH, 6);
  });
});

describe("buildAnalogPcell — the device fits its cell", () => {
  const boundsOf = (layers: CellLayers): { minX: number; minY: number; maxX: number; maxY: number } => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const shapes of Object.values(layers)) {
      for (const s of shapes ?? []) {
        if (s.kind !== "rect") continue;
        minX = Math.min(minX, s.x);
        minY = Math.min(minY, s.y);
        maxX = Math.max(maxX, s.x + s.width);
        maxY = Math.max(maxY, s.y + s.height);
      }
    }
    return { minX, minY, maxX, maxY };
  };

  it("keeps every shape inside the cell box", () => {
    for (const template of ["pmos", "nmos", "npn", "lpnp"] as const) {
      for (const fingers of [1, 2]) {
        for (const bulk of ["none", "tap"] as const) {
          const p = { ...defaultAnalogParams(template), fingers };
          if (p.kind === "mos") p.bulk = bulk;
          const layout = buildAnalogPcell(spec(p), "ct");
          const b = boundsOf(layout.layers);
          expect(b.minX).toBeGreaterThanOrEqual(0);
          expect(b.minY).toBeGreaterThanOrEqual(0);
          expect(b.maxX).toBeLessThanOrEqual(layout.cropRect.width + 1e-6);
          expect(b.maxY).toBeLessThanOrEqual(layout.cropRect.height + 1e-6);
          // The cell box is the content's own bounds.
          expect(layout.cropRect.width).toBeCloseTo(b.maxX - b.minX, 3);
          expect(layout.cropRect.height).toBeCloseTo(b.maxY - b.minY, 3);
        }
      }
    }
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

  it("fills in the fields a stored parameter set is missing", () => {
    // Parameters are remembered between sessions, so a set saved by an
    // older version can lack fields that were added later.
    const stored = {
      kind: "mos" as const,
      mosType: "pmos" as const,
      fingers: 4,
      W_um: 3,
      L_um: 0.5,
      bulk: "none" as const
    };
    const params = normalizeAnalogParams("pmos", stored);
    expect(params.kind).toBe("mos");
    if (params.kind !== "mos") return;
    // The stored values are kept…
    expect(params.fingers).toBe(4);
    expect(params.W_um).toBe(3);
    // …and the missing ones come from the template.
    expect(params.multiplier).toBe(1);
    expect(params.multiplierGap_um).toBeGreaterThan(0);
    expect(validateAnalogParams(params)).toBeNull();
  });

  it("keeps the gaps of a stored lateral pnp", () => {
    const stored = {
      kind: "bjt" as const,
      bjtType: "lpnp" as const,
      fingers: 1,
      W_um: 2,
      L_um: 2
    };
    const params = normalizeAnalogParams("lpnp", stored);
    expect(params.kind).toBe("bjt");
    if (params.kind !== "bjt") return;
    expect(params.emitterCollectorGap_um).toBeGreaterThan(0);
    expect(params.collectorBaseGap_um).toBeGreaterThan(0);
    expect(params.baseContactSide).toBeTruthy();
  });

  it("falls back when the stored template is gone", () => {
    // The vertical pnp was removed from the library, but an old session can
    // still have it stored.
    const gone = "pnp" as unknown as Parameters<typeof resolveAnalogTemplate>[0];
    expect(resolveAnalogTemplate(gone)).toBe("pmos");
    const params = normalizeAnalogParams(gone as AnalogLibTemplate, null);
    expect(params.kind).toBe("mos");
    expect(validateAnalogParams(params)).toBeNull();
  });
});
