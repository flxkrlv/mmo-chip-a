import assert from "node:assert/strict";
import test from "node:test";
import { buildLevels } from "./importer.js";

test("builds a complete zoom pyramid", () => {
  const levels = buildLevels(4096, 2048, 512, 3);
  assert.deepEqual(levels, [
    { z: 0, width: 512, height: 256, columns: 1, rows: 1, scale: 8 },
    { z: 1, width: 1024, height: 512, columns: 2, rows: 1, scale: 4 },
    { z: 2, width: 2048, height: 1024, columns: 4, rows: 2, scale: 2 },
    { z: 3, width: 4096, height: 2048, columns: 8, rows: 4, scale: 1 }
  ]);
});
