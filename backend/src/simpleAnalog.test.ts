/**
 * simpleAnalog.test.ts — Tests for simpleAnalog.ts:
 *   - detectMOSFromLayers() poly gate net grouping
 *
 * Run: cd backend && npx tsx --test src/simpleAnalog.test.ts
 *
 * The extractor lives in the frontend (frontend/src/lib/extraction); it is
 * exercised from here through a cross-package import. Clipper2 is loaded
 * before the tests: MOS detection needs it (the diffusion is split at the
 * gates), so without it no MOS device is produced at all.
 */

import assert from "node:assert/strict";
import test, { before } from "node:test";
import { readFileSync } from "node:fs";
import type { CellLayers, LayerRect } from "../../shared/src/types.js";
import {
  detectMOSFromLayers,
  resetDummyNets,
  mergeMetalConnectedTerminals,
} from "../../frontend/src/lib/extraction/simpleAnalog.js";
import { loadClipperWithBinary } from "../../frontend/src/lib/extraction/clipper.js";

before(async () => {
  const wasmPath = new URL(
    "../../node_modules/clipper2-wasm/dist/es/clipper2z.wasm",
    import.meta.url,
  );
  await loadClipperWithBinary(readFileSync(wasmPath));
});

function rr(
  id: string,
  x: number,
  y: number,
  w: number,
  h: number,
): LayerRect {
  return { id, kind: "rect", x, y, width: w, height: h };
}

// ═════════════════════════════════════════════════════════════════
// Gate net grouping
// ═════════════════════════════════════════════════════════════════

test("detectMOSFromLayers: same poly shape across two diffusions → shared gate net", () => {
  resetDummyNets();
  // Two diffusions stacked in y, one vertical poly crossing both. The poly
  // has to cut each diffusion *through* — a poly that only clips the
  // diffusion's edge leaves nothing to split (see the splitter in
  // splitDiffusionAtGates).
  const layers: CellLayers = {
    nwell: [rr("nw1", 0, 0, 60, 70)],
    diffusion: [
      rr("d1", 10, 0, 20, 20),  // x=10..30, y=0..20
      rr("d2", 10, 30, 20, 20), // x=10..30, y=30..50
    ],
    polysilicon: [rr("p1", 18, -5, 4, 60)], // x=18..22, y=-5..55 → crosses both
  };
  const devices = detectMOSFromLayers(layers, "test_cell", 1);
  // Both diffusions have 1 gate each → one finger per diffusion
  assert.equal(devices.length, 2, "expected 2 MOS devices (one per diffusion)");
  const gNets = devices.map((d) => d.terminals.find((t) => t.name === "G")!.netId);
  assert.equal(
    gNets[0],
    gNets[1],
    "same polysilicon shape → same gate netId across diffusions",
  );
  assert.ok(gNets[0] >= 1000, "gate netId should be positive internal net");
});

test("detectMOSFromLayers: single-finger regression — unchanged behavior", () => {
  resetDummyNets();
  const layers: CellLayers = {
    nwell: [rr("nw1", 0, 0, 50, 50)],
    diffusion: [rr("d1", 10, 10, 30, 20)],
    polysilicon: [rr("p1", 20, 5, 4, 30)],
  };
  const devices = detectMOSFromLayers(layers, "test_cell", 1);
  assert.equal(devices.length, 1, "expected 1 MOS device");
  const gTerm = devices[0].terminals.find((t) => t.name === "G")!;
  assert.ok(gTerm.netId >= 1000, "gate netId positive");
  assert.equal(gTerm.shapeIds.length, 1, "one gate shape");
});

// ═════════════════════════════════════════════════════════════════
// Tests with Clipper (connected-component grouping)
// ═════════════════════════════════════════════════════════════════

test("detectMOSFromLayers: overlapping poly shapes → shared gate net (with clipper)", async () => {
  resetDummyNets();
  // Two polys that overlap each other, each crossing its own diffusion.
  // p1 (x=18..22, y=-5..28) overlaps p2 (x=20..24, y=26..55) at
  // x=20..22, y=26..28 → the gates share one net because the polys are
  // connected.
  const layers: CellLayers = {
    nwell: [rr("nw1", 0, 0, 60, 70)],
    diffusion: [
      rr("d1", 10, 0, 20, 20),  // x=10..30, y=0..20
      rr("d2", 10, 30, 20, 20), // x=10..30, y=30..50
    ],
    polysilicon: [
      rr("p1", 18, -5, 4, 33),  // crosses d1 only
      rr("p2", 20, 26, 4, 29),  // crosses d2 only — overlaps p1
    ],
  };
  const devices = detectMOSFromLayers(layers, "test_cell", 1);
  // d1: 1 gate (p1) → 1 device. d2: 1 gate (p2) → 1 device. Total = 2
  assert.equal(devices.length, 2, "expected 2 MOS devices (one per diffusion)");

  // Both gates share the same netId (p1 and p2 overlap → one connected component)
  const gNets = devices.map((d) => d.terminals.find((t) => t.name === "G")!.netId);
  assert.equal(
    gNets[0],
    gNets[1],
    "overlapping poly shapes → same gate netId",
  );
  assert.ok(gNets[0] >= 1000);
});

test("detectMOSFromLayers: separate non-overlapping poly shapes → different gate nets", async () => {
  resetDummyNets();
  const layers: CellLayers = {
    nwell: [rr("nw1", 0, 0, 100, 50)],
    diffusion: [
      rr("d1", 10, 10, 20, 20),   // spans x=10..30
      rr("d2", 60, 10, 20, 20),   // spans x=60..80
    ],
    polysilicon: [
      rr("p1", 25, 5, 4, 40),  // crosses d1 only (x=25..29)
      rr("p2", 65, 5, 4, 40),  // crosses d2 only (x=65..69) — no overlap with p1
    ],
  };
  const devices = detectMOSFromLayers(layers, "test_cell", 1);
  assert.equal(devices.length, 2, "expected 2 MOS devices");
  const gNets = devices.map((d) => d.terminals.find((t) => t.name === "G")!.netId);
  assert.notEqual(
    gNets[0],
    gNets[1],
    "non-overlapping poly shapes → different gate netIds",
  );
});

test("detectMOSFromLayers: multi-finger regression — clipper split still works", async () => {
  resetDummyNets();
  // Standard multi-finger: one diffusion, two non-overlapping poly strips
  const layers: CellLayers = {
    nwell: [rr("nw1", 0, 0, 80, 50)],
    diffusion: [rr("d1", 10, 10, 60, 20)],
    polysilicon: [
      rr("p1", 20, 5, 4, 30),
      rr("p2", 40, 5, 4, 30),
    ],
  };
  const devices = detectMOSFromLayers(layers, "test_cell", 1);
  assert.equal(devices.length, 2, "expected 2 finger-devices");
  const allGates = devices.map(
    (d) => d.terminals.find((t) => t.name === "G")!.netId,
  );
  for (const g of allGates) assert.ok(g >= 1000, `gate net ${g} should be >= 1000`);
  // Separate non-overlapping poly strips have different gate netIds
  assert.notEqual(
    allGates[0],
    allGates[1],
    "separate poly strips with no overlap → different gate netIds",
  );
});

// ═════════════════════════════════════════════════════════════════
// Metal connectivity tests
// ═════════════════════════════════════════════════════════════════

test("mergeMetalConnectedTerminals: two devices with D/S connected via ME1 → shared netIds", async () => {
  // Two single-finger NMOS devices sharing a metal-1 strip.
  // d1 (left diffusion, contacts ct1+ct2), d2 (right, contacts ct3+ct4).
  // A single ME1 rectangle covers ALL contacts → one UF component.
  resetDummyNets();
  const layers: CellLayers = {
    nwell: [rr("nw1", 0, 0, 100, 50)],
    diffusion: [
      rr("d1", 10, 10, 20, 20),
      rr("d2", 50, 10, 20, 20),
    ],
    polysilicon: [
      rr("p1", 20, 5, 4, 40),  // crosses d1
      rr("p2", 60, 5, 4, 40),  // crosses d2
    ],
    contact: [
      rr("ct1", 12, 12, 4, 4),   // left contact on d1
      rr("ct2", 24, 12, 4, 4),   // right contact on d1
      rr("ct3", 52, 12, 4, 4),   // left contact on d2
      rr("ct4", 64, 12, 4, 4),   // right contact on d2
    ],
    metal1: [
      rr("me1", 10, 12, 60, 4), // covers all four contacts
    ],
  };
  const devices = detectMOSFromLayers(layers, "test_cell", 1);
  mergeMetalConnectedTerminals(devices, layers as any);
  // Two single-finger devices (one per diffusion)
  assert.equal(devices.length, 2, "expected 2 MOS devices");

  // Both devices have 2 contacts → S and D both get netIds
  const sNets = devices.map((d) => d.terminals.find((t) => t.name === "S")!.netId);
  const dNets = devices.map((d) => d.terminals.find((t) => t.name === "D")!.netId);
  console.log(`  [test] S nets: ${sNets}, D nets: ${dNets}`);

  // All S and D terminals touch the same ME1 shape → same netId
  const allSD = [...sNets, ...dNets];
  // They should all be positive (netId >= 1000, not -1)
  for (const n of allSD) {
    assert.ok(n >= 1000, `S/D net ${n} should be >= 1000`);
  }
  // All four S/D terminal nets should be identical (one ME1 component)
  assert.equal(
    new Set(allSD).size,
    1,
    `all S/D terminals share one netId, got ${JSON.stringify(allSD)}`,
  );

  // Gate nets are still separate (no overlapping poly)
  const gNets = devices.map((d) => d.terminals.find((t) => t.name === "G")!.netId);
  assert.notEqual(gNets[0], gNets[1], "gate nets remain separate");
});

test("mergeMetalConnectedTerminals: two separate ME1 strips → two separate S/D groups", async () => {
  // Like the previous test but with DISCONNECTED ME1 strips.
  // d1 contacts connect via me1_left, d2 contacts via me1_right.
  // The strips do NOT overlap → two UF components → two netIds.
  resetDummyNets();
  const layers: CellLayers = {
    nwell: [rr("nw1", 0, 0, 100, 50)],
    diffusion: [
      rr("d1", 10, 10, 20, 20),
      rr("d2", 60, 10, 20, 20),
    ],
    polysilicon: [
      rr("p1", 20, 5, 4, 40),  // crosses d1
      rr("p2", 70, 5, 4, 40),  // crosses d2
    ],
    contact: [
      rr("ct1", 12, 12, 4, 4),
      rr("ct2", 24, 12, 4, 4),
      rr("ct3", 62, 12, 4, 4),
      rr("ct4", 74, 12, 4, 4),
    ],
    metal1: [
      rr("me1_left", 10, 12, 18, 4),   // covers ct1, ct2 only
      rr("me1_right", 60, 12, 18, 4),  // covers ct3, ct4 only
    ],
  };
  const devices = detectMOSFromLayers(layers, "test_cell", 1);
  mergeMetalConnectedTerminals(devices, layers as any);
  assert.equal(devices.length, 2, "expected 2 MOS devices");

  const sNets = devices.map((d) => d.terminals.find((t) => t.name === "S")!.netId);
  const dNets = devices.map((d) => d.terminals.find((t) => t.name === "D")!.netId);
  console.log(`  [test] S nets: ${sNets}, D nets: ${dNets}`);

  // M1's S and D should share one netId (me1_left)
  assert.equal(sNets[0], dNets[0], `M1 S=${sNets[0]} D=${dNets[0]} should match`);
  // M2's S and D should share another netId (me1_right)
  assert.equal(sNets[1], dNets[1], `M2 S=${sNets[1]} D=${dNets[1]} should match`);
  // M1's netId ≠ M2's netId (separate ME1 components)
  assert.notEqual(sNets[0], sNets[1], "M1 and M2 should have different netIds");

  // Gate nets are separate
  const gNets = devices.map((d) => d.terminals.find((t) => t.name === "G")!.netId);
  assert.notEqual(gNets[0], gNets[1], "gate nets remain separate");
});
