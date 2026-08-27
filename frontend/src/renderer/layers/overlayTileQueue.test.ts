import { describe, expect, it } from "vitest";
import { OverlayTileQueue, type OverlayTileRequest } from "./overlayTileQueue";

function request(
  priority: number,
  started: string[],
  name: string,
  finishes: Map<string, () => void>
): OverlayTileRequest {
  return {
    priority,
    cancelled: false,
    started: false,
    run: (finish) => {
      started.push(name);
      finishes.set(name, finish);
    }
  };
}

describe("OverlayTileQueue", () => {
  it("starts the highest-priority pending tile when a slot becomes free", () => {
    const queue = new OverlayTileQueue(1);
    const started: string[] = [];
    const finishes = new Map<string, () => void>();
    const oldEdge = request(1, started, "old-edge", finishes);
    const currentEdge = request(2, started, "current-edge", finishes);
    const currentCenter = request(10, started, "current-center", finishes);

    queue.enqueue(oldEdge);
    queue.enqueue(currentEdge);
    queue.enqueue(currentCenter);
    expect(started).toEqual(["old-edge"]);

    finishes.get("old-edge")?.();
    expect(started).toEqual(["old-edge", "current-center"]);

    finishes.get("current-center")?.();
    expect(started).toEqual(["old-edge", "current-center", "current-edge"]);
  });

  it("does not start a pending tile cancelled after a viewport change", () => {
    const queue = new OverlayTileQueue(1);
    const started: string[] = [];
    const finishes = new Map<string, () => void>();
    const active = request(10, started, "active", finishes);
    const stale = request(1, started, "stale", finishes);

    queue.enqueue(active);
    queue.enqueue(stale);
    queue.cancel(stale);
    finishes.get("active")?.();

    expect(started).toEqual(["active"]);
  });
});
