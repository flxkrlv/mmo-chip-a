/// <reference types="node" />
/**
 * simpleAnalog.test.ts — the analog extractor's terminal resolution.
 *
 * The bulk (B) terminal of a MOS is the well: a contact reaches it only
 * when it sits in the well and NOT on the device's own diffusion. A
 * multi-finger MOS is one transistor split into per-finger sub-devices,
 * so the far finger's source/drain contact must not be taken for a bulk
 * contact (regression of 572920c, which narrowed the exclusion to the
 * finger's own two segments).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import type { CellLayers, LayerRect, LayerShape } from "shared";
import { loadClipperWithBinary } from "./clipper";
import { detectMOSFromLayers, resolveDeviceContacts } from "./simpleAnalog";

const require = createRequire(import.meta.url);

beforeAll(async () => {
  const wasm = await readFile(require.resolve("clipper2-wasm/dist/es/clipper2z.wasm"));
  await loadClipperWithBinary(wasm);
});

function rr(id: string, x: number, y: number, w: number, h: number): LayerRect {
  return { id, kind: "rect", x, y, width: w, height: h };
}

/**
 * A hand-drawn nmos in a p-well: one diffusion strip, `fingers` gate bars
 * crossing it, a contact in every source/drain region and — optionally —
 * a well tap in the well, off the diffusion.
 *
 * `gateContacts` puts a contact on every gate bar (the gate lead), as a
 * drawing would.
 */
function handDrawnMos(
  fingers: number,
  withTap: boolean,
  gateContacts = false
): CellLayers {
  const L = 4;
  const W = 20;
  const gap = 16;
  const sd = 20;
  const strip = fingers * L + (fingers - 1) * gap + 2 * sd;
  const gateX = (i: number) => sd + i * (L + gap);

  const layers: CellLayers = {
    pwell: [rr("pwell", 0, 0, strip + 20, W + 30)],
    diffusion: [rr("diff", 0, 0, strip, W)],
    polysilicon: [],
    contact: [],
    metal1: []
  };
  for (let i = 0; i < fingers; i++) {
    // The gate bar reaches above the diffusion, where a gate contact sits.
    layers.polysilicon!.push(rr(`poly${i}`, gateX(i), -5, L, W + 5));
  }
  // A contact in every source/drain region.
  for (let j = 0; j <= fingers; j++) {
    const x0 = j === 0 ? 0 : gateX(j - 1) + L;
    const x1 = j === fingers ? strip : gateX(j);
    layers.contact!.push(rr(`ct${j}`, (x0 + x1) / 2 - 2, W / 2 - 2, 4, 4));
  }
  if (gateContacts) {
    for (let i = 0; i < fingers; i++) {
      layers.contact!.push(rr(`ctG${i}`, gateX(i) + 1, -4, 2, 2));
    }
  }
  if (withTap) {
    // A well tap: in the well, clear of the diffusion.
    layers.contact!.push(rr("ctTap", strip / 2 - 2, W + 8, 4, 4));
  }
  return layers;
}

/** The contacts each terminal got, as the extractor assigns them. */
function terminals(layers: CellLayers) {
  const devices = detectMOSFromLayers(layers, "ct", 1);
  // The real pipeline injects the synthetic diffusion segments into the
  // cell type's layers before the terminals are resolved.
  const segments: LayerShape[] = [];
  for (const d of devices) for (const s of (d as any)._segmentShapes ?? []) segments.push(s);
  const ctLayers = {
    ...layers,
    diffusion: [...(layers.diffusion ?? []), ...segments]
  } as Record<string, LayerShape[] | undefined>;
  return devices.map((d) => {
    const { termContacts } = resolveDeviceContacts(d, ctLayers, 0, 0);
    const counts: Record<string, number> = {};
    d.terminals.forEach((t, i) => {
      counts[t.name] = termContacts[i].length;
    });
    return counts;
  });
}

describe("MOS bulk terminal", () => {
  it("finds no bulk contact on a single-finger mos without a well tap", () => {
    const [finger] = terminals(handDrawnMos(1, false));
    expect(finger.B).toBe(0);
    expect(finger.D).toBe(1);
    expect(finger.S).toBe(1);
    expect(finger.G).toBe(0); // no gate contact drawn
  });

  it("finds the well tap of a single-finger mos", () => {
    const [finger] = terminals(handDrawnMos(1, true));
    expect(finger.B).toBe(1);
  });

  it("finds no bulk contact on a multi-finger mos without a well tap", () => {
    // The far finger's drain contact sits in the well too — it is source /
    // drain of the same transistor, never the bulk.
    const fingers = terminals(handDrawnMos(2, false));
    expect(fingers).toHaveLength(2);
    for (const finger of fingers) {
      expect(finger.B).toBe(0);
      expect(finger.D).toBe(1);
      expect(finger.S).toBe(1);
    }
  });

  it("finds the well tap of a multi-finger mos", () => {
    const fingers = terminals(handDrawnMos(3, true));
    expect(fingers).toHaveLength(3);
    for (const finger of fingers) {
      expect(finger.B).toBe(1);
      expect(finger.D).toBe(1);
      expect(finger.S).toBe(1);
    }
  });

  it("does not take another gate's contact for a bulk contact", () => {
    // Every gate bar has its own contact. The contact of the far gate
    // belongs to that gate — it is never the bulk of this finger.
    const fingers = terminals(handDrawnMos(2, false, true));
    expect(fingers).toHaveLength(2);
    for (const finger of fingers) {
      expect(finger.B).toBe(0);
      expect(finger.G).toBe(1);
      expect(finger.D).toBe(1);
      expect(finger.S).toBe(1);
    }
  });

  it("keeps the well tap when the gates have contacts too", () => {
    const fingers = terminals(handDrawnMos(2, true, true));
    expect(fingers).toHaveLength(2);
    for (const finger of fingers) {
      expect(finger.B).toBe(1);
      expect(finger.G).toBe(1);
    }
  });

  it("takes a contact on the diffusion for a source/drain, never for the bulk", () => {
    // A "tap" drawn on the transistor's own diffusion is a source/drain
    // contact — the bulk is the well, and only a contact that touches no
    // diffusion and no poly can be a bulk contact.
    const layers = handDrawnMos(1, false);
    // A contact right on the transistor's diffusion (inside the strip).
    layers.contact!.push(rr("ctOnDiff", 15, 18, 4, 4));
    const [finger] = terminals(layers);
    expect(finger.B).toBe(0);
  });

  it("does not take another device's gate contact for a bulk contact", () => {
    // Two transistors in one well, each with its own gate contact. The
    // gate contact of the other one sits in the well, but it is a gate.
    const layers: CellLayers = {
      pwell: [rr("pwell", 0, 0, 120, 60)],
      diffusion: [
        rr("diffA", 10, 10, 30, 20),
        rr("diffB", 60, 10, 30, 20)
      ],
      polysilicon: [
        rr("polyA", 20, 5, 4, 30),
        rr("polyB", 70, 5, 4, 30)
      ],
      contact: [
        rr("ctA1", 14, 18, 4, 4),
        rr("ctA2", 34, 18, 4, 4),
        rr("ctAG", 20, 6, 4, 4),
        rr("ctB1", 64, 18, 4, 4),
        rr("ctB2", 84, 18, 4, 4),
        rr("ctBG", 70, 6, 4, 4)
      ]
    };
    const devices = terminals(layers);
    expect(devices).toHaveLength(2);
    for (const device of devices) {
      expect(device.B).toBe(0);
      expect(device.G).toBe(1);
    }
  });
});
