import { describe, expect, it } from "vitest";
import type { AnnotationNet } from "shared";
import { busActions, closeBus, endBusWires, placeCorner, type Draft } from "./useMultiWireTool";

/** Two-wire bus heading right, starts 10 px apart vertically, in phase 2. */
const bus = (): Draft => ({
  phase: 2,
  points: [
    { x: 0, y: 0 },
    { x: 0, y: 10 }
  ],
  anchors: [null, null],
  paths: [[], []],
  locked: [false, false],
  pending: [null, null],
  dir: null,
  lastClick: null
});

let n = 0;
const uid = () => `id${++n}`;
const xy = (ps: Array<{ x: number; y: number }>) => ps.map((p) => [p.x, p.y]);

describe("staggered turns", () => {
  it("each click places one wire's corner where the click falls on it; the round completes after N clicks", () => {
    // Click near wire 1 (y=10) at x=100.
    const one = placeCorner(bus(), { x: 100, y: 9 }, false, 1, "metal1")!;
    expect(one.pending[1]).toEqual({ x: 100, y: 10, layer: "metal1" });
    expect(one.pending[0]).toBeNull();
    expect(one.paths).toEqual([[], []]); // round still open
    // Second click near wire 0, staggered further out at x=120.
    const two = placeCorner(one, { x: 120, y: 1 }, false, 1, "metal1")!;
    expect(xy(two.paths[0])).toEqual([[120, 0]]);
    expect(xy(two.paths[1])).toEqual([[100, 10]]);
    expect(two.pending).toEqual([null, null]);
    expect(two.dir).toBeNull(); // next round follows the cursor again
  });

  it("the round's direction is fixed by its first click", () => {
    const one = placeCorner(bus(), { x: 100, y: 9 }, false, 1, null)!;
    expect(one.dir!.y).toBe(0); // horizontal, pointing right
    expect(one.dir!.x).toBeGreaterThan(0);
    // Cursor now far below: without the lock this would snap downward.
    const two = placeCorner(one, { x: 60, y: 90 }, false, 1, null)!;
    expect(xy(two.paths[0])).toEqual([[60, 0]]);
  });

  it("next round routes on from the corners", () => {
    let d = placeCorner(bus(), { x: 100, y: 9 }, false, 1, null)!;
    d = placeCorner(d, { x: 120, y: 1 }, false, 1, null)!;
    // Going down: wire 0 is at x=120, wire 1 at x=100.
    d = placeCorner(d, { x: 121, y: 50 }, false, 1, "metal2")!;
    expect(d.pending[0]).toEqual({ x: 120, y: 50, layer: "metal2" });
  });

  it("ignores a click within minLen of the previous one (double-click's 2nd click)", () => {
    const one = placeCorner(bus(), { x: 100, y: 9 }, false, 4, null)!;
    expect(placeCorner(one, { x: 101, y: 8 }, false, 4, null)).toBeNull();
  });

  it("with one wire every click is a full turn (like wire mode)", () => {
    const single: Draft = { ...bus(), points: [{ x: 0, y: 0 }], anchors: [null], paths: [[]], locked: [false], pending: [null] };
    const d = placeCorner(single, { x: 50, y: 2 }, false, 1, null)!;
    expect(xy(d.paths[0])).toEqual([[50, 0]]);
  });
});

describe("ending wires on vias", () => {
  it("keeps the wire's corner from this round, and never lands two wires on one via", () => {
    let d = placeCorner(bus(), { x: 100, y: 1 }, false, 1, null)!; // wire 0 corner
    d = endBusWires(d, [{ endpoint: { x: 100, y: 30 }, lockIndex: 0 }], null)!;
    expect(xy(d.paths[0])).toEqual([[100, 0], [100, 30]]);
    expect(endBusWires(d, [{ endpoint: { x: 100, y: 30 }, lockIndex: 1 }], null)).toBeNull();
  });

  it("closes the round when the last waiting wire ends on a via", () => {
    let d = placeCorner(bus(), { x: 100, y: 9 }, false, 1, null)!; // wire 1 corner
    d = endBusWires(d, [{ endpoint: { x: 40, y: 0 }, lockIndex: 0 }], null)!;
    expect(xy(d.paths[1])).toEqual([[100, 10]]);
    expect(d.pending).toEqual([null, null]);
  });
});

describe("committing", () => {
  it("keeps corners of an unfinished round; wires that never moved are dropped", () => {
    const d = placeCorner(bus(), { x: 100, y: 9 }, false, 1, "metal1")!; // only wire 1
    const actions = busActions(closeBus(d), [], uid);
    expect(actions).toHaveLength(1);
    const net = (actions[0] as { net: AnnotationNet }).net;
    expect(xy(net.nodes)).toEqual([[0, 10], [100, 10]]);
    expect(net.edges[0].layer).toBe("metal1");
  });

  it("anchored starts extend their existing net from the anchor vertex", () => {
    const net: AnnotationNet = { id: "n1", name: "A", nodes: [{ id: "v1", x: 0, y: 0 }], edges: [] };
    let d: Draft = { ...bus(), anchors: [{ netId: "n1", nodeId: "v1" }, null] };
    d = placeCorner(d, { x: 40, y: 1 }, false, 1, null)!;
    d = placeCorner(d, { x: 40, y: 9 }, false, 1, null)!;
    const [ext] = busActions(d, [net], uid) as Array<{ net: AnnotationNet; prevNet: AnnotationNet | null }>;
    expect(ext.prevNet).toBe(net);
    expect(ext.net.edges[0].from).toBe("v1");
    expect(ext.net.nodes).toHaveLength(2);
  });
});
