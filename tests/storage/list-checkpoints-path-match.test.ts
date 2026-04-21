import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextIndex } from "../../src/storage/sqlite.js";

/**
 * v1.7.6 regression tests — before this release, `listCheckpoints` used
 * `project_root = ?` for filtering, which failed in two real-world cases:
 *
 *   1. Windows mixed separators: `git rev-parse --show-toplevel` emits
 *      "D:/Coding/hotship" but entries stored via OS APIs or manual DB
 *      inserts often used "D:\\Coding\\hotship". Same path, different
 *      string, zero matches.
 *   2. Legacy synced entries: pre-v1.7.3 sync dropped `project_root`
 *      entirely. Those rows had NULL in project_root but retained the
 *      `project` column (basename). The old filter couldn't surface them.
 */
describe("listCheckpoints — path normalization + basename fallback (v1.7.6)", () => {
  let tmpDbDir: string;
  let dbPath: string;
  let index: ContextIndex;

  beforeEach(() => {
    tmpDbDir = mkdtempSync(join(tmpdir(), "synaptic-list-path-"));
    dbPath = join(tmpDbDir, "context.db");
    index = new ContextIndex(dbPath);
  });

  afterEach(() => {
    index.close();
    rmSync(tmpDbDir, { recursive: true, force: true });
  });

  function insertCheckpoint(opts: {
    id: string;
    project?: string | null;
    projectRoot?: string | null;
  }) {
    index.insert({
      id: opts.id,
      date: "2026-04-21",
      time: "00:09",
      type: "checkpoint",
      tags: ["checkpoint"],
      content: `content for ${opts.id}`,
      sourceFile: "test",
      project: opts.project ?? undefined,
      projectRoot: opts.projectRoot ?? undefined,
      name: `cp-${opts.id}`,
    });
  }

  it("matches forward-slash query against backslash-stored project_root", () => {
    insertCheckpoint({ id: "ck-backslash", projectRoot: "D:\\Coding\\hotship" });
    const results = index.listCheckpoints({ projectRoot: "D:/Coding/hotship" });
    expect(results.map(r => r.id)).toContain("ck-backslash");
  });

  it("matches backslash query against forward-slash-stored project_root", () => {
    insertCheckpoint({ id: "ck-forward", projectRoot: "D:/Coding/hotship" });
    const results = index.listCheckpoints({ projectRoot: "D:\\Coding\\hotship" });
    expect(results.map(r => r.id)).toContain("ck-forward");
  });

  it("falls back to basename match for legacy entries with NULL project_root", () => {
    // Simulate a pre-v1.7.3 synced entry: project set (basename), but
    // project_root dropped by the old sync format.
    insertCheckpoint({ id: "ck-legacy", project: "hotship", projectRoot: null });
    const results = index.listCheckpoints({ projectRoot: "D:/Coding/hotship" });
    expect(results.map(r => r.id)).toContain("ck-legacy");
  });

  it("basename fallback also works with backslash query", () => {
    insertCheckpoint({ id: "ck-legacy-bs", project: "hotship", projectRoot: null });
    const results = index.listCheckpoints({ projectRoot: "D:\\Coding\\hotship" });
    expect(results.map(r => r.id)).toContain("ck-legacy-bs");
  });

  it("excludes checkpoints from a different project via normalized match", () => {
    insertCheckpoint({ id: "ck-other", projectRoot: "D:\\Coding\\other-repo" });
    const results = index.listCheckpoints({ projectRoot: "D:/Coding/hotship" });
    expect(results.map(r => r.id)).not.toContain("ck-other");
  });

  it("does not mis-match when a different project shares a basename", () => {
    // If project_root is set to a different path but basename happens to
    // equal, the basename fallback should NOT fire — the first branch
    // (normalized project_root) already handled it (no match), and the
    // second branch requires project_root to be NULL.
    insertCheckpoint({
      id: "ck-diff-path-same-name",
      project: "hotship",
      projectRoot: "D:\\OtherDrive\\hotship",
    });
    const results = index.listCheckpoints({ projectRoot: "D:/Coding/hotship" });
    expect(results.map(r => r.id)).not.toContain("ck-diff-path-same-name");
  });

  it("returns all checkpoints when projectRoot is not provided", () => {
    insertCheckpoint({ id: "ck-a", projectRoot: "/a/b" });
    insertCheckpoint({ id: "ck-b", projectRoot: "D:\\c\\d" });
    const results = index.listCheckpoints({});
    expect(results.map(r => r.id).sort()).toEqual(["ck-a", "ck-b"]);
  });
});
