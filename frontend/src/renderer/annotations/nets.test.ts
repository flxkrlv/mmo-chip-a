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

  it("omits the junction cross when it is toggled off", () => {
    const annotation = buildNetAnnotation(
      branch, () => 2, () => "#fff", () => false, undefined, undefined,
      () => 1, () => false, undefined, () => false,
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

describe("only visible dots get the enlarged grab area", () => {
  const midNet: AnnotationNet = {
    id: "n6",
    name: "Net 6",
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

  function drawAt(annotation: ReturnType<typeof buildNetAnnotation>, zoom: number): void {
    const ctx = {
      lineCap: "", lineJoin: "", lineWidth: 0, strokeStyle: "", fillStyle: "",
      beginPath() {}, moveTo() {}, lineTo() {}, fill() {}, stroke() {}, arc() {},
    } as unknown as CanvasRenderingContext2D;
    annotation.draw(ctx, { zoom } as never, { selected: false, isSelected: () => false } as never);
  }

  it("enlarges only the drawn dots in junction-only mode", () => {
    const annotation = buildNetAnnotation(
      midNet, () => 10, () => "#fff", () => false, undefined, undefined,
      () => 1.6, () => true,
    );
    drawAt(annotation, 1);
    // a is a visible end (degree 1) → grabbable 12 units out (radius 16).
    expect(annotation.hitTest?.({ x: 0, y: 12 }, 0.01)).toBe("net:n6/node:a");
    // b is a filtered-out mid bend (degree 2) → no dot → only the tiny slop.
    expect(annotation.hitTest?.({ x: 50, y: 12 }, 0.01)).toBeNull();
  });

  it("enlarges a mid bend once it is a visible connection point", () => {
    const annotation = buildNetAnnotation(
      midNet, () => 10, () => "#fff", () => false, undefined, undefined,
      () => 1.6, () => true,
      (_netId, x, y) => x === 50 && y === 0,
    );
    drawAt(annotation, 1);
    expect(annotation.hitTest?.({ x: 50, y: 12 }, 0.01)).toBe("net:n6/node:b");
  });
});

describe("contrastColor", () => {
  it("picks black on bright dots and white on dark ones", () => {
    expect(contrastColor("#2dd4bf")).toBe("#000000");
    expect(contrastColor("#101010")).toBe("#ffffff");
    expect(contrastColor("rgba(255, 255, 255, 0.8)")).toBe("#000000");
  });
});

describe("die-wide meganet spatial index", () => {
  // A 40×40 grid over a 4.7k × 4.7k px "die" — the size class the Trace
  // pipeline materializes. This used to scan the WHOLE net on every cursor
  // move (the net bbox always contains the cursor) and stroke it in full
  // into every overlapping tile — the "vectorize → sluggish UI" report.
  function megaNet(): AnnotationNet {
    const nodes: AnnotationNet["nodes"] = [];
    const edges: AnnotationNet["edges"] = [];
    const nid = (r: number, c: number) => `n${r * 40 + c}`;
    for (let r = 0; r < 40; r++) {
      for (let c = 0; c < 40; c++) {
        nodes.push({ id: nid(r, c), x: c * 120, y: r * 120 });
        if (c > 0) edges.push({ id: `e${edges.length}`, from: nid(r, c - 1), to: nid(r, c), layer: "metal1" });
        if (r > 0) edges.push({ id: `e${edges.length}`, from: nid(r - 1, c), to: nid(r, c) });
      }
    }
    return { id: "mega", name: "Mega", nodes, edges };
  }

  const mega = buildNetAnnotation(megaNet(), () => 4, () => "#fff");

  it("hit-tests vertices and edges with the same results as before", () => {
    // Exact node (600, 600) = row 5, col 5.
    expect(mega.hitTest?.({ x: 600, y: 600 }, 5)).toBe("net:mega/node:n205");
    // Mid-edge of the row-5 horizontal segment 600→720.
    const edge = mega.hitTest?.({ x: 660, y: 600 }, 4);
    expect(edge).toMatch(/^net:mega\/edge:/);
    // Far beyond the net's extent (broad phase misses) → no hit.
    expect(mega.hitTest?.({ x: 90000, y: 90000 }, 5)).toBeNull();
  });

  it("finds the un-bucketed long jumper edge", () => {
    // One edge spanning ~8000 grid cells → routed to the `longEdges` list
    // (not bucketed); the midpoint probe must still hit it. Nodes are kept
    // far from the probe so the always-wins vertex pass can't shadow it.
    const longOnly: AnnotationNet = {
      id: "lone", name: "Lone",
      nodes: [
        { id: "p1", x: 0, y: 0 },
        { id: "p2", x: 4800, y: 4800 }
      ],
      edges: [{ id: "eLong", from: "p1", to: "p2", layer: "metal1" }]
    };
    const a = buildNetAnnotation(longOnly, () => 4, () => "#fff");
    expect(a.hitTest?.({ x: 2400, y: 2400 }, 6)).toBe("net:lone/edge:eLong");
    // And the whole span still picks in a marquee (rect deliberately NOT a
    // diagonal square — that one meets the line exactly at its corners).
    expect(
      a.rectPickParts?.({ x: 100, y: 60, width: 4400, height: 4600 }, false)
    ).toEqual(["net:lone/edge:eLong"]);
  });

  it("strokes only the tile-visible fraction of the net", () => {
    let lineTo = 0;
    const ctx = {
      lineCap: "", lineJoin: "", lineWidth: 0, strokeStyle: "", fillStyle: "",
      beginPath() {}, moveTo() {}, lineTo() { lineTo++; }, stroke() {}, fill() {}, arc() {},
    } as unknown as CanvasRenderingContext2D;
    // A 240×240 world-unit tile in the middle of the 4.7k die (padding grows
    // it slightly) — far fewer segments than the net's ~3120.
    mega.draw(ctx, { zoom: 1, world: { x: 600, y: 600, width: 240, height: 240 } } as never, {
      selected: false,
      isSelected: () => false
    });
    expect(lineTo).toBeGreaterThan(0);
    expect(lineTo).toBeLessThan(200);
  });
});
