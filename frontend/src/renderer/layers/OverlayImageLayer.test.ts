import { describe, expect, it } from "vitest";
import type { OverlayImageSource } from "../../api/overlayImages";
import { OverlayImageLayer, type OverlayImageDisplay } from "./OverlayImageLayer";

describe("OverlayImageLayer", () => {
  it("keeps a successfully decoded tile when its tile and viewport generations differ", () => {
    const source = {
      id: "overlay",
      ready: true,
      width: 512,
      height: 512,
      tileSize: 512,
      levels: [{ z: 0, width: 512, height: 512, columns: 1, rows: 1, scale: 1 }]
    } as OverlayImageSource;
    const display: OverlayImageDisplay = {
      getImage: () => null,
      getSource: () => source,
      getHidden: () => false,
      getOpacity: () => 1,
      getOffsetX: () => 0,
      getOffsetY: () => 0
    };
    const layer = new OverlayImageLayer("overlay:overlay", "die", display);
    const internals = layer as unknown as {
      cache: Map<string, {
        z: number;
        x: number;
        y: number;
        image: null;
        state: string;
        lastUsed: number;
        generation: number;
      }>;
      viewportGeneration: number;
      desiredTileKeys: Set<string>;
      completeTileLoad: (
        key: string,
        tile: unknown,
        source: OverlayImageSource,
        requestedAt: number,
        tileGeneration: number,
        viewportGeneration: number
      ) => void;
    };
    const key = "overlay/0/0/0";
    const tile = {
      z: 0,
      x: 0,
      y: 0,
      image: null,
      state: "loading",
      lastUsed: 1,
      generation: 0
    };
    internals.cache.set(key, tile);
    internals.viewportGeneration = 1;
    internals.desiredTileKeys.add(key);

    internals.completeTileLoad(key, tile, source, performance.now(), 0, 1);

    expect(tile.state).toBe("loaded");
    expect(internals.cache.get(key)).toBe(tile);
  });
});
