import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "syn-se-"));
  process.env.SYNAPTIC_HOME = tmp;
  vi.resetModules();
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.SYNAPTIC_HOME;
});

describe("countMeaningfulSessionEvents", () => {
  it("returns 0 for sessions with no qualifying entries", async () => {
    const { countMeaningfulSessionEvents } = await import("../../../src/hooks/lib/session-events.js");
    const { ContextIndex } = await import("../../../src/storage/sqlite.js");
    const { appendEntry } = await import("../../../src/storage/markdown.js");
    const index = new ContextIndex();
    try {
      const entry = appendEntry("just an insight", "insight", []);
      (entry as any).sessionId = "s1";
      index.insert(entry);
      expect(countMeaningfulSessionEvents(index, "s1")).toBe(0);
    } finally { index.close(); }
  });

  it("counts git_commit + checkpoint + decision entries in the session", async () => {
    const { countMeaningfulSessionEvents } = await import("../../../src/hooks/lib/session-events.js");
    const { ContextIndex } = await import("../../../src/storage/sqlite.js");
    const { appendEntry } = await import("../../../src/storage/markdown.js");
    const index = new ContextIndex();
    try {
      for (const type of ["git_commit", "checkpoint", "decision"]) {
        const e = appendEntry("x", type, []);
        (e as any).sessionId = "s1";
        index.insert(e);
      }
      expect(countMeaningfulSessionEvents(index, "s1")).toBe(3);
    } finally { index.close(); }
  });

  it("ignores entries from other sessions", async () => {
    const { countMeaningfulSessionEvents } = await import("../../../src/hooks/lib/session-events.js");
    const { ContextIndex } = await import("../../../src/storage/sqlite.js");
    const { appendEntry } = await import("../../../src/storage/markdown.js");
    const index = new ContextIndex();
    try {
      const e1 = appendEntry("c1", "checkpoint", []); (e1 as any).sessionId = "s1"; index.insert(e1);
      const e2 = appendEntry("c2", "checkpoint", []); (e2 as any).sessionId = "s2"; index.insert(e2);
      expect(countMeaningfulSessionEvents(index, "s1")).toBe(1);
    } finally { index.close(); }
  });

  it("counts plan-write / spec-write entries via their tag", async () => {
    const { countMeaningfulSessionEvents } = await import("../../../src/hooks/lib/session-events.js");
    const { ContextIndex } = await import("../../../src/storage/sqlite.js");
    const { appendEntry } = await import("../../../src/storage/markdown.js");
    const index = new ContextIndex();
    try {
      const e = appendEntry("plan body", "insight", ["trigger:plan-write"]);
      (e as any).sessionId = "s1";
      index.insert(e);
      expect(countMeaningfulSessionEvents(index, "s1")).toBe(1);
    } finally { index.close(); }
  });
});
