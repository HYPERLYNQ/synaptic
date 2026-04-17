import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function runWithInput(input: unknown): Promise<void> {
  const { runUserPromptSubmit } = await import("../../src/hooks/user-prompt-submit.js");
  const str = JSON.stringify(input);
  const stream = (async function* () { yield Buffer.from(str); })();
  await runUserPromptSubmit(stream);
}

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "syn-ups-"));
  process.env.SYNAPTIC_HOME = tmp;
  vi.resetModules();
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.SYNAPTIC_HOME;
});

describe("runUserPromptSubmit", () => {
  it("saves a checkpoint when prompt contains 'save progress'", async () => {
    await runWithInput({
      session_id: "s1", cwd: "/tmp/p", prompt: "save progress please",
    });
    const { ContextIndex } = await import("../../src/storage/sqlite.js");
    const index = new ContextIndex();
    try {
      expect(index.listCheckpoints({}).length).toBe(1);
    } finally { index.close(); }
  });

  it("uses the explicit name after /checkpoint", async () => {
    await runWithInput({
      session_id: "s1", cwd: "/tmp/p", prompt: "/checkpoint phase-5-start",
    });
    const { ContextIndex } = await import("../../src/storage/sqlite.js");
    const index = new ContextIndex();
    try {
      const e = index.findCheckpointByName("phase-5-start");
      expect(e).not.toBeNull();
    } finally { index.close(); }
  });

  it("does nothing when no save-intent phrase matches", async () => {
    await runWithInput({
      session_id: "s1", cwd: "/tmp/p", prompt: "tell me about frogs",
    });
    const { ContextIndex } = await import("../../src/storage/sqlite.js");
    const index = new ContextIndex();
    try {
      expect(index.listCheckpoints({}).length).toBe(0);
    } finally { index.close(); }
  });
});
