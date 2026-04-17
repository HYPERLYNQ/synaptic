import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "syn-load-"));
  process.env.SYNAPTIC_HOME = tmp;
  vi.resetModules();
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.SYNAPTIC_HOME;
});

describe("contextLoad", () => {
  it("returns checkpoint + references by exact name", async () => {
    const { contextLoad } = await import("../../src/tools/context-load.js");
    const { ContextIndex } = await import("../../src/storage/sqlite.js");
    const { appendEntry } = await import("../../src/storage/markdown.js");

    const index = new ContextIndex();
    try {
      const ref1 = appendEntry("r1 body", "insight", []);
      index.insert(ref1);
      const c = appendEntry("ckpt body".repeat(20), "checkpoint", ["rtx"], {
        name: "phase-5-start", summary: "Phase 5 kickoff",
        projectRoot: "/p", referencedEntryIds: [ref1.id], pinned: true,
      });
      index.insert(c);
    } finally { index.close(); }

    const result = await contextLoad({ name: "phase-5-start" });
    expect(result.checkpoint?.name).toBe("phase-5-start");
    expect(result.references.length).toBe(1);
    expect(result.references[0].contentPreview).toContain("r1 body");
  });

  it("returns a null checkpoint and empty candidates when name is totally absent", async () => {
    const { contextLoad } = await import("../../src/tools/context-load.js");
    const result = await contextLoad({ name: "missing" });
    expect(result.checkpoint).toBeNull();
    expect(result.references).toEqual([]);
    expect(result.candidates.length).toBe(0);
  });

  it("returns candidates list when name is ambiguous", async () => {
    const { contextLoad } = await import("../../src/tools/context-load.js");
    const { ContextIndex } = await import("../../src/storage/sqlite.js");
    const { appendEntry } = await import("../../src/storage/markdown.js");

    const index = new ContextIndex();
    try {
      for (const n of ["phase-5-foo", "phase-5-bar", "phase-5-baz"]) {
        const e = appendEntry("body".repeat(30), "checkpoint", [], { name: n, projectRoot: "/p" });
        index.insert(e);
      }
    } finally { index.close(); }
    const result = await contextLoad({ name: "phase-5" });
    expect(result.checkpoint).toBeNull();
    expect(result.candidates.length).toBeGreaterThanOrEqual(2);
  });
});
