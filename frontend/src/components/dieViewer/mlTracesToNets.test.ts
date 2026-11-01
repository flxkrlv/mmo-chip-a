import { describe, expect, it } from "vitest";
import { buildNetsFromTraces } from "./mlTracesToNets";
import type { AnnotationNetEdge } from "shared";
import type { MLTracePolyline } from "shared";

/** traced nodes for an edge, resolved against the net's node list. */
function edgeNodes(net: { nodes: { id: string; x: number; y: number }[] }, e: AnnotationNetEdge) {
  const a = net.nodes.find((n) => n.id === e.from)!;
  const b = net.nodes.find((n) => n.id === e.to)!;
  return [a, b];
}

const near = (x: number, y: number) => (n: { x: number; y: number }) =>
  Math.hypot(n.x - x, n.y - y) < 1.5;

describe("contact branch attach (mlTracesToNets)", () => {
  it("mid-bus contact attaches AT the projection, not half a segment away", () => {
    // Wide-bus case from the max-branch-len commit: the runs fragment is a
    // long straight 2-POINT line crossing the pad; the contact sits on the
    // middle of it. The branch must leave at the projection (T-junction),
    // never from a fragment end vertex (the old index-threshold bug).
    const trace: MLTracePolyline = {
      points: [
        [-10, 50],
        [210, 50]
      ],
      score: 1
    };
    const result = buildNetsFromTraces({
      traces: [trace],
      outlines: [[[0, 0], [200, 0], [200, 100], [0, 100]]],
      minScore: 0,
      snapTargets: [{ x: 100, y: 70, label: "pad-A" }],
      snapTol: 2, // too tight for phase 1a/1b → phase 1c (outline membership)
      stitchTol: 6,
      layer: "metal1",
      maxBranchLen: 40
    });
    expect(result.nets).toHaveLength(1);
    const net = result.nets[0];
    expect(result.outlineConnected).toBe(1);
    const contactEdges = net.edges.filter((e) => {
      const [a, b] = edgeNodes(net, e);
      return net.nodes.some(near(100, 70)) && [a, b].some(near(100, 70));
    });
    expect(contactEdges).toHaveLength(1);
    const [a, b] = edgeNodes(net, contactEdges[0]);
    // The other endpoint must be ON the wire at the projection (100, 50):
    const wireEnd =
      net.nodes.find(near(100, 70)) === a ? b : a;
    expect(near(100, 50)(wireEnd)).toBe(true);
    // NO branch touching a far fragment-end vertex (±10..210 band ≠ 100):
    const farBranch = net.edges.some((e) => {
      const [na, nb] = edgeNodes(net, e);
      return ([na, nb].some(near(100, 70)) &&
        [na, nb].some((n) => Math.abs(n.x - 100) > 20));
    });
    expect(farBranch).toBe(false);
  });

  it("a projection essentially ON the trace end vertex still branches from it", () => {
    const trace: MLTracePolyline = {
      points: [
        [0, 0],
        [0, 100]
      ],
      score: 1
    };
    const result = buildNetsFromTraces({
      traces: [trace],
      outlines: [
        [[-20, -20], [20, -20], [20, 120], [-20, 120]]
      ],
      minScore: 0,
      snapTargets: [{ x: 5, y: 0.5, label: "pin-1" }], // 0.5px from vertex [0,0]
      snapTol: 8,
      stitchTol: 6,
      layer: "metal1",
      maxBranchLen: 40
    });
    expect(result.nets).toHaveLength(1);
    const net = result.nets[0];
    // The wire keeps its 2 original vertices — no sliver vertex at (0, 0.5):
    const wireNodes = net.nodes.filter((n) => Math.abs(n.x - 5) > 1);
    expect(wireNodes).toHaveLength(2);
    expect(wireNodes.some(near(0, 0))).toBe(true);
    expect(wireNodes.some(near(0, 100))).toBe(true);
    // Branch edge from vertex (0,0) to the contact:
    const contact = net.nodes.find(near(5, 0.5))!;
    expect(contact).toBeDefined();
    const branch = net.edges.find((e) => {
      const [na, nb] = edgeNodes(net, e);
      return ([na, nb].some(near(5, 0.5)) && [na, nb].some(near(0, 0)));
    });
    expect(branch).toBeDefined();
  });

  it("a contact near (but not at) the trace end splits just before it", () => {
    const trace: MLTracePolyline = {
      points: [
        [0, 50],
        [200, 50]
      ],
      score: 1
    };
    const result = buildNetsFromTraces({
      traces: [trace],
      outlines: [[[0, 0], [200, 0], [200, 100], [0, 100]]],
      minScore: 0,
      snapTargets: [{ x: 190, y: 70, label: "pad-B" }],
      snapTol: 2,
      stitchTol: 6,
      layer: "metal1",
      maxBranchLen: 40
    });
    const net = result.nets[0];
    expect(net).toBeDefined();
    const contactEdges = net.edges.filter((e) =>
      edgeNodes(net, e).some(near(190, 70))
    );
    expect(contactEdges).toHaveLength(1);
    const [a, b] = edgeNodes(net, contactEdges[0]);
    const other = near(190, 70)(a) ? b : a;
    expect(near(190, 50)(other)).toBe(true); // projection, not the end (200,50)
  });

  it("decoder-group union uses SURVIVOR indices (filters must not shift them)", () => {
    // Regression: group-union used to read `group` off the RAW traces array
    // with the survivors' index — after any score/degenerate/irregular drop
    // it picked up FOREIGN groups. Here trace#0 (single, group 1) is
    // score-filtered away; traces #1/#2 share group 2 and must union into
    // ONE net, even though rawTraces[0].group would say otherwise.
    const traces: MLTracePolyline[] = [
      { points: [[0, 0], [0, 400]], score: 0, group: 1 }, // dropped by minScore
      { points: [[1000, 0], [1000, 100]], score: 1, group: 2 },
      { points: [[2000, 0], [2000, 100]], score: 1, group: 2 }
    ];
    const result = buildNetsFromTraces({
      traces,
      minScore: 0.5,
      snapTargets: [],
      snapTol: 2,
      stitchTol: 6,
      layer: "metal1"
    });
    expect(result.filteredByScore).toBe(1);
    expect(result.nets).toHaveLength(1); // group 2 union survived the shift
  });

  it("an almost-reaching wire END wins over a far same-contour wire (tier B)", () => {
    // The user's triangle case: the contact sits on a wide pad whose own
    // centreline was width-filtered away; a decoded wire APPROACHES the
    // contact and stops just short of the pad edge (min-gap blob), its end
    // a few px from the contact; the nearest trace actually IN the pad is
    // far away. The branch must take the near wire END (tier B), not draw
    // a long chord to the far in-pad wire.
    const farInPad: MLTracePolyline = {
      points: [[60, -60], [60, 160]],
      score: 1
    };
    const almostReached: MLTracePolyline = {
      points: [[300, 58], [205, 58]], // ends OUTSIDE the pad, no crossing
      score: 1
    };
    const result = buildNetsFromTraces({
      traces: [farInPad, almostReached],
      outlines: [[[0, 0], [200, 0], [200, 100], [0, 100]]],
      minScore: 0,
      snapTargets: [{ x: 195, y: 50, label: "pad-C" }],
      snapTol: 2, // phases 1a/1b can't reach → phase 1c decides
      stitchTol: 6,
      layer: "metal1",
      maxBranchLen: 20
    });
    expect(result.outlineConnected).toBe(1);
    // The branch may live in the approaching wire's own net — search all:
    const touches = result.nets.flatMap((net) =>
      net.edges.filter((e) => edgeNodes(net, e).some(near(195, 50))).map((e) => ({ net, e }))
    );
    expect(touches).toHaveLength(1);
    const [a, b] = edgeNodes(touches[0].net, touches[0].e);
    // The branch leaves from the approaching wire's END (205, 58):
    expect([a, b].some(near(205, 58))).toBe(true);
    // …and NOT from the far in-pad wire (x = 60):
    expect([a, b].every((n) => Math.abs(n.x - 60) > 20)).toBe(true);
  });

  it("a snap longer than maxBranchLen is dropped, not drawn as a chord", () => {
    const farInPad: MLTracePolyline = {
      points: [[60, -60], [60, 160]],
      score: 1
    };
    const almostReached: MLTracePolyline = {
      points: [[300, 58], [205, 58]],
      score: 1
    };
    const result = buildNetsFromTraces({
      traces: [farInPad, almostReached],
      outlines: [[[0, 0], [200, 0], [200, 100], [0, 100]]],
      minScore: 0,
      snapTargets: [{ x: 195, y: 50, label: "pad-C" }],
      snapTol: 2,
      stitchTol: 6,
      layer: "metal1",
      maxBranchLen: 5 // nothing within the budget → drop the snap entirely
    });
    expect(result.outlineConnected).toBe(0);
    expect(result.outlineDropped).toBe(1);
    // No net touches the contact point at all:
    for (const net of result.nets) {
      for (const e of net.edges) {
        const [a, b] = edgeNodes(net, e);
        expect([a, b].some(near(195, 50))).toBe(false);
      }
    }
  });
});
