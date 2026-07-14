export interface ChunkedProgress {
  done: number;
  total: number;
  canceled: boolean;
}

export interface ChunkedRunnerOptions {
  chunkSize?: number;
  signal?: AbortSignal;
  onProgress?: (p: ChunkedProgress) => void;
}

export async function runChunked<T, R>(
  items: T[],
  fn: (item: T) => R,
  options: ChunkedRunnerOptions = {},
): Promise<R[]> {
  const { chunkSize = 50, signal, onProgress } = options;
  const results: R[] = new Array(items.length);

  onProgress?.({ done: 0, total: items.length, canceled: false });

  for (let i = 0; i < items.length; i += chunkSize) {
    if (signal?.aborted) {
      onProgress?.({ done: i, total: items.length, canceled: true });
      throw new DOMException("Aborted", "AbortError");
    }

    const end = Math.min(i + chunkSize, items.length);
    for (let j = i; j < end; j++) {
      results[j] = fn(items[j]);
    }

    onProgress?.({ done: end, total: items.length, canceled: false });
  }

  return results;
}
