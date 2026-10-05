import { describe, expect, it } from "vitest";
import type { AnnotationNet } from "shared";
import { cellTypeColor, edgeColor, netColors, toHex } from "./colorHex";

describe("toHex", () => {
  it("normalizes hex and converts rgb / rgba", () => {
    expect(toHex("#ABC")).toBe("#aabbcc");
    expect(toHex("#2E97FF")).toBe("#2e97ff");
    expect(toHex("#2e97ffff")).toBe("#2e97ff");
    expect(toHex("#2e97ff80")).toBe("#2e97ff80");
    expect(toHex("rgb(46, 151, 255)")).toBe("#2e97ff");
    expect(toHex("rgba(255, 0, 0, 0.5)")).toBe("#ff000080");
    expect(toHex("rgba(255, 0, 0, 1)")).toBe("#ff0000");
    expect(toHex("tomato")).toBe("tomato");
  });
});

describe("drawn colors", () => {
  const layers = { metal1: "#2dd4bf", metal2: "#a78bfa" };
  const prefs = { netColor: "#ffffff", netColors: {}, customNetColorsEnabled: true, wireLayerColors: {} };
  const net: AnnotationNet = {
    id: "n1", name: "A", nodes: [],
    edges: [
      { id: "e1", from: "a", to: "b", layer: "metal1" },
      { id: "e2", from: "b", to: "c", layer: "metal1" },
      { id: "e3", from: "c", to: "d", layer: "metal2" },
      { id: "e4", from: "d", to: "e" }
    ]
  };

  it("uses the layer color, the user's layer override, else the base color", () => {
    expect(edgeColor("n1", { layer: "metal1" }, prefs, layers)).toBe("#2dd4bf");
    expect(edgeColor("n1", { layer: "metal1" }, { ...prefs, wireLayerColors: { metal1: "#000001" } }, layers)).toBe("#000001");
    expect(edgeColor("n1", {}, prefs, layers)).toBe("#ffffff");
    expect(netColors(net, prefs, layers)).toEqual(["#2dd4bf", "#a78bfa", "#ffffff"]);
  });

  it("the net's own color wins only while custom net colors are on", () => {
    const own = { ...prefs, netColors: { "net:n1": "#ff3333" } };
    expect(netColors(net, own, layers)).toEqual(["#ff3333"]);
    const off = { ...own, customNetColorsEnabled: false };
    expect(edgeColor("n1", { layer: "metal2" }, off, layers)).toBe("#a78bfa");
    expect(edgeColor("n1", {}, off, layers)).toBe("#ff3333");
  });

  it("cell color falls back to the global cell color", () => {
    expect(cellTypeColor({ color: "#123456" }, "#ffaa00")).toBe("#123456");
    expect(cellTypeColor({}, "#ffaa00")).toBe("#ffaa00");
    expect(cellTypeColor(undefined, "#ffaa00")).toBe("#ffaa00");
  });
});
