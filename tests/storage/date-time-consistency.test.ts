import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Regression test for the v1.7.4 fix: `formatDate()` used UTC while
 * `formatTime()` used local tz. For entries created during the few
 * hours where local is still "yesterday evening" but UTC has already
 * rolled to "tomorrow", the two functions would produce a date/time
 * pair that parses as a nonsensical future wall time — the exact
 * bug behind "~22h ago" / "~1d ago" displays in /list-checkpoints.
 *
 * This test forces that exact clock condition and checks that the
 * stored date matches the local date (which is what the stored time
 * is in).
 */
describe("date + time storage are both in local tz (v1.7.4 regression)", () => {
  let tmpCtxDir: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tmpCtxDir = mkdtempSync(join(tmpdir(), "synaptic-dt-test-"));
    // paths.ts uses `process.env.SYNAPTIC_HOME ?? homedir()` + ".claude-context"
    originalHome = process.env.SYNAPTIC_HOME;
    process.env.SYNAPTIC_HOME = tmpCtxDir;
    // paths.ensureDirs() is called elsewhere in the real app; mimic it here.
    mkdirSync(join(tmpCtxDir, ".claude-context", "context"), {
      recursive: true,
      mode: 0o700,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalHome === undefined) delete process.env.SYNAPTIC_HOME;
    else process.env.SYNAPTIC_HOME = originalHome;
    rmSync(tmpCtxDir, { recursive: true, force: true });
  });

  it("date + time written on a local-vs-UTC midnight boundary are internally consistent", async () => {
    // Set wall clock to 2026-04-20 22:36 EDT (= 2026-04-21 02:36 UTC).
    // The buggy v1.7.3 behavior: date="2026-04-21" (UTC), time="22:36"
    // (local). That pair reads back as 2026-04-21T22:36 — a future wall
    // time that trips relative-time math to "~22h ago".
    const localMidnightBoundary = new Date("2026-04-21T02:36:47.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(localMidnightBoundary);

    // Bypass the module cache so appendEntry re-reads our shimmed env.
    vi.resetModules();
    const { appendEntry } = await import("../../src/storage/markdown.js");

    const entry = appendEntry("test content", "checkpoint", ["test"]);

    // Recompute what local date/time SHOULD be for the fake clock.
    const expectedDate = [
      localMidnightBoundary.getFullYear(),
      String(localMidnightBoundary.getMonth() + 1).padStart(2, "0"),
      String(localMidnightBoundary.getDate()).padStart(2, "0"),
    ].join("-");
    const expectedHM = localMidnightBoundary.toTimeString().slice(0, 5);

    // Both must be in the SAME timezone — otherwise the date/time pair
    // is internally incoherent.
    expect(entry.date).toBe(expectedDate);
    expect(entry.time).toBe(expectedHM);

    // And parsing the pair as local time should land within a few
    // seconds of the wall clock, not 22 hours away.
    const parsed = new Date(`${entry.date}T${entry.time}:00`);
    const skewMs = Math.abs(parsed.getTime() - localMidnightBoundary.getTime());
    expect(skewMs).toBeLessThan(60_000); // within one minute
  });
});
