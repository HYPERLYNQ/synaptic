import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "syn-sc-"));
  process.env.SYNAPTIC_HOME = tmp;
  vi.resetModules();
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.SYNAPTIC_HOME;
});

describe("saveCheckpoint", () => {
  it("persists a pinned checkpoint with all fields", async () => {
    const { saveCheckpoint } = await import("../../../src/hooks/lib/save-checkpoint.js");
    const { ContextIndex } = await import("../../../src/storage/sqlite.js");

    const res = await saveCheckpoint({
      name: "phase-5-start",
      summary: "Phase 5 kickoff",
      content: "Narrative body text goes here so the checkpoint has real content stored.",
      tags: ["rtx-5090-tracker"],
      projectRoot: "/home/u/rtx-5090-tracker",
      referencedEntryIds: ["e1", "e2"],
    });
    expect(res.id).toBeTruthy();

    const index = new ContextIndex();
    try {
      const e = index.findCheckpointByName("phase-5-start");
      expect(e).not.toBeNull();
      expect(e!.type).toBe("checkpoint");
      expect(e!.pinned).toBe(true);
      expect(e!.projectRoot).toBe("/home/u/rtx-5090-tracker");
      expect(e!.referencedEntryIds).toEqual(["e1", "e2"]);
    } finally {
      index.close();
    }
  });

  it("returns existing id when name already exists (idempotent dedupe)", async () => {
    const { saveCheckpoint } = await import("../../../src/hooks/lib/save-checkpoint.js");

    const a = await saveCheckpoint({
      name: "dup-name", content: "one", tags: [], projectRoot: "/p",
    });
    const b = await saveCheckpoint({
      name: "dup-name", content: "two", tags: [], projectRoot: "/p",
    });
    expect(b.id).toBe(a.id);
    expect(b.deduped).toBe(true);
  });
});
