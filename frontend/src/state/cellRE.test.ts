import { expect, test } from "vitest";
import type { CellREClipboard } from "./cellRE";

interface Assert {
  ok(value: unknown, message?: string): asserts value;
  equal(actual: unknown, expected: unknown, message?: string): void;
  deepEqual(actual: unknown, expected: unknown, message?: string): void;
}
const assert: Assert = {
  ok(value, message) {
    expect(value, message).toBeTruthy();
  },
  equal(actual, expected, message) {
    expect(actual, message).toBe(expected);
  },
  deepEqual(actual, expected, message) {
    expect(actual, message).toEqual(expected);
  }
};

// A stand-in for the browser: one shared localStorage and the `storage`
// listeners registered on this "tab". Installed before the store module
// loads, since it reads the clipboard and subscribes on import.
const KEY = "mmo-chip-shape-clipboard";
const storage = new Map<string, string>();
const listeners: Array<(e: { key: string | null; newValue: string | null }) => void> = [];
const fakeLocalStorage = {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => void storage.set(k, v),
  removeItem: (k: string) => void storage.delete(k)
};
(globalThis as unknown as { window: unknown }).window = {
  localStorage: fakeLocalStorage,
  addEventListener: (type: string, fn: (typeof listeners)[number]) => {
    if (type === "storage") listeners.push(fn);
  }
};
// The RE store also reads bare `localStorage` at module load (polyline width).
(globalThis as unknown as { localStorage: unknown }).localStorage = fakeLocalStorage;

const copied = (dieId: string, x: number): CellREClipboard => ({
  dieId,
  cellTypeId: "t1",
  items: [
    { layer: "metal1", shape: { id: "r", kind: "rect", x, y: 2, width: 10, height: 4, label: "vcc" } },
    { layer: "contact", shape: { id: "c", kind: "point", x: 5, y: 6, size: 4 } },
    { layer: "diffusion", shape: { id: "p", kind: "polygon", points: [{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 0, y: 3 }] } }
  ]
});

// Another tab copied before this one opened.
storage.set(KEY, JSON.stringify({ version: 1, ...copied("dieA", 1) }));
const { useCellREStore, parseClipboard, serializeClipboard } = await import("./cellRE");

test("a tab starts with what another tab already copied", () => {
  assert.deepEqual(useCellREStore.getState().clipboard, copied("dieA", 1));
});

test("copying writes the shared clipboard", () => {
  useCellREStore.getState().setClipboard(copied("dieB", 7));
  assert.deepEqual(parseClipboard(storage.get(KEY) ?? null), copied("dieB", 7));
});

test("another tab's copy lands in this tab's store", () => {
  const fire = (key: string | null, newValue: string | null) => listeners.forEach((fn) => fn({ key, newValue }));
  fire(KEY, serializeClipboard(copied("dieC", 3)));
  assert.deepEqual(useCellREStore.getState().clipboard, copied("dieC", 3));
  fire("mmo-chip-preferences", "{}");
  assert.deepEqual(useCellREStore.getState().clipboard, copied("dieC", 3), "other keys are ignored");
  fire(KEY, JSON.stringify({ version: 2, ...copied("dieD", 0) }));
  assert.equal(useCellREStore.getState().clipboard, null, "another build's format isn't pasted");
  fire(KEY, serializeClipboard(copied("dieC", 3)));
  fire(null, null);
  assert.equal(useCellREStore.getState().clipboard, null, "storage cleared");
});

test("parseClipboard rejects anything malformed", () => {
  const base = { version: 1, dieId: "d", cellTypeId: "t" };
  const bad = [
    "not json",
    JSON.stringify({ ...base, items: [] }),
    JSON.stringify({ ...base, dieId: 3, items: copied("d", 0).items }),
    JSON.stringify({ ...base, items: [{ layer: "metal9", shape: { id: "r", kind: "rect", x: 0, y: 0, width: 1, height: 1 } }] }),
    JSON.stringify({ ...base, items: [{ layer: "metal1", shape: { id: "r", kind: "rect", x: 0, y: 0, width: "1", height: 1 } }] }),
    JSON.stringify({ ...base, items: [{ layer: "metal1", shape: { id: "p", kind: "polygon", points: [{ x: 0 }] } }] }),
    JSON.stringify({ ...base, items: [{ layer: "metal1", shape: { id: "s", kind: "spline" } }] })
  ];
  for (const raw of bad) assert.equal(parseClipboard(raw), null, raw);
  assert.equal(parseClipboard(null), null);
  const good = copied("d", 0);
  assert.deepEqual(parseClipboard(serializeClipboard(good)), good);
});
