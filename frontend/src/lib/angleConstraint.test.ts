import { describe, expect, it } from "vitest";
import { constrainPoint } from "./angleConstraint";

const o = { x: 10, y: 10 };

describe("angle modes", () => {
  it("free leaves the point alone", () => {
    expect(constrainPoint(o, { x: 13, y: 27 }, "free")).toEqual({ x: 13, y: 27 });
  });
  it("h / v lock one axis to the anchor", () => {
    expect(constrainPoint(o, { x: 13, y: 27 }, "h")).toEqual({ x: 13, y: 10 });
    expect(constrainPoint(o, { x: 13, y: 27 }, "v")).toEqual({ x: 10, y: 27 });
  });
  it("ortho picks the dominant axis", () => {
    expect(constrainPoint(o, { x: 30, y: 15 }, "ortho")).toEqual({ x: 30, y: 10 });
    expect(constrainPoint(o, { x: 12, y: -20 }, "ortho")).toEqual({ x: 10, y: -20 });
  });
  it("diag snaps to 45° steps keeping the length", () => {
    const p = constrainPoint(o, { x: 20, y: 21 }, "diag");
    expect(p.x - o.x).toBeCloseTo(p.y - o.y);
    expect(Math.hypot(p.x - o.x, p.y - o.y)).toBeCloseTo(Math.hypot(10, 11));
    expect(constrainPoint(o, { x: 30, y: 12 }, "diag").y).toBeCloseTo(10);
    expect(constrainPoint(o, o, "diag")).toEqual(o);
  });
});
