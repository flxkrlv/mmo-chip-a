import { describe, expect, it } from "vitest";
import type { AnnotationNet } from "shared";
import { AnnotationLayer } from "./AnnotationLayer";
import { buildNetAnnotation } from "../annotations/nets";

const net: AnnotationNet = {
  id: "n1",
  name: "Net 1",
  nodes: [
    { id: "a", x: 0, y: 0 },
    { id: "b", x: 200, y: 0 },
  ],
  edges: [{ id: "ab", from: "a", to: "b" }],
};

function makeLayer(): AnnotationLayer {
  const layer = new AnnotationLayer("test");
  const annotation = buildNetAnnotation(
    net,
    () => 10,
    () => "#fff",
    () => false,
    undefined,
    undefined,
    () => 1.6,
    () => false
  );
  // Draw once so the annotation caches its rendered dot radius (used by
  // hitTest). At zoom 1, netScreenWidth(1, 10) = 10 → dot world radius 16.
  const ctx = {
    lineCap: "",
    lineJoin: "",
    lineWidth: 0,
    strokeStyle: "",
    fillStyle: "",
    beginPath() {},
    moveTo() {},
    lineTo() {},
    fill() {},
    stroke() {},
    arc() {},
  } as unknown as CanvasRenderingContext2D;
  annotation.draw(ctx, { zoom: 1 } as never, {
    selected: false,
    isSelected: () => false,
  } as never);
  layer.add(annotation);
  return layer;
}

describe("AnnotationLayer.hitTest broad phase", () => {
  it("only finds the node centre with the default (narrow) tolerance", () => {
    const layer = makeLayer();
    // 12 world units below the (0,0) endpoint: inside the 16-unit dot but
    // outside the net's zero-height bbox, so the broad phase culls it.
    expect(layer.hitTest({ x: 0, y: 12 }, 0.01)).toBeNull();
  });

  it("finds the whole visible dot when given the dot radius as broad tolerance", () => {
    const layer = makeLayer();
    expect(layer.hitTest({ x: 0, y: 12 }, 0.01, 16)?.partId).toBe("net:n1/node:a");
  });
});
