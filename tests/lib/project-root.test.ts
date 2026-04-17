import { describe, it, expect, vi, beforeEach } from "vitest";
import * as cp from "node:child_process";
import { detectProjectRoot, knownProjectTags } from "../../src/lib/project-root.js";

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof cp>("node:child_process");
  return { ...actual, spawnSync: vi.fn() };
});

type SpawnResult = { stdout: Buffer; stderr: Buffer; status: number };

function mockSpawn(result: Partial<SpawnResult> | Error) {
  const fn = cp.spawnSync as unknown as ReturnType<typeof vi.fn>;
  fn.mockReset();
  if (result instanceof Error) {
    fn.mockImplementation(() => { throw result; });
  } else {
    fn.mockReturnValue({
      stdout: Buffer.from(""),
      stderr: Buffer.from(""),
      status: 0,
      ...result,
    });
  }
}

describe("detectProjectRoot", () => {
  beforeEach(() => {
    (cp.spawnSync as unknown as ReturnType<typeof vi.fn>).mockReset();
  });

  it("returns the git toplevel when inside a repo", () => {
    mockSpawn({ stdout: Buffer.from("/home/u/repo\n"), status: 0 });
    expect(detectProjectRoot("/home/u/repo/src")).toBe("/home/u/repo");
  });

  it("returns cwd when git returns empty stdout", () => {
    mockSpawn({ stdout: Buffer.from(""), status: 0 });
    expect(detectProjectRoot("/tmp/notrepo")).toBe("/tmp/notrepo");
  });

  it("returns cwd when git exits non-zero", () => {
    mockSpawn({ stdout: Buffer.from(""), stderr: Buffer.from("fatal: not a git repo"), status: 128 });
    expect(detectProjectRoot("/tmp/notrepo")).toBe("/tmp/notrepo");
  });

  it("returns cwd when spawnSync throws", () => {
    mockSpawn(new Error("ENOENT"));
    expect(detectProjectRoot("/tmp/notrepo")).toBe("/tmp/notrepo");
  });

  it("never passes user-controlled arguments to git", () => {
    mockSpawn({ stdout: Buffer.from("/x\n"), status: 0 });
    detectProjectRoot("/anything; rm -rf /");
    const fn = cp.spawnSync as unknown as ReturnType<typeof vi.fn>;
    const call = fn.mock.calls[0];
    expect(call[0]).toBe("git");
    expect(call[1]).toEqual(["rev-parse", "--show-toplevel"]);
  });
});

describe("knownProjectTags", () => {
  it("includes basename, stripped, and length>=3 segments", () => {
    const tags = knownProjectTags("/home/u/rtx-5090-tracker");
    expect(tags).toContain("rtx-5090-tracker");
    expect(tags).toContain("rtx5090tracker");
    expect(tags).toContain("rtx");
    expect(tags).toContain("5090");
    expect(tags).toContain("tracker");
  });

  it("returns empty array for empty path", () => {
    expect(knownProjectTags("")).toEqual([]);
  });

  it("deduplicates overlapping tags", () => {
    const tags = knownProjectTags("/home/u/foo");
    expect(tags.filter(t => t === "foo").length).toBe(1);
  });
});
