import { describe, it, expect } from "vitest";
import { parseSymbolSkin, templateForDevice, pinForTerminal, labelForSpec } from "./interactiveSymbols";
import type { AnalogDevice } from "shared";

const table = parseSymbolSkin();

function dev(partial: Partial<AnalogDevice>): AnalogDevice {
  return {
    id: "t1",
    kind: "mos",
    layer: "poly",
    bbox: { x: 0, y: 0, width: 1, height: 1 },
    terminals: [],
    ...partial,
  } as unknown as AnalogDevice;
}

describe("parseSymbolSkin", () => {
  it("extracts all analog skin types by alias", () => {
    for (const key of [
      "nmos_v", "pmos_v", "r_v", "c_v", "l_v", "d_v", "d_sk_v",
      "q_npn", "q_pnp", "vcc", "gnd", "vee", "opamp", "inputExt", "outputExt",
    ]) {
      expect(table.byKey.get(key), `missing template: ${key}`).toBeDefined();
    }
  });

  it("nmos_v: 4-terminal D/G/S/B pins with correct anchors", () => {
    const t = table.byKey.get("nmos_v")!;
    expect(t.width).toBe(42);
    expect(t.height).toBe(36);
    const pin = (pid: string) => t.pins.find((p) => p.pid === pid)!;
    expect(pin("D")).toMatchObject({ dx: 30, dy: 0, position: "top" });
    expect(pin("G")).toMatchObject({ dx: 0, dy: 18, position: "left" });
    expect(pin("S")).toMatchObject({ dx: 30, dy: 36, position: "bottom" });
    expect(pin("B")).toMatchObject({ dx: 36, dy: 18, position: "right" });
  });

  it("nmos_v: body keeps symbol art, bakes white styles, drops texts/pins/$cell_id", () => {
    const t = table.byKey.get("nmos_v")!;
    expect(t.body).toContain("M30,36 V30 H20 V6 H30 V0"); // gate C-shape
    expect(t.body).not.toContain("<text");
    expect(t.body).not.toContain("s:pid");
    expect(t.body).not.toContain("$cell_id");
    // Baked presentation attributes — art must not rely on CSS reach
    // into <use> shadow trees (black-on-black bug).
    expect(t.body).toContain('stroke="#ffffff"');
    expect(t.body).not.toMatch(/class="\s*"/);
    expect(t.body).not.toContain("fill:#000");
    expect(t.body).not.toContain("style=");
  });

  it("npn/pnp inline black arrow fills are baked to white", () => {
    const t = table.byKey.get("q_npn")!;
    expect(t.body).not.toContain("#000000");
    expect(t.body).toContain('fill="#ffffff"');
  });

  it("vcc bare path gets white stroke (no default black fill)", () => {
    const t = table.byKey.get("vcc")!;
    expect(t.body).toContain('stroke="#ffffff"');
    expect(t.body).toContain('fill="none"');
  });

  it("nmos_v labels: ref nodelabel + multi-line value valuelabel", () => {
    const t = table.byKey.get("nmos_v")!;
    const ref = t.labels.find((l) => l.source === "ref")!;
    const val = t.labels.find((l) => l.source === "value")!;
    expect(ref.cls).toContain("nodelabel");
    expect(val.cls).toContain("valuelabel");
  });

  it("r_v pins: A top, B bottom", () => {
    const t = table.byKey.get("r_v")!;
    expect(t.pins.find((p) => p.pid === "A")).toMatchObject({ dx: 5, dy: 0 });
    expect(t.pins.find((p) => p.pid === "B")).toMatchObject({ dx: 5, dy: 50 });
  });

  it("vcc has a name label and single A pin at bottom", () => {
    const t = table.byKey.get("vcc")!;
    expect(t.pins).toHaveLength(1);
    expect(t.pins[0]).toMatchObject({ pid: "A", position: "bottom" });
    expect(t.labels).toHaveLength(1);
    expect(t.labels[0].source).toBe("name");
  });

  it("BJT pin anchors follow the drawn arrow (emitter side)", () => {
    // NPN: arrow on the BOTTOM diagonal → E bottom, C top
    const npn = table.byKey.get("q_npn")!;
    expect(npn.pins.find((p) => p.pid === "E")).toMatchObject({ position: "bottom" });
    expect(npn.pins.find((p) => p.pid === "C")).toMatchObject({ position: "top" });
    // PNP: arrow on the TOP diagonal → E top, C bottom (regression:
    // pids were copied from NPN so the E wire landed on the drawn
    // collector)
    const pnp = table.byKey.get("q_pnp")!;
    expect(pnp.pins.find((p) => p.pid === "E")).toMatchObject({ position: "top" });
    expect(pnp.pins.find((p) => p.pid === "C")).toMatchObject({ position: "bottom" });
  });
});

function mosGeom(mosType: "nmos" | "pmos"): NonNullable<AnalogDevice["geometry"]> {
  return { mosType, W_um: 1, L_um: 0.5, fingers: 1, multiplier: 1, totalW_um: 1 };
}

describe("templateForDevice / pinForTerminal", () => {
  it("resolves nmos/pmos/r/c/q/d device kinds", () => {
    const cases: Array<[Partial<AnalogDevice>, string]> = [
      [{ kind: "mos", geometry: mosGeom("nmos") }, "nmos_v"],
      [{ kind: "mos", geometry: mosGeom("pmos") }, "pmos_v"],
      [{ kind: "resistor" }, "r_v"],
      [{ kind: "capacitor" }, "c_v"],
      [{ kind: "bjt_npn" }, "q_npn"],
      [{ kind: "diode" }, "d_v"],
      [{ kind: "schottky" }, "d_sk_v"],
      [{ kind: "inductor" }, "l_v"],
    ];
    for (const [partial, expectedType] of cases) {
      const t = templateForDevice(table, dev(partial));
      expect(t, `no template for ${JSON.stringify(partial)}`).toBeDefined();
      // cellTypeForDevice returns the skin ALIAS (nmos_v, r_v, …); the
      // template's s:type is the underlying symbol (transistor_nmos, …).
      expect([t!.type, ...t!.aliases]).toContain(expectedType);
    }
  });

  it("maps MOS terminals D/G/S/B and passives PLUS/MINUS onto pins", () => {
    const mos = dev({ kind: "mos", geometry: mosGeom("nmos") });
    const mosT = templateForDevice(table, mos)!;
    expect(pinForTerminal(mos, "D", mosT)!.position).toBe("top");
    expect(pinForTerminal(mos, "G", mosT)!.position).toBe("left");
    expect(pinForTerminal(mos, "S", mosT)!.position).toBe("bottom");
    expect(pinForTerminal(mos, "B", mosT)!.position).toBe("right");

    const res = dev({ kind: "resistor" });
    const resT = templateForDevice(table, res)!;
    expect(pinForTerminal(res, "PLUS", resT)!.pid).toBe("A");
    expect(pinForTerminal(res, "MINUS", resT)!.pid).toBe("B");
  });

  it("labelForSpec resolves name/ref/value", () => {
    const t = table.byKey.get("nmos_v")!;
    const d = dev({ instanceName: "M_1", kind: "mos", geometry: { ...mosGeom("nmos"), W_um: 2 } });
    const refSpec = t.labels.find((l) => l.source === "ref")!;
    const valSpec = t.labels.find((l) => l.source === "value")!;
    expect(labelForSpec(refSpec, d, "M_1")).toBe("M_1");
    expect(labelForSpec(valSpec, d, "M_1")).toContain("W=2.00 um");
  });
});
