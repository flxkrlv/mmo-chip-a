import assert from "node:assert/strict";
import test from "node:test";
import { checkImagingRegion, imagingLimits, ImagingLimitError } from "./limits.js";
import { marginFor, stackInstanceCap, MAX_INSTANCES } from "./specimen.js";

test("checkImagingRegion passes request-sized regions and rejects oversized ones", () => {
  // A large whole-cell crop on a high-magnification die stays within the
  // loose imaging bound (16.7 MP / 8192 px per side).
  checkImagingRegion(4000, 4000);
  assert.throws(() => checkImagingRegion(4200, 4200), ImagingLimitError); // 17.6 MP
  assert.throws(() => checkImagingRegion(9000, 9000), ImagingLimitError);
  assert.throws(() => checkImagingRegion(0, 100), ImagingLimitError);
  assert.throws(() => checkImagingRegion(-1, 100), ImagingLimitError);
});

test("stackInstanceCap bounds stacking within the specimen budget", () => {
  // A small cell: every instance stacks (cap = MAX_INSTANCES).
  assert.equal(stackInstanceCap(64, 48), MAX_INSTANCES);
  // A big type on a high-magnification die stacks fewer instances, but at
  // least one, within the 2 GiB default budget.
  const margin = marginFor(8000, 6000);
  const perInstance = (8000 + 2 * margin) * (6000 + 2 * margin) * 3 * 4;
  const expected = Math.max(1, Math.floor(imagingLimits.specimenBudgetBytes / perInstance));
  assert.equal(stackInstanceCap(8000, 6000), Math.min(MAX_INSTANCES, expected));
  assert.ok(stackInstanceCap(8000, 6000) < MAX_INSTANCES);
  // A tiny budget still stacks one instance.
  assert.equal(stackInstanceCap(1000, 1000, 1024), 1);
});
