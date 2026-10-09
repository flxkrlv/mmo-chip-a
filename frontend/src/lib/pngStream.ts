/**
 * Streaming PNG encoder: rows go in band by band and are deflated as they
 * arrive (native `CompressionStream`), so an image far larger than any
 * canvas the browser will allocate can still be written. Output is 8-bit
 * RGB (alpha dropped), every row with the "Sub" filter.
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(parts: Uint8Array[]): number {
  let c = 0xffffffff;
  for (const p of parts) for (let i = 0; i < p.length; i++) c = CRC_TABLE[(c ^ p[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  const typeBytes = new TextEncoder().encode(type);
  out.set(typeBytes, 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32([typeBytes, data]));
  return out;
}

const SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

export class PngStreamEncoder {
  private readonly parts: Uint8Array[] = [];
  private readonly writer: WritableStreamDefaultWriter<BufferSource>;
  private readonly drained: Promise<void>;
  private rowsWritten = 0;

  constructor(readonly width: number, readonly height: number) {
    const ihdr = new Uint8Array(13);
    const v = new DataView(ihdr.buffer);
    v.setUint32(0, width);
    v.setUint32(4, height);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 2; // colour type: RGB
    this.parts.push(SIGNATURE, chunk("IHDR", ihdr));
    const cs = new CompressionStream("deflate"); // zlib-wrapped, as IDAT wants
    this.writer = cs.writable.getWriter();
    const reader = cs.readable.getReader();
    this.drained = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.length > 0) this.parts.push(chunk("IDAT", value));
      }
    })();
  }

  /** Append `rows` rows of RGBA pixels (`width × 4` bytes per row). */
  async addRows(rgba: Uint8Array | Uint8ClampedArray, rows: number): Promise<void> {
    const w = this.width;
    const stride = w * 4;
    const rowLen = 1 + w * 3;
    const out = new Uint8Array(rows * rowLen);
    for (let r = 0; r < rows; r++) {
      const src = r * stride;
      let o = r * rowLen;
      out[o++] = 1; // Sub: each byte minus the same channel one pixel left
      let pr = 0, pg = 0, pb = 0;
      for (let x = 0; x < w; x++) {
        const i = src + x * 4;
        const cr = rgba[i], cg = rgba[i + 1], cb = rgba[i + 2];
        out[o++] = (cr - pr) & 0xff;
        out[o++] = (cg - pg) & 0xff;
        out[o++] = (cb - pb) & 0xff;
        pr = cr; pg = cg; pb = cb;
      }
    }
    this.rowsWritten += rows;
    await this.writer.ready;
    await this.writer.write(out as Uint8Array<ArrayBuffer>);
  }

  /** Close the stream and return the PNG. */
  async finish(): Promise<Blob> {
    if (this.rowsWritten !== this.height) {
      throw new Error(`PNG: wrote ${this.rowsWritten} of ${this.height} rows`);
    }
    await this.writer.close();
    await this.drained;
    this.parts.push(chunk("IEND", new Uint8Array(0)));
    return new Blob(this.parts as BlobPart[], { type: "image/png" });
  }

  /** Give up (e.g. cancelled): release the compressor. */
  abort(): void {
    void this.writer.abort().catch(() => undefined);
  }
}
