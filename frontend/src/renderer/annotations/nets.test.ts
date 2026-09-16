import { describe, expect, it } from "vitest";
import type { AnnotationNet } from "shared";
import { buildNetAnnotation } from "./nets";

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
