import { describe, it, expect } from "vitest";
import { classifyToolEvent } from "../../src/hooks/lib/tool-events.js";

describe("classifyToolEvent — git commit", () => {
  it("matches a git commit Bash invocation with success", () => {
    const r = classifyToolEvent({
      tool_name: "Bash",
      tool_input: { command: "git commit -m 'feat: add foo'" },
      tool_response: { stdout: "[main abc123] feat: add foo\n 1 file changed", stderr: "" },
    });
    expect(r).not.toBeNull();
    expect(r!.kind).toBe("git-commit");
    expect(r!.summary).toMatch(/feat: add foo/);
    expect(r!.tags).toContain("trigger:git-commit");
  });

  it("does not match a non-commit Bash invocation", () => {
    expect(
      classifyToolEvent({
        tool_name: "Bash",
        tool_input: { command: "git status" },
        tool_response: { stdout: "", stderr: "" },
      })
    ).toBeNull();
  });

  it("does not match a failed git commit", () => {
    expect(
      classifyToolEvent({
        tool_name: "Bash",
        tool_input: { command: "git commit -m 'x'" },
        tool_response: { stdout: "", stderr: "nothing to commit, working tree clean" },
      })
    ).toBeNull();
  });

  it("extracts the real subject from stdout even for heredoc-style commits", () => {
    const r = classifyToolEvent({
      tool_name: "Bash",
      tool_input: {
        command: "git commit -m \"$(echo 'feat: the heredoc payload')\"",
      },
      tool_response: {
        stdout: "[feat/branch def4567] feat: the heredoc payload\n 2 files changed",
        stderr: "",
      },
    });
    expect(r).not.toBeNull();
    expect(r!.summary).toContain("feat: the heredoc payload");
    expect(r!.summary).not.toContain("$(");
    expect(r!.tags).toContain("commit:def4567");
  });

  it("extracts the subject for `git commit -am`", () => {
    const r = classifyToolEvent({
      tool_name: "Bash",
      tool_input: { command: "git commit -am 'fix: combined flag'" },
      tool_response: { stdout: "[main 9abcdef] fix: combined flag\n", stderr: "" },
    });
    expect(r!.summary).toContain("fix: combined flag");
    expect(r!.tags).toContain("commit:9abcdef");
  });
});

describe("classifyToolEvent — plan write", () => {
  it("matches a Write to docs/superpowers/plans/", () => {
    const r = classifyToolEvent({
      tool_name: "Write",
      tool_input: {
        file_path: "/home/user/project/docs/superpowers/plans/2026-04-15-thing.md",
        content: "# Plan",
      },
      tool_response: { type: "create" },
    });
    expect(r).not.toBeNull();
    expect(r!.kind).toBe("plan-write");
    expect(r!.tags).toContain("trigger:plan-write");
  });

  it("does not match a Write to a regular file", () => {
    expect(
      classifyToolEvent({
        tool_name: "Write",
        tool_input: { file_path: "/tmp/note.txt", content: "x" },
        tool_response: { type: "create" },
      })
    ).toBeNull();
  });
});

describe("classifyToolEvent — non-significant tools", () => {
  it("returns null for Read", () => {
    expect(
      classifyToolEvent({
        tool_name: "Read",
        tool_input: { file_path: "/tmp/x" },
        tool_response: { content: "..." },
      })
    ).toBeNull();
  });

  it("returns null for Glob, Grep, etc.", () => {
    expect(
      classifyToolEvent({
        tool_name: "Glob",
        tool_input: { pattern: "*.ts" },
        tool_response: { matches: [] },
      })
    ).toBeNull();
  });
});
