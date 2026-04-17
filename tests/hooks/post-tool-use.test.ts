import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function runWithInput(input: unknown): Promise<void> {
  const { runPostToolUse } = await import("../../src/hooks/post-tool-use.js");
  const str = JSON.stringify(input);
  const stream = (async function* () { yield Buffer.from(str); })();
  await runPostToolUse(stream);
}

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "syn-ptu-"));
  process.env.SYNAPTIC_HOME = tmp;
  vi.resetModules();
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.SYNAPTIC_HOME;
});

describe("runPostToolUse", () => {
  it("saves a checkpoint on a git commit", async () => {
    await runWithInput({
      session_id: "sess-1",
      cwd: "/tmp/proj",
      tool_name: "Bash",
      tool_input: { command: 'git commit -m "feat: add X"' },
      tool_response: { stdout: "[main abc1234] feat: add X\n" },
    });
    const { ContextIndex } = await import("../../src/storage/sqlite.js");
    const index = new ContextIndex();
    try {
      const entries = index.listCheckpoints({});
      expect(entries.length).toBe(1);
      expect(entries[0].name).toBe("feat-add-x");
      expect(entries[0].pinned).toBe(true);
    } finally { index.close(); }
  });

  it("dedupes when the same commit fires twice", async () => {
    const payload = {
      session_id: "sess-1", cwd: "/tmp/proj",
      tool_name: "Bash",
      tool_input: { command: 'git commit -m "feat: add X"' },
      tool_response: { stdout: "[main abc1234] feat: add X\n" },
    };
    await runWithInput(payload);
    await runWithInput(payload);
    const { ContextIndex } = await import("../../src/storage/sqlite.js");
    const index = new ContextIndex();
    try {
      expect(index.listCheckpoints({}).length).toBe(1);
    } finally { index.close(); }
  });

  it("does nothing for unclassifiable tools", async () => {
    await runWithInput({
      session_id: "sess-1", tool_name: "Read",
      tool_input: { file_path: "/x" }, tool_response: {},
    });
    const { ContextIndex } = await import("../../src/storage/sqlite.js");
    const index = new ContextIndex();
    try {
      expect(index.listCheckpoints({}).length).toBe(0);
    } finally { index.close(); }
  });
});
