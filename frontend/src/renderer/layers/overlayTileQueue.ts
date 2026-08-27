export interface OverlayTileRequest {
  priority: number;
  cancelled: boolean;
  started: boolean;
  run: (finish: () => void) => void;
}

/**
 * A small, process-wide queue for browser overlay tile requests. Keeping this
 * global prevents several visible overlay layers from independently filling
 * the browser connection pool with stale image downloads.
 */
export class OverlayTileQueue {
  private readonly pending: OverlayTileRequest[] = [];
  private active = 0;

  constructor(private readonly maxConcurrent: number) {}

  enqueue(request: OverlayTileRequest): void {
    this.pending.push(request);
    // Higher priority first; Array#sort is safe here because the queue is
    // intentionally tiny and only changes when a viewport changes.
    this.pending.sort((left, right) => right.priority - left.priority);
    this.pump();
  }

  cancel(request: OverlayTileRequest): void {
    request.cancelled = true;
    if (!request.started) {
      const index = this.pending.indexOf(request);
      if (index >= 0) this.pending.splice(index, 1);
    }
  }

  private pump(): void {
    while (this.active < this.maxConcurrent && this.pending.length > 0) {
      const request = this.pending.shift();
      if (!request || request.cancelled) continue;
      request.started = true;
      this.active += 1;
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        this.active -= 1;
        this.pump();
      };
      request.run(finish);
    }
  }
}

/** Browser-wide cap, shared by every visible tiled overlay. */
export const overlayTileQueue = new OverlayTileQueue(6);
