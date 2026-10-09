import { describe, expect, it } from "vitest";
import { PngStreamEncoder, crc32 } from "./pngStream";

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

describe("PngStreamEncoder", () => {
  it("crc32 matches the PNG reference value for IEND", () => {
    expect(crc32([new TextEncoder().encode("IEND")])).toBe(0xae426082);
  });

  it("writes a valid RGB PNG from bands, Sub-filtered", async () => {
    const w = 3;
    const h = 3;
    const px = (x: number, y: number) => [x * 40, y * 50, 200 - x * 10, 255];
    const enc = new PngStreamEncoder(w, h);
    for (const [y0, rows] of [[0, 2], [2, 1]]) {
      const band = new Uint8ClampedArray(w * 4 * rows);
      for (let r = 0; r < rows; r++) for (let x = 0; x < w; x++) band.set(px(x, y0 + r), (r * w + x) * 4);
      await enc.addRows(band, rows);
    }
    const bytes = new Uint8Array(await (await enc.finish()).arrayBuffer());
    expect([...bytes.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    // Walk the chunks, check CRCs, gather IDAT.
    const view = new DataView(bytes.buffer);
    const idat: number[] = [];
    const types: string[] = [];
    for (let o = 8; o < bytes.length; ) {
      const len = view.getUint32(o);
      const type = new TextDecoder().decode(bytes.slice(o + 4, o + 8));
      const data = bytes.slice(o + 8, o + 8 + len);
      expect(view.getUint32(o + 8 + len)).toBe(crc32([bytes.slice(o + 4, o + 8), data]));
      types.push(type);
      if (type === "IHDR") expect([view.getUint32(o + 8), view.getUint32(o + 12), data[8], data[9]]).toEqual([w, h, 8, 2]);
      if (type === "IDAT") idat.push(...data);
      o += 12 + len;
    }
    expect(types[0]).toBe("IHDR");
    expect(types[types.length - 1]).toBe("IEND");
    // Undo the Sub filter and compare to the source pixels.
    const raw = await inflate(new Uint8Array(idat));
    expect(raw.length).toBe(h * (1 + w * 3));
    for (let y = 0; y < h; y++) {
      const row = raw.slice(y * (1 + w * 3), (y + 1) * (1 + w * 3));
      expect(row[0]).toBe(1);
      const prev = [0, 0, 0];
      for (let x = 0; x < w; x++) {
        const got = [0, 1, 2].map((c) => (prev[c] = (row[1 + x * 3 + c] + prev[c]) & 0xff));
        expect(got).toEqual(px(x, y).slice(0, 3));
      }
    }
  });

  it("refuses to finish with rows missing", async () => {
    const enc = new PngStreamEncoder(2, 2);
    await enc.addRows(new Uint8ClampedArray(8), 1);
    await expect(enc.finish()).rejects.toThrow(/1 of 2/);
  });
});
