import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  VectorBlockPayload,
  VectorSweepStatus,
  VectorizeParams
} from "shared";
import type { PredictBox } from "./predict.js";
import type { RunVectorizeResult } from "./vectorize.js";

/** Whole-die vectorize sweep: decode the die block-by-block (2048 px,
 *  under the live endpoint's 6 Mpx cap) and cache every block's decode on
 *  disk keyed by the params hash — the vector overlay then reads blocks
 *  instead of re-decoding the viewport, so a tuned parameter set covers the
 *  whole crystal instantly (the "inference" of the vector path).
 *
 * Blocks decode independently, so a wire crossing a block border is split
 * at the seam: the client's stitch tolerance merges the two halves into one
 * net (their endpoints coincide), same as ML tile seams.
 */

export const VECTOR_BLOCK_PX = 2048;

/** Stable cache key for a params set + image source. */
export function vectorParamsHash(
  params: VectorizeParams,
  overlaySource: string | undefined
): string {
  const canonical =
    JSON.stringify([
      params.channel,
      params.invert,
      params.threshLow,
      params.threshHigh,
      params.adaptive,
      params.adaptiveBlock,
      params.adaptiveC,
      params.openPx,
      params.bridgePx,
      params.minLength,
      params.widthMin,
      params.widthMax
    ]) + `|${overlaySource ?? ""}`;
  return `v1-${createHash("sha1").update(canonical).digest("hex").slice(0, 12)}`;
}

interface SweepJob extends VectorSweepStatus {
  cancel: boolean;
}

export function createVectorSweep(config: {
  dataRoot: string;
  /** The live endpoint's runner — reuse its crop/sidecar/translate logic. */
  runVectorize: (args: {
    originalPath: string;
    dieWidth: number;
    dieHeight: number;
    keep: PredictBox;
    vecParams: VectorizeParams;
    overlayPath?: string;
  }) => Promise<RunVectorizeResult>;
}) {
  /** One active sweep per die (the die id is the job key, like ML jobs). */
  const jobs = new Map<string, SweepJob>();

  function sweepDir(dieId: string, hash: string): string {
    return path.join(config.dataRoot, "vectorize", dieId, hash);
  }

  function publicStatus(job: SweepJob | undefined): VectorSweepStatus {
    if (!job) {
      return { dieId: "", status: "idle", done: 0, total: 0 };
    }
    return {
      dieId: job.dieId,
      status: job.status,
      done: job.done,
      total: job.total,
      error: job.error ?? null,
      paramsHash: job.paramsHash,
      overlayFilename: job.overlayFilename ?? null
    };
  }

  async function start(dieId: string, args: {
    originalPath: string;
    dieWidth: number;
    dieHeight: number;
    params: VectorizeParams;
    overlayPath?: string;
    overlaySource?: string;
  }): Promise<VectorSweepStatus> {
    const existing = jobs.get(dieId);
    if (existing && existing.status === "running") {
      throw new Error("vectorize sweep already running");
    }
    const hash = vectorParamsHash(args.params, args.overlaySource);
    const totalCols = Math.ceil(args.dieWidth / VECTOR_BLOCK_PX);
    const totalRows = Math.ceil(args.dieHeight / VECTOR_BLOCK_PX);
    const job: SweepJob = {
      dieId,
      status: "running",
      done: 0,
      total: totalCols * totalRows,
      error: null,
      paramsHash: hash,
      overlayFilename: args.overlaySource ?? null,
      cancel: false
    };
    jobs.set(dieId, job);

    const dir = sweepDir(dieId, hash);
    await fs.mkdir(dir, { recursive: true });

    // Sequential: the sidecar serializes CV work anyway; a queue just adds
    // memory pressure. Retry transient "busy" (CV-gate 429) a few times.
    void (async () => {
      try {
        for (let row = 0; row < totalRows; row++) {
          for (let col = 0; col < totalCols; col++) {
            if (job.cancel) {
              job.status = "stopped";
              return;
            }
            const x0 = col * VECTOR_BLOCK_PX;
            const y0 = row * VECTOR_BLOCK_PX;
            const x1 = Math.min(args.dieWidth, x0 + VECTOR_BLOCK_PX);
            const y1 = Math.min(args.dieHeight, y0 + VECTOR_BLOCK_PX);
            const bbox: [number, number, number, number] = [x0, y0, x1, y1];
            let result: RunVectorizeResult | null = null;
            let lastErr: unknown = null;
            for (let attempt = 0; attempt < 3; attempt++) {
              try {
                result = await config.runVectorize({
                  originalPath: args.originalPath,
                  dieWidth: args.dieWidth,
                  dieHeight: args.dieHeight,
                  keep: bbox,
                  vecParams: args.params,
                  overlayPath: args.overlayPath
                });
                lastErr = null;
                break;
              } catch (e) {
                lastErr = e;
                await new Promise((r) => setTimeout(r, 1500));
              }
            }
            if (!result) {
              throw lastErr instanceof Error ? lastErr : new Error("vectorize failed");
            }
            const payload: VectorBlockPayload = {
              col,
              row,
              bbox,
              traces: result.traces,
              outlines: result.outlines
            };
            const tmp = `${path.join(dir, `${col}_${row}.json`)}.${process.pid}.tmp`;
            await fs.writeFile(tmp, JSON.stringify(payload));
            await fs.rename(tmp, path.join(dir, `${col}_${row}.json`));
            job.done += 1;
          }
        }
        job.status = "completed";
      } catch (e) {
        job.status = "failed";
        job.error = e instanceof Error ? e.message : "sweep failed";
      }
    })();

    return publicStatus(job);
  }

  function get(dieId: string): VectorSweepStatus {
    return publicStatus(jobs.get(dieId));
  }

  function stop(dieId: string): VectorSweepStatus {
    const job = jobs.get(dieId);
    if (job && job.status === "running") job.cancel = true;
    return publicStatus(job);
  }

  /** Cached blocks intersecting a source-px bbox for a params set. Missing
   *  blocks are reported (client falls back to live decode) — never decoded
   *  here: the sweep is the only writer. */
  async function readBlocks(dieId: string, args: {
    dieWidth: number;
    dieHeight: number;
    bbox: PredictBox;
    params: VectorizeParams;
    overlaySource?: string;
  }): Promise<{ hash: string; blocks: VectorBlockPayload[]; missing: number }> {
    const hash = vectorParamsHash(args.params, args.overlaySource);
    const dir = sweepDir(dieId, hash);
    const [bx0, by0, bx1, by1] = args.bbox;
    const col0 = Math.max(0, Math.floor(bx0 / VECTOR_BLOCK_PX));
    const row0 = Math.max(0, Math.floor(by0 / VECTOR_BLOCK_PX));
    const col1 = Math.min(
      Math.ceil(args.dieWidth / VECTOR_BLOCK_PX) - 1,
      Math.floor((bx1 - 1) / VECTOR_BLOCK_PX)
    );
    const row1 = Math.min(
      Math.ceil(args.dieHeight / VECTOR_BLOCK_PX) - 1,
      Math.floor((by1 - 1) / VECTOR_BLOCK_PX)
    );
    const blocks: VectorBlockPayload[] = [];
    let missing = 0;
    for (let row = row0; row <= row1; row++) {
      for (let col = col0; col <= col1; col++) {
        try {
          const raw = await fs.readFile(path.join(dir, `${col}_${row}.json`), "utf8");
          blocks.push(JSON.parse(raw) as VectorBlockPayload);
        } catch {
          missing += 1;
        }
      }
    }
    return { hash, blocks, missing };
  }

  return { start, get, stop, readBlocks };
}
