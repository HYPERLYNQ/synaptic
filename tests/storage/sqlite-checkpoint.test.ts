import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextIndex } from "../../src/storage/sqlite.js";

let tmp: string;
let index: ContextIndex;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "syn-ckpt-"));
  index = new ContextIndex(join(tmp, "ctx.db"));
});

afterEach(() => {
  index.close();
  rmSync(tmp, { recursive: true, force: true });
});

function mk(over: Partial<Parameters<ContextIndex["insert"]>[0]>): Parameters<ContextIndex["insert"]>[0] {
  return {
    id: over.id ?? "x",
    date: "2026-04-16",
    time: "14:00",
    type: over.type ?? "checkpoint",
    tags: [],
    content: "c",
    sourceFile: "/tmp/x.md",
    ...over,
  };
}

describe("ContextIndex — checkpoint columns + queries", () => {
  it("persists and reads name/summary/projectRoot/referencedEntryIds", () => {
    const id = "ckpt-1";
    index.insert({
      id, date: "2026-04-16", time: "14:00",
      type: "checkpoint",
      tags: ["rtx"],
      content: "narrative",
      sourceFile: "/tmp/x.md",
      name: "rtx-tracker-phase-5",
      summary: "Phase 5 kickoff",
      projectRoot: "/home/u/rtx-5090-tracker",
      referencedEntryIds: ["e1", "e2"],
      pinned: true,
    });

    const found = index.findCheckpointByName("rtx-tracker-phase-5");
    expect(found).not.toBeNull();
    expect(found!.id).toBe(id);
    expect(found!.summary).toBe("Phase 5 kickoff");
    expect(found!.projectRoot).toBe("/home/u/rtx-5090-tracker");
    expect(found!.referencedEntryIds).toEqual(["e1", "e2"]);
  });

  it("returns null when name does not exist", () => {
    expect(index.findCheckpointByName("no-such-name")).toBeNull();
  });

  it("lists checkpoints filtered by projectRoot", () => {
    index.insert(mk({ id: "a", name: "a1", projectRoot: "/p1" }));
    index.insert(mk({ id: "b", name: "b1", projectRoot: "/p2" }));
    index.insert(mk({ id: "c", name: "c1", projectRoot: "/p1" }));
    const list = index.listCheckpoints({ projectRoot: "/p1" });
    expect(list.map(e => e.id).sort()).toEqual(["a", "c"]);
  });

  it("enforces name uniqueness across non-null names only", () => {
    index.insert(mk({ id: "a", name: "same" }));
    expect(() => index.insert(mk({ id: "b", name: "same" }))).toThrow();
    index.insert(mk({ id: "c", name: undefined, type: "handoff" }));
    index.insert(mk({ id: "d", name: undefined, type: "handoff" }));
  });
});
