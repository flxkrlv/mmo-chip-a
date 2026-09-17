import { describe, expect, it } from "vitest";
import type { AnnotationNet } from "shared";
import { connectToEdgeBody, weldNetAtEdge, weldNetAtNode } from "./netGraph";

function net(
  id: string,
  nodes: Array<[string, number, number]>,
  edges: Array<[string, string, string, ("metal1" | "metal2")?]>
): AnnotationNet {
  return {
    id,
    name: id,
    nodes: nodes.map(([nid, x, y]) => ({ id: nid, x, y })),
    edges: edges.map(([eid, from, to, layer]) => ({
      id: eid,
      from,
      to,
      ...(layer ? { layer } : {})
    }))
  };
}

describe("connectToEdgeBody", () => {
  it("splits the target edge and connects a free draft into it", () => {
    const target = net(
      "T",
      [["a", 0, 0], ["b", 100, 0]],
      [["e1", "a", "b", "metal1"]]
    );

    const changes = connectToEdgeBody(
      [target],
      [{ x: 50, y: 40 }, { x: 50, y: 20 }],
      null,
      null,
      { netId: "T", edgeId: "e1", at: { x: 50, y: 0 } },
      ["metal1"],
      "metal1"
    );

    expect(changes).toHaveLength(1);
    expect(changes[0].prev?.id).toBe("T");
    const next = changes[0].next!;
    // a, b + junction + two draft nodes.
    expect(next.nodes).toHaveLength(5);
    // two split edges + draft edge + bridge into the junction.
    expect(next.edges).toHaveLength(4);

    const junction = next.nodes.find((n) => n.x === 50 && n.y === 0);
    expect(junction).toBeTruthy();
    const incident = next.edges.filter(
      (e) => e.from === junction!.id || e.to === junction!.id
    );
    expect(incident).toHaveLength(3);
  });

  it("composes a start-edge split with the end-edge split", () => {
    const src = net(
      "S",
      [["s1", 0, 0], ["s2", 100, 0]],
      [["es", "s1", "s2", "metal1"]]
    );
    const dst = net(
      "D",
      [["d1", 0, 100], ["d2", 100, 100]],
      [["ed", "d1", "d2", "metal1"]]
    );

    const changes = connectToEdgeBody(
      [src, dst],
      [{ x: 50, y: 0 }, { x: 50, y: 50 }],
      null,
      { netId: "S", edgeId: "es", at: { x: 50, y: 0 } },
      { netId: "D", edgeId: "ed", at: { x: 50, y: 100 } },
      ["metal1"],
      "metal1"
    );

    // D is removed (merged), S is updated — both as a single undo batch.
    expect(changes).toHaveLength(2);
    const removed = changes.find((c) => c.next === null);
    expect(removed?.prev?.id).toBe("D");
    const merged = changes.find((c) => c.next && c.next.id === "S");
    expect(merged).toBeTruthy();
    // S keeps its id and now owns the merged graph (both nets' nodes).
    expect(merged!.prev!.id).toBe("S");
    expect(merged!.next!.nodes.length).toBe(7);
    expect(merged!.next!.edges.length).toBe(6);
  });

  it("returns nothing when the target edge is gone (caller falls back)", () => {
    const target = net("T", [["a", 0, 0]], []);
    const changes = connectToEdgeBody(
      [target],
      [{ x: 0, y: 10 }],
      null,
      null,
      { netId: "T", edgeId: "missing", at: { x: 0, y: 0 } },
      ["metal1"],
      "metal1"
    );
    expect(changes).toEqual([]);
  });
});

describe("weldNetAtNode", () => {
  it("merges two nets, welding the source endpoint onto the target vertex", () => {
    const a = net("A", [["a1", 0, 0], ["a2", 100, 0]], [["ea", "a1", "a2", "metal1"]]);
    const b = net("B", [["b1", 100, 0], ["b2", 100, 100]], [["eb", "b1", "b2", "metal1"]]);

    const changes = weldNetAtNode([a, b], "A", "a2", "B", "b1");

    expect(changes).toHaveLength(2);
    const removed = changes.find((c) => c.next === null);
    expect(removed?.prev?.id).toBe("A");
    const merged = changes.find((c) => c.next?.id === "B");
    expect(merged?.prev?.id).toBe("B");
    // b1, b2 + a1 (a2 was welded away).
    expect(merged!.next!.nodes.map((n) => n.id).sort()).toEqual(["a1", "b1", "b2"]);
    // eb + the source edge re-pointed onto b1.
    const srcEdge = merged!.next!.edges.find((e) => e.id === "ea");
    expect(srcEdge?.from === "b1" || srcEdge?.to === "b1").toBe(true);
  });

  it("refuses to weld a net to itself", () => {
    const a = net("A", [["a1", 0, 0], ["a2", 100, 0]], [["ea", "a1", "a2", "metal1"]]);
    expect(weldNetAtNode([a], "A", "a2", "A", "a1")).toEqual([]);
  });
});

describe("weldNetAtEdge", () => {
  it("splits the target edge and welds the source endpoint into the junction", () => {
    const a = net("A", [["a1", 0, 0], ["a2", 100, 0]], [["ea", "a1", "a2", "metal1"]]);
    const b = net("B", [["b1", 50, -50], ["b2", 50, 50]], [["eb", "b1", "b2", "metal1"]]);

    const changes = weldNetAtEdge([a, b], "A", "a2", "B", "eb", { x: 50, y: 0 });

    expect(changes).toHaveLength(2);
    const removed = changes.find((c) => c.next === null);
    expect(removed?.prev?.id).toBe("A");
    const merged = changes.find((c) => c.next?.id === "B");
    // Undo `prev` is the original (unsplit) B.
    expect(merged?.prev).toEqual(b);
    // b1, b2, junction + a1.
    expect(merged!.next!.nodes).toHaveLength(4);
    // two split edges + the source edge welded to the junction.
    expect(merged!.next!.edges).toHaveLength(3);
    const junction = merged!.next!.nodes.find((n) => n.x === 50 && n.y === 0);
    expect(junction).toBeTruthy();
    const srcEdge = merged!.next!.edges.find((e) => e.id === "ea");
    expect(srcEdge?.from === junction!.id || srcEdge?.to === junction!.id).toBe(true);
  });
});
