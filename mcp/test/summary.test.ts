import test from "node:test";
import assert from "node:assert/strict";
import type { DieAnnotations } from "shared";
import { InputError } from "../src/result.js";
import type { Rect } from "../src/footprint.js";
import {
  ALL_KINDS,
  MAX_FULL_BYTES,
  SUMMARY_KINDS,
  assertSize,
  buildSummary,
  parseKinds,
  pickKinds
} from "../src/summary.js";

function fixture(): DieAnnotations {
  return {
    version: 2,
    rev: 7,
    umPerPx: 0.005,
    nets: [
      { id: "n1", name: "VDD", nodes: [{ id: "a", x: 1, y: 2 }], edges: [] },
      { id: "n2", name: "GND", nodes: [], edges: [] }
    ],
    cellTypes: [{ id: "ct1", name: "inv", cropRect: { x: 0, y: 0, width: 40, height: 20 } }],
    cells: [
      { id: "c1", cellTypeId: "ct1", x: 100, y: 50, rotation: 90 },
      { id: "c2", cellTypeId: "ct1", x: 200, y: 60, flippedH: true }
    ],
    grids: [],
    pins: [{ id: "p1", name: "VDD", pin: 1, x: 10, y: 20 }],
    rulers: [
      {
        id: "r1",
        x1: 0,
        y1: 0,
        x2: 3,
        y2: 4,
        lengthPx: 5,
        lengthUm: 0.025
      }
    ],
    comments: [
      {
        id: "m1",
        x: 5,
        y: 6,
        text: "looks aligned",
        authorId: "u1",
        authorName: "alice",
        createdAt: "2026-10-22T10:00:00.000Z",
        replies: [
          { id: "rp1", text: "+1", authorId: "u2", authorName: "bob", createdAt: "2026-10-22T11:00:00.000Z" }
        ]
      }
    ],
    floorplanRegions: [
      {
        id: "z1",
        name: "bandgap",
        kind: "rect",
        geometry: [
          { x: 0, y: 0 },
          { x: 10, y: 10 }
        ],
        color: "#4dabf7",
        createdBy: null,
        createdByName: null,
        createdAt: null,
        reservedBy: null,
        reservedByName: null,
        reservedAt: null
      }
    ]
  };
}

const BOX: Rect = { x: 0, y: 0, width: 40, height: 20 };

test("buildSummary reports identity, counts for every kind and indexes rows", () => {
  const summary = buildSummary(fixture(), {});
  assert.equal(summary.rev, 7);
  assert.equal(summary.umPerPx, 0.005);
  assert.deepEqual(summary.counts, {
    nets: 2,
    cells: 2,
    cellTypes: 1,
    grids: 0,
    pins: 1,
    rulers: 1,
    comments: 1,
    floorplan: 1,
    annotations: 0,
    rois: 0,
    ignores: 0,
    guides: 0
  });
  assert.equal(summary.truncated, undefined);
  const nets = summary.nets as Array<Record<string, unknown>>;
  assert.deepEqual(nets[0], { id: "n1", name: "VDD", nodeCount: 1, edgeCount: 0 });
  const cells = summary.cells as Array<Record<string, unknown>>;
  assert.equal(cells.length, 2);
  assert.equal(cells[1].flippedH, true);
  assert.equal(cells[0].rotation, 90);
  const pins = summary.pins as Array<Record<string, unknown>>;
  assert.deepEqual(pins[0], { id: "p1", name: "VDD", pin: 1, x: 10, y: 20 });
  const comments = summary.comments as Array<Record<string, unknown>>;
  assert.equal(comments[0].replyCount, 1);
  const floorplan = summary.floorplan as Array<Record<string, unknown>>;
  assert.equal(floorplan[0].kind, "rect");
  assert.equal(floorplan[0].points, 2);
});

test("summary cells carry a die rect when their type box is known", () => {
  const summary = buildSummary(fixture(), {}, new Map([["ct1", BOX]]));
  const cells = summary.cells as Array<{ rect?: Rect }>;
  assert.deepEqual(cells[0].rect, { x: 110, y: 40, width: 20, height: 40 });
  assert.deepEqual(cells[1].rect, { x: 200, y: 60, width: 40, height: 20 });
});

test("summary cells omit rect when the type is unresolvable", () => {
  const summary = buildSummary(fixture(), {});
  const cells = summary.cells as Array<{ rect?: Rect }>;
  assert.equal(cells[0].rect, undefined);
});

test("limit truncates each index and records what was cut", () => {
  const summary = buildSummary(fixture(), { limit: 1 });
  assert.equal((summary.cells as unknown[]).length, 1);
  assert.equal((summary.nets as unknown[]).length, 1);
  assert.deepEqual(summary.truncated, { nets: 2, cells: 2 });
  assert.match(String(summary.limitHint), /mode:"full"/);
  assert.equal(summary.limited, 1);
});

test("kinds filter only the requested indexes but keeps all counts", () => {
  const summary = buildSummary(fixture(), { kinds: ["nets"] });
  assert.ok(summary.nets);
  assert.equal(summary.cells, undefined);
  assert.equal(summary.pins, undefined);
  assert.deepEqual(
    Object.keys(summary.counts as Record<string, unknown>).sort(),
    [...SUMMARY_KINDS].sort()
  );
});

test("parseKinds rejects unknown kinds with the valid list", () => {
  assert.deepEqual(parseKinds(["nets"], SUMMARY_KINDS), ["nets"]);
  assert.throws(() => parseKinds(["nope"], SUMMARY_KINDS), (error: unknown) => {
    assert.ok(error instanceof InputError);
    assert.match(error.message, /Unknown kind\(s\): nope/);
    assert.match(error.message, /Valid kinds: nets/);
    return true;
  });
  assert.throws(() => parseKinds(undefined, ALL_KINDS), /kinds is required/);
  assert.throws(() => parseKinds([], SUMMARY_KINDS), /kinds is required/);
  assert.throws(() => parseKinds(["mlConfig"], SUMMARY_KINDS), /Unknown kind/);
});

test("pickKinds hands back raw collections, defaulting absent optional ones", () => {
  const picked = pickKinds(fixture(), ["nets", "floorplan", "guides", "mlConfig"]);
  assert.equal((picked.nets as unknown[]).length, 2);
  assert.deepEqual(picked.floorplan, fixture().floorplanRegions);
  assert.deepEqual(picked.guides, []);
  assert.equal(picked.mlConfig, null);
  assert.equal(picked.cells, undefined);
});

test("assertSize refuses payloads over the full-mode cap", () => {
  assert.doesNotThrow(() => assertSize({ small: "ok" }, "test"));
  assert.throws(
    () => assertSize({ blob: "x".repeat(MAX_FULL_BYTES + 1) }, "test"),
    (error: unknown) => {
      assert.ok(error instanceof InputError);
      assert.match(error.message, /over the 4000000 byte cap/);
      assert.match(error.message, /Narrow the response/);
      return true;
    }
  );
});
