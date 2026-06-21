import { describe, it, expect } from "vitest";
import { pushEntries } from "../../src/storage/sync.js";

/**
 * Regression test for the v1.7.7 fix.
 *
 * pushEntries() filtered every local entry through an UNGUARDED
 * `new Date(`${e.date}T${e.time}:00`).toISOString()`. A seconds-precision
 * "HH:MM:SS" time — which legitimately enters the local index when pulled
 * from another machine, since fromSyncable() copies `time` verbatim —
 * produced a malformed "...:SS:00" string → Invalid Date → RangeError
 * "Invalid time value". Because the throw happened inside the .filter()
 * callback, a single such entry aborted the ENTIRE push, silently stalling
 * outbound sync (observed: ~2 months frozen on a machine that had pulled one).
 *
 * The filter now routes through safeIsoTimestamp() (which normalizes both
 * 5- and 8-char times and returns undefined instead of throwing).
 *
 * These tests stay hermetic: lastPushAt is set far in the future so every
 * fixture entry is filtered OUT, and pushEntries returns { pushed: 0 } via
 * the early-return BEFORE any filesystem/gh network call — yet the filter
 * callback (the exact line that used to throw) still runs for each entry.
 */
describe("pushEntries — push filter tolerates non-HH:MM times (v1.7.7 regression)", () => {
  const state = {
    config: {
      machineId: "test-machine",
      machineName: "test",
      repoOwner: "HYPERLYNQ",
      repoName: "synaptic-sync",
      enabled: true,
    },
    // Far-future cutoff → nothing passes the filter → early return, no network.
    lastPushAt: "2999-01-01T00:00:00.000Z",
    lastPullAt: "2999-01-01T00:00:00.000Z",
    remoteCursors: {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  function indexWith(entry: Record<string, unknown>) {
    // Minimal ContextIndex stub — pushEntries only calls list() in this path.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { list: () => [entry] } as any;
  }

  const baseEntry = {
    id: "regr1",
    type: "checkpoint",
    tags: [],
    content: "x",
    date: "2026-04-21",
  };

  it("does not throw on a seconds-precision 'HH:MM:SS' time (the exact crash trigger)", async () => {
    const index = indexWith({ ...baseEntry, time: "14:30:05" });
    await expect(pushEntries(index, state)).resolves.toEqual({ pushed: 0 });
  });

  it("still handles a normal 'HH:MM' time", async () => {
    const index = indexWith({ ...baseEntry, time: "14:30" });
    await expect(pushEntries(index, state)).resolves.toEqual({ pushed: 0 });
  });
});
