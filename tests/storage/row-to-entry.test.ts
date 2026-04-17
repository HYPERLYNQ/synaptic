/**
 * Guard against the regression discovered in the final audit: rowToEntry
 * must populate accessCount and lastAccessed, otherwise maintenance.ts
 * consolidation + smartDedup access-count preservation silently degrade.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextIndex } from "../../src/storage/sqlite.js";

let tmp: string;
let index: ContextIndex;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "syn-r2e-"));
  index = new ContextIndex(join(tmp, "ctx.db"));
});

afterEach(() => {
  index.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("rowToEntry — accessCount + lastAccessed round-trip", () => {
  it("populates accessCount on list() results", () => {
    index.insert({
      id: "a1",
      date: "2026-04-10",
      time: "10:00",
      type: "insight",
      tags: ["test"],
      content: "body",
      sourceFile: "/tmp/x.md",
      accessCount: 42,
      lastAccessed: "2026-04-10",
    });
    const entries = index.list({ days: 30 });
    const found = entries.find(e => e.id === "a1");
    expect(found).toBeDefined();
    expect(found!.accessCount).toBe(42);
    expect(found!.lastAccessed).toBe("2026-04-10");
  });

  it("populates accessCount on findCheckpointByName results", () => {
    index.insert({
      id: "c1",
      date: "2026-04-10",
      time: "10:00",
      type: "checkpoint",
      tags: [],
      content: "ckpt body",
      sourceFile: "/tmp/x.md",
      name: "r2e-checkpoint",
      accessCount: 7,
      lastAccessed: "2026-04-10",
    });
    const c = index.findCheckpointByName("r2e-checkpoint");
    expect(c).not.toBeNull();
    expect(c!.accessCount).toBe(7);
    expect(c!.lastAccessed).toBe("2026-04-10");
  });

  it("defaults accessCount to 0 when row has no explicit value", () => {
    index.insert({
      id: "a2",
      date: "2026-04-10",
      time: "10:00",
      type: "insight",
      tags: [],
      content: "body",
      sourceFile: "/tmp/x.md",
    });
    const entries = index.list({ days: 30 });
    const found = entries.find(e => e.id === "a2");
    expect(found).toBeDefined();
    expect(found!.accessCount).toBe(0);
    expect(found!.lastAccessed).toBeNull();
  });
});
