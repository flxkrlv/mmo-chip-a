import { describe, it, expect, vi } from "vitest";
import { runChunked } from "./chunkedRunner";

describe("runChunked", () => {
  it("processes all items", async () => {
    const result = await runChunked([1, 2, 3], (x) => x * 2);
    expect(result).toEqual([2, 4, 6]);
  });

  it("processes empty array", async () => {
    const result = await runChunked([], (x) => x);
    expect(result).toEqual([]);
  });

  it("processes items in correct order", async () => {
    const items = ["a", "b", "c"];
    const result = await runChunked(items, (x) => x.toUpperCase());
    expect(result).toEqual(["A", "B", "C"]);
  });

  it("calls onProgress with correct values", async () => {
    const onProgress = vi.fn();
    await runChunked([1, 2, 3, 4, 5], (x) => x, {
      chunkSize: 2,
      onProgress,
    });
    expect(onProgress).toHaveBeenCalledTimes(4);
    expect(onProgress).toHaveBeenNthCalledWith(1, { done: 0, total: 5, canceled: false });
    expect(onProgress).toHaveBeenNthCalledWith(2, { done: 2, total: 5, canceled: false });
    expect(onProgress).toHaveBeenNthCalledWith(3, { done: 4, total: 5, canceled: false });
    expect(onProgress).toHaveBeenNthCalledWith(4, { done: 5, total: 5, canceled: false });
  });

  it("throws AbortError when signal is pre-aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runChunked([1, 2, 3], (x) => x, { signal: controller.signal }),
    ).rejects.toThrow("Aborted");
  });

  it("calls onProgress with canceled=true on abort", async () => {
    const controller = new AbortController();
    controller.abort();
    const onProgress = vi.fn();
    await expect(
      runChunked([1, 2, 3], (x) => x, {
        signal: controller.signal,
        onProgress,
      }),
    ).rejects.toThrow();
    expect(onProgress).toHaveBeenCalledWith({ done: 0, total: 3, canceled: true });
  });

  it("calls onProgress with canceled=false on normal completion", async () => {
    const onProgress = vi.fn();
    await runChunked([1], (x) => x, { onProgress });
    const finalCall = onProgress.mock.calls[onProgress.mock.calls.length - 1][0];
    expect(finalCall.canceled).toBe(false);
  });

  it("honors abort between chunks (signal fired before next chunk check)", async () => {
    const controller = new AbortController();
    const processed: number[] = [];
    const fn = vi.fn((x: number) => {
      processed.push(x);
      if (x === 1) controller.abort();
      return x;
    });
    await expect(
      runChunked([1, 2, 3, 4, 5], fn, { chunkSize: 2, signal: controller.signal }),
    ).rejects.toThrow("Aborted");
    expect(processed).toEqual([1, 2]);
  });
});
