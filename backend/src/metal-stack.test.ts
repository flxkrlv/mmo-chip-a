import { describe, it } from "node:test";
import assert from "node:assert";
import { DEFAULT_METAL_STACK, validateMetalStack } from "./api/metalStack.js";

// Re-export validateMetalStack for testing — it's internal but we test it here.
function _validate(s: unknown): string | null {
  return validateMetalStack(s as any);
}

describe("MetalStack validation", () => {
  it("accepts the default 6-metal stack", () => {
    assert.equal(_validate(DEFAULT_METAL_STACK), null);
  });

  it("rejects empty metals", () => {
    assert.ok(_validate({ metals: [], vias: [], defaultMetalId: "", defaultViaId: "" }));
  });

  it("rejects metals with duplicate ids", () => {
    assert.ok(_validate({
      metals: [
        { id: "ME1", layer: "metal1", z: 1, name: "M1", color: "#fff" },
        { id: "ME1", layer: "metal2", z: 2, name: "M2", color: "#fff" },
      ],
      vias: [],
      defaultMetalId: "ME1",
      defaultViaId: "",
    }));
  });

  it("rejects out-of-order metals (z mismatch)", () => {
    assert.ok(_validate({
      metals: [
        { id: "ME1", layer: "metal1", z: 2, name: "M1", color: "#fff" },
        { id: "ME2", layer: "metal2", z: 1, name: "M2", color: "#fff" },
      ],
      vias: [],
      defaultMetalId: "ME1",
      defaultViaId: "",
    }));
  });

  it("rejects via referencing missing metal", () => {
    assert.ok(_validate({
      metals: [
        { id: "ME1", layer: "metal1", z: 1, name: "M1", color: "#fff" },
        { id: "ME2", layer: "metal2", z: 2, name: "M2", color: "#fff" },
      ],
      vias: [{ id: "VIA23", from: "ME2", to: "ME3", layer: "via1", color: "#fff" }],
      defaultMetalId: "ME1",
      defaultViaId: "",
    }));
  });

  it("rejects duplicate via ids", () => {
    assert.ok(_validate({
      metals: [
        { id: "ME1", layer: "metal1", z: 1, name: "M1", color: "#fff" },
        { id: "ME2", layer: "metal2", z: 2, name: "M2", color: "#fff" },
      ],
      vias: [
        { id: "VIA12", from: "ME1", to: "ME2", layer: "via1", color: "#fff" },
        { id: "VIA12", from: "ME1", to: "ME2", layer: "via1", color: "#fff" },
      ],
      defaultMetalId: "ME1",
      defaultViaId: "",
    }));
  });

  it("rejects invalid defaultMetalId", () => {
    assert.ok(_validate({
      metals: [
        { id: "ME1", layer: "metal1", z: 1, name: "M1", color: "#fff" },
      ],
      vias: [],
      defaultMetalId: "NONEXIST",
      defaultViaId: "",
    }));
  });

  it("accepts minimum valid config (1 metal, no vias)", () => {
    assert.equal(_validate({
      metals: [
        { id: "M1", layer: "metal1", z: 1, name: "Single", color: "#fff" },
      ],
      vias: [],
      defaultMetalId: "M1",
      defaultViaId: "",
    }), null);
  });
});
