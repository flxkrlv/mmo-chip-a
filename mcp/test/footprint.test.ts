import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_CROP_SIDE,
  cellDieRect,
  clampToDie,
  expandRect,
  limitCropSide
} from "../src/footprint.js";

const TYPE_W = 40;
const TYPE_H = 20;

test("cellDieRect places an unoriented cell at its origin", () => {
  const rect = cellDieRect({ x: 100, y: 50 }, TYPE_W, TYPE_H);
  assert.deepEqual(rect, { x: 100, y: 50, width: 40, height: 20 });
});

test("cellDieRect rotates a 90° cell to H×W, centred where the type box was", () => {
  const rect = cellDieRect({ x: 100, y: 50, rotation: 90 }, TYPE_W, TYPE_H);
  assert.deepEqual(rect, { x: 110, y: 40, width: 20, height: 40 });
});

test("cellDieRect leaves the axis-aligned box unchanged under mirrors", () => {
  const plain = cellDieRect({ x: 100, y: 50 }, TYPE_W, TYPE_H);
  const mirrored = cellDieRect({ x: 100, y: 50, flippedH: true, flippedV: true }, TYPE_W, TYPE_H);
  assert.deepEqual(mirrored, plain);
  const rotatedMirrored = cellDieRect(
    { x: 100, y: 50, flippedH: true, rotation: 270 },
    TYPE_W,
    TYPE_H
  );
  const rotated = cellDieRect({ x: 100, y: 50, rotation: 270 }, TYPE_W, TYPE_H);
  assert.deepEqual(rotatedMirrored, rotated);
});

test("cellDieRect honours a per-instance bounds override", () => {
  const rect = cellDieRect(
    {
      x: 100,
      y: 50,
      bounds: { x: 10, y: 5, width: 20, height: 10 }
    },
    TYPE_W,
    TYPE_H
  );
  assert.deepEqual(rect, { x: 110, y: 55, width: 20, height: 10 });
});

test("cellDieRect rotates a bounds override too", () => {
  const rotated = cellDieRect(
    { x: 0, y: 0, rotation: 90, bounds: { x: 10, y: 5, width: 20, height: 10 } },
    TYPE_W,
    TYPE_H
  );
  assert.equal(rotated.width, 10);
  assert.equal(rotated.height, 20);
  assert.equal(rotated.x, 15);
  assert.equal(rotated.y, 0);

  const halfTurn = cellDieRect(
    { x: 0, y: 0, rotation: 180, bounds: { x: 10, y: 5, width: 20, height: 10 } },
    TYPE_W,
    TYPE_H
  );
  assert.deepEqual(halfTurn, { x: 10, y: 5, width: 20, height: 10 });
});

test("expandRect grows by the padding on every side", () => {
  assert.deepEqual(expandRect({ x: 10, y: 20, width: 4, height: 6 }, 5), {
    x: 5,
    y: 15,
    width: 14,
    height: 16
  });
  const unchanged = { x: 1, y: 2, width: 3, height: 4 };
  assert.deepEqual(expandRect(unchanged, 0), unchanged);
});

test("clampToDie rounds into the image bounds", () => {
  assert.deepEqual(clampToDie({ x: -7.4, y: -2, width: 30, height: 999 }, { width: 100, height: 50 }), {
    x: 0,
    y: 0,
    width: 30,
    height: 50
  });
  assert.deepEqual(clampToDie({ x: 95, y: 45, width: 40, height: 40 }, { width: 100, height: 50 }), {
    x: 95,
    y: 45,
    width: 5,
    height: 5
  });
});

test("limitCropSide caps sides at the backend's 4096 px limit", () => {
  const huge = limitCropSide({ x: 0, y: 0, width: 9000, height: 100 });
  assert.equal(huge.clipped, true);
  assert.equal(huge.rect.width, MAX_CROP_SIDE);
  assert.equal(huge.rect.height, 100);

  const small = limitCropSide({ x: 0, y: 0, width: 12, height: 13 });
  assert.equal(small.clipped, false);
  assert.equal(small.rect.width, 12);
  assert.equal(small.rect.height, 13);
});
