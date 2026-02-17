/**
 * Background sync scheduler.
 * Runs push/pull every 2 minutes while the MCP server is active.
 */

import { syncCycle, isSyncEnabled } from "./sync.js";
import type { ContextIndex } from "./sqlite.js";
import type { Embedder } from "./embedder.js";

const SYNC_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes

export class SyncScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private index: ContextIndex,
    private embedder: Embedder
  ) {}

  start(): void {
    if (this.timer) return;
    if (!isSyncEnabled()) return;

    this.timer = setInterval(() => this.tick(), SYNC_INTERVAL_MS);
    this.timer.unref(); // don't keep process alive
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    if (this.running) return; // skip if previous tick is still in progress
    this.running = true;

    try {
      const result = await syncCycle(this.index, this.embedder);
      if (result.error) {
        process.stderr.write(`[synaptic-sync] ${result.error}\n`);
      }
    } catch (err) {
      process.stderr.write(`[synaptic-sync] tick error: ${err}\n`);
    } finally {
      this.running = false;
    }
  }
}
