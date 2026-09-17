import { describe, expect, it } from "vitest";
import type { AnnotationNet } from "shared";
import { buildNetAnnotation } from "./nets";
import { contrastColor } from "./style";

const net: AnnotationNet = {
  id: "n1",
  name: "Net 1",
  nodes: [
    { id: "a", x: 10, y: 10 },
    { id: "b", x: 30, y: 10 },
    { id: "c", x: 50, y: 10 },
  ],
  edges: [
    { id: "ab", from: "a", to: "b" },
    { id: "bc", from: "b", to: "c" },
  ],
};

describe("net marquee parts", () => {
  it("selects only fully contained segments left-to-right", () => {
    const annotation = buildNetAnnotation(net, () => 10, () => "#fff");
    expect(annotation.rectPickParts?.({ x: 5, y: 5, width: 30, height: 10 }, true)).toEqual([
      "net:n1/edge:ab",
    ]);
  });

  it("selects crossing segments right-to-left", () => {
    const annotation = buildNetAnnotation(net, () => 10, () => "#fff");
    expect(annotation.rectPickParts?.({ x: 25, y: 5, width: 10, height: 10 }, false)).toEqual([
      "net:n1/edge:ab",
      "net:n1/edge:bc",
    ]);
  });
});

describe("junction-only node drawing", () => {
  const midNet: AnnotationNet = {
    id: "n2",
    name: "Net 2",
    nodes: [
      { id: "a", x: 0, y: 0 },
      { id: "b", x: 50, y: 0 },
      { id: "c", x: 100, y: 0 },
    ],
    edges: [
      { id: "ab", from: "a", to: "b" },
      { id: "bc", from: "b", to: "c" },
    ],
  };

  function drawnNodeKeys(annotation: ReturnType<typeof buildNetAnnotation>): string[] {
    const arcs: string[] = [];
    const ctx = {
      lineCap: "", lineJoin: "", lineWidth: 0, strokeStyle: "", fillStyle: "",
      beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fill() {},
      arc(x: number, y: number) { arcs.push(`${x},${y}`); },
    } as unknown as CanvasRenderingContext2D;
    annotation.draw(ctx, { zoom: 1 } as never, { selected: false, isSelected: () => false } as never);
    return arcs.sort();
  }

  it("hides a plain mid-net bend (degree 2)", () => {
    const annotation = buildNetAnnotation(
      midNet, () => 2, () => "#fff", () => false, undefined, undefined,
      () => 1, () => true,
    );
    expect(drawnNodeKeys(annotation)).toEqual(["0,0", "100,0"]);
  });

  it("shows a mid-net vertex that is a device-electrode connection point", () => {
    const annotation = buildNetAnnotation(
      midNet, () => 2, () => "#fff", () => false, undefined, undefined,
      () => 1, () => true,
      (netId, x, y) => netId === "n2" && x === 50 && y === 0,
    );
    expect(drawnNodeKeys(annotation)).toEqual(["0,0", "100,0", "50,0"]);
  });

  it("ignores a connection point belonging to another net", () => {
    const annotation = buildNetAnnotation(
      midNet, () => 2, () => "#fff", () => false, undefined, undefined,
      () => 1, () => true,
      (netId, x, y) => netId === "other" && x === 50 && y === 0,
    );
    expect(drawnNodeKeys(annotation)).toEqual(["0,0", "100,0"]);
  });
});

describe("junction cross", () => {
  const branch: AnnotationNet = {
    id: "n3",
    name: "Net 3",
    nodes: [
      { id: "a", x: 0, y: 0 },
      { id: "b", x: 50, y: 0 },
      { id: "c", x: 100, y: 0 },
      { id: "d", x: 50, y: 50 },
    ],
    edges: [
      { id: "ab", from: "a", to: "b" },
      { id: "bc", from: "b", to: "c" },
      { id: "bd", from: "b", to: "d" },
    ],
  };
  const bend: AnnotationNet = {
    id: "n5",
    name: "Net 5",
    nodes: [
      { id: "a", x: 0, y: 0 },
      { id: "b", x: 50, y: 0 },
      { id: "c", x: 100, y: 0 },
    ],
    edges: [
      { id: "ab", from: "a", to: "b" },
      { id: "bc", from: "b", to: "c" },
    ],
  };

  function strokeCount(annotation: ReturnType<typeof buildNetAnnotation>): number {
    let strokes = 0;
    const ctx = {
      lineCap: "", lineJoin: "", lineWidth: 0, strokeStyle: "", fillStyle: "",
      beginPath() {}, moveTo() {}, lineTo() {}, fill() {}, arc() {},
      stroke() { strokes++; },
    } as unknown as CanvasRenderingContext2D;
    annotation.draw(ctx, { zoom: 1 } as never, { selected: false, isSelected: () => false } as never);
    return strokes;
  }

  it("draws an extra cross on a branching junction", () => {
    const annotation = buildNetAnnotation(
      branch, () => 2, () => "#fff", () => false, undefined, undefined,
      () => 1, () => false,
    );
    // One batched stroke for the edges + one for the cross at node b.
    expect(strokeCount(annotation)).toBe(2);
  });

  it("adds no cross to a plain degree-2 bend", () => {
    const annotation = buildNetAnnotation(
      bend, () => 2, () => "#fff", () => false, undefined, undefined,
      () => 1, () => false,
    );
    expect(strokeCount(annotation)).toBe(1);
  });
});

describe("node hitbox matches the drawn dot", () => {
  const lineNet: AnnotationNet = {
    id: "n4",
    name: "Net 4",
    nodes: [
      { id: "a", x: 0, y: 0 },
      { id: "b", x: 200, y: 0 },
    ],
    edges: [{ id: "ab", from: "a", to: "b" }],
  };

  function drawAt(annotation: ReturnType<typeof buildNetAnnotation>, zoom: number): void {
    const ctx = {
      lineCap: "", lineJoin: "", lineWidth: 0, strokeStyle: "", fillStyle: "",
      beginPath() {}, moveTo() {}, lineTo() {}, fill() {}, stroke() {}, arc() {},
    } as unknown as CanvasRenderingContext2D;
    annotation.draw(ctx, { zoom } as never, { selected: false, isSelected: () => false } as never);
  }

  it("uses the screen-clamped dot radius at low zoom", () => {
    const annotation = buildNetAnnotation(
      lineNet, () => 10, () => "#fff", () => false, undefined, undefined,
      () => 1.6, () => false,
    );
    drawAt(annotation, 0.02);
    // netScreenWidth(0.02, 10) clamps to 0.5 -> world radius 0.5*1.6/0.02 = 40.
    expect(annotation.hitTest?.({ x: 0, y: 30 }, 0.01)).toBe("net:n4/node:a");
    expect(annotation.hitTest?.({ x: 0, y: 50 }, 0.01)).toBeNull();
  });
});

describe("contrastColor", () => {
  it("picks black on bright dots and white on dark ones", () => {
    expect(contrastColor("#2dd4bf")).toBe("#000000");
    expect(contrastColor("#101010")).toBe("#ffffff");
    expect(contrastColor("rgba(255, 255, 255, 0.8)")).toBe("#000000");
  });
});
