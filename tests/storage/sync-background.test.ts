import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * These tests cover the diagnostics scaffolding added to fix silent sync stalls:
 * the rotating logfile, log-tail reader, and the module-level tick-status getter.
 * The actual tick loop is exercised implicitly by syncCycle — here we just verify
 * the observability plumbing that lets a stall be diagnosed.
 */

let tmp: string;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "syn-sbg-"));
  process.env.SYNAPTIC_HOME = tmp;
  vi.resetModules();
});

afterEach(() => {
  delete process.env.SYNAPTIC_HOME;
  rmSync(tmp, { recursive: true, force: true });
});

describe("sync-background — diagnostics", () => {
  it("writeSyncLog appends lines under SYNAPTIC_HOME/.claude-context/sync/sync.log", async () => {
    const mod = await import("../../src/storage/sync-background.js");
    mod.writeSyncLog("2026-04-18T19:00:00.000Z tick ok pushed=1 pulled=2");
    mod.writeSyncLog("2026-04-18T19:02:00.000Z tick ok pushed=0 pulled=0");

    expect(existsSync(mod.SYNC_LOG_PATH)).toBe(true);
    const content = readFileSync(mod.SYNC_LOG_PATH, "utf-8");
    expect(content).toContain("pushed=1 pulled=2");
    expect(content).toContain("pushed=0 pulled=0");
  });

  it("rotates the log when it exceeds the size threshold", async () => {
    const mod = await import("../../src/storage/sync-background.js");
    mod.writeSyncLog("seed"); // ensures SYNC_DIR exists
    const bigLine = "x".repeat(260 * 1024);
    writeFileSync(mod.SYNC_LOG_PATH, bigLine, "utf-8");
    expect(statSync(mod.SYNC_LOG_PATH).size).toBeGreaterThan(256 * 1024);

    mod.writeSyncLog("2026-04-18T19:05:00.000Z tick ok pushed=3 pulled=4");

    expect(existsSync(mod.SYNC_LOG_ROTATED_PATH)).toBe(true);
    expect(readFileSync(mod.SYNC_LOG_ROTATED_PATH, "utf-8").length).toBeGreaterThan(256 * 1024);
    const active = readFileSync(mod.SYNC_LOG_PATH, "utf-8");
    expect(active).toContain("pushed=3 pulled=4");
    expect(active.length).toBeLessThan(1024);
  });

  it("readSyncLogTail returns the last N lines, dropping blanks", async () => {
    const mod = await import("../../src/storage/sync-background.js");
    for (let i = 0; i < 5; i++) {
      mod.writeSyncLog(`line ${i}`);
    }
    const tail = mod.readSyncLogTail(3);
    expect(tail).toEqual(["line 2", "line 3", "line 4"]);
  });

  it("readSyncLogTail returns [] when the log does not exist yet", async () => {
    const mod = await import("../../src/storage/sync-background.js");
    expect(mod.readSyncLogTail()).toEqual([]);
  });

  it("getSyncTickStatus returns a defaults snapshot before any tick has run", async () => {
    const mod = await import("../../src/storage/sync-background.js");
    const status = mod.getSyncTickStatus();
    expect(status).toEqual({
      lastTickAt: null,
      lastTickOk: null,
      lastTickError: null,
      lastTickPushed: 0,
      lastTickPulled: 0,
      isRunning: false,
    });
  });
});
