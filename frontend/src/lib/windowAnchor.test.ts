import { describe, expect, it } from "vitest";
import type { FloorplanRegion } from "shared";
import {
  anchorForDrop,
  floorplanAnchorPoints,
  netAnchorPoints,
  reanchor,
  resolveAnchorPoint,
  type WindowAnchor
} from "./windowAnchor";

const net = (nodes: [string, number, number][]) => ({ nodes: nodes.map(([id, x, y]) => ({ id, x, y })) });

const poly = (pts: [number, number][]): FloorplanRegion =>
  ({ id: "f", kind: "polygon", geometry: pts.map(([x, y]) => ({ x, y })) } as FloorplanRegion);

const at = (key: string, x: number, y: number, sig?: string): WindowAnchor => ({ key, sig, x, y, dx: 20, dy: -5 });

describe("window anchors", () => {
  it("a net window follows its anchor node when the node moves", () => {
    const pts = netAnchorPoints(net([["a", 0, 0], ["b", 100, 0]]));
    const moved = netAnchorPoints(net([["a", 0, 0], ["b", 150, 40]]));
    expect(resolveAnchorPoint(moved, undefined, at("b", 100, 0))).toMatchObject({ key: "b", x: 150 });
    expect(reanchor(pts, undefined, at("b", 100, 0))).toEqual(at("b", 100, 0)); // unchanged → same object shape
  });

  it("deleting the anchor node re-anchors to the node nearest it, keeping the offset", () => {
    const after = netAnchorPoints(net([["a", 0, 0], ["c", 90, 10], ["d", 300, 0]]));
    expect(reanchor(after, undefined, at("b", 100, 0))).toEqual({ key: "c", sig: undefined, x: 90, y: 10, dx: 20, dy: -5 });
  });

  it("polygon vertex keys survive a moved vertex but not a changed vertex count", () => {
    const square: [number, number][] = [[0, 0], [100, 0], [100, 100], [0, 100]];
    const { points, sig } = floorplanAnchorPoints(poly(square));
    const stored = at("v2", 100, 100, sig);
    expect(resolveAnchorPoint(points, sig, stored)?.key).toBe("v2");

    // Vertex 2 dragged: same count → still v2, even though v1 is now nearer its old spot.
    const dragged = floorplanAnchorPoints(poly([[0, 0], [100, 0], [400, 400], [0, 100]]));
    expect(resolveAnchorPoint(dragged.points, dragged.sig, stored)?.key).toBe("v2");

    // Vertex 0 deleted: indices shift, so match by position → old v2 is now v1.
    const shifted = floorplanAnchorPoints(poly([[100, 0], [100, 100], [0, 100]]));
    expect(reanchor(shifted.points, shifted.sig, stored)).toMatchObject({ key: "v1", sig: "3", x: 100, y: 100 });

    // The anchor vertex itself deleted → its nearest remaining neighbour.
    const gone = floorplanAnchorPoints(poly([[0, 0], [100, 0], [0, 100]]));
    expect(reanchor(gone.points, gone.sig, stored)).toMatchObject({ x: 100, y: 0 });
  });

  it("rect floorplans anchor to one of their four corners", () => {
    const rect = { id: "r", kind: "rect", geometry: [{ x: 50, y: 60 }, { x: 10, y: 20 }] } as FloorplanRegion;
    expect(floorplanAnchorPoints(rect).points.map((p) => [p.key, p.x, p.y])).toEqual([
      ["c0", 10, 20], ["c1", 50, 20], ["c2", 50, 60], ["c3", 10, 60]
    ]);
  });

  it("a dropped window anchors to the point closest to its rectangle", () => {
    const pts = netAnchorPoints(net([["a", 0, 0], ["b", 100, 0]]));
    const toScreen = (p: { x: number; y: number }) => ({ x: p.x * 2, y: p.y * 2 }); // zoom 2, origin 0
    // Window spans x 220..320 → node b (screen 200) is 20 px away, a is 220 px away.
    const drop = anchorForDrop(pts, undefined, { left: 220, top: -30, width: 100, height: 60 }, toScreen);
    expect(drop).toEqual({ key: "b", sig: undefined, x: 100, y: 0, dx: 20, dy: -30 });
  });
});
