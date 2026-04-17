import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "syn-stop-"));
  process.env.SYNAPTIC_HOME = tmp;
  vi.resetModules();
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.SYNAPTIC_HOME;
});

async function runStopWith(input: unknown): Promise<void> {
  const { runStop } = await import("../../src/hooks/stop.js");
  const stream = (async function* () { yield Buffer.from(JSON.stringify(input)); })();
  // runStop may not accept a stdin arg yet — if TypeScript complains, make it optional
  // following the Task 8/9 pattern.
  await (runStop as unknown as (s?: AsyncIterable<unknown>) => Promise<void>)(stream);
}

describe("runStop — v1.5.0 gating", () => {
  it("writes no handoff when the session had no meaningful events", { timeout: 15000 }, async () => {
    await runStopWith({ stop_hook_active: false });
    const { ContextIndex } = await import("../../src/storage/sqlite.js");
    const index = new ContextIndex();
    try {
      const handoffs = index.list({ days: 1, type: "handoff" });
      expect(handoffs.length).toBe(0);
    } finally { index.close(); }
  });
});
