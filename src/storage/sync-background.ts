/**
 * Background sync scheduler.
 * Runs push/pull every 2 minutes while the MCP server is active, plus a
 * fast initial tick so short-lived sessions still sync.
 *
 * Tick outcomes are recorded to a rotating logfile in SYNC_DIR and exposed
 * via getSyncTickStatus() so stalls are diagnosable without stderr capture.
 */

import { appendFileSync, existsSync, renameSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { syncCycle, isSyncEnabled } from "./sync.js";
import { SYNC_DIR, ensureDirs } from "./paths.js";
import type { ContextIndex } from "./sqlite.js";
import type { Embedder } from "./embedder.js";

const SYNC_INTERVAL_MS = 2 * 60 * 1000;
const INITIAL_TICK_DELAY_MS = 30 * 1000;
const LOG_ROTATE_BYTES = 256 * 1024;

export const SYNC_LOG_PATH = join(SYNC_DIR, "sync.log");
export const SYNC_LOG_ROTATED_PATH = join(SYNC_DIR, "sync.log.1");

export interface SyncTickStatus {
  lastTickAt: string | null;
  lastTickOk: boolean | null;
  lastTickError: string | null;
  lastTickPushed: number;
  lastTickPulled: number;
  isRunning: boolean;
}

let _lastTickStatus: SyncTickStatus = {
  lastTickAt: null,
  lastTickOk: null,
  lastTickError: null,
  lastTickPushed: 0,
  lastTickPulled: 0,
  isRunning: false,
};

export function getSyncTickStatus(): SyncTickStatus {
  return { ..._lastTickStatus };
}

export function writeSyncLog(line: string): void {
  try {
    ensureDirs();
    if (existsSync(SYNC_LOG_PATH) && statSync(SYNC_LOG_PATH).size > LOG_ROTATE_BYTES) {
      renameSync(SYNC_LOG_PATH, SYNC_LOG_ROTATED_PATH);
    }
    appendFileSync(SYNC_LOG_PATH, line + "\n", "utf-8");
  } catch {
    // logging is best-effort — don't let it crash the scheduler
  }
}

export function readSyncLogTail(maxLines = 20): string[] {
  try {
    if (!existsSync(SYNC_LOG_PATH)) return [];
    const raw = readFileSync(SYNC_LOG_PATH, "utf-8");
    const lines = raw.split("\n").filter(l => l.length > 0);
    return lines.slice(-maxLines);
  } catch {
    return [];
  }
}

export class SyncScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private initialTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(
    private index: ContextIndex,
    private embedder: Embedder
  ) {}

  start(): void {
    if (this.timer) return;
    if (!isSyncEnabled()) return;

    this.initialTimer = setTimeout(() => void this.tick(), INITIAL_TICK_DELAY_MS);
    this.initialTimer.unref();

    this.timer = setInterval(() => void this.tick(), SYNC_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.initialTimer) {
      clearTimeout(this.initialTimer);
      this.initialTimer = null;
    }
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    _lastTickStatus = { ..._lastTickStatus, isRunning: true };

    try {
      const result = await syncCycle(this.index, this.embedder);
      const at = new Date().toISOString();
      if (result.error) {
        process.stderr.write(`[synaptic-sync] ${result.error}\n`);
        writeSyncLog(`${at} tick error pushed=${result.pushed} pulled=${result.pulled} error=${result.error}`);
        _lastTickStatus = {
          lastTickAt: at,
          lastTickOk: false,
          lastTickError: result.error,
          lastTickPushed: result.pushed,
          lastTickPulled: result.pulled,
          isRunning: false,
        };
      } else {
        writeSyncLog(`${at} tick ok pushed=${result.pushed} pulled=${result.pulled}`);
        _lastTickStatus = {
          lastTickAt: at,
          lastTickOk: true,
          lastTickError: null,
          lastTickPushed: result.pushed,
          lastTickPulled: result.pulled,
          isRunning: false,
        };
      }
    } catch (err) {
      const at = new Date().toISOString();
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[synaptic-sync] tick error: ${msg}\n`);
      writeSyncLog(`${at} tick exception error=${msg}`);
      _lastTickStatus = {
        lastTickAt: at,
        lastTickOk: false,
        lastTickError: msg,
        lastTickPushed: 0,
        lastTickPulled: 0,
        isRunning: false,
      };
    } finally {
      this.running = false;
    }
  }
}
