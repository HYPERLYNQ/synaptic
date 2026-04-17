/**
 * Integration test that exercises the end-to-end path which the per-task tests
 * all mocked around: PostToolUse writes a checkpoint → that checkpoint carries
 * the session_id from the hook payload → countMeaningfulSessionEvents sees it
 * as a meaningful event for that session.
 *
 * Prior to the C1 fix, saveCheckpoint never populated sessionId, so the Stop
 * hook's gate at countMeaningfulSessionEvents would always return 0 and refuse
 * to write the narrative handoff — breaking the v1.5.0 headline feature.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "syn-int-"));
  process.env.SYNAPTIC_HOME = tmp;
  vi.resetModules();
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.SYNAPTIC_HOME;
});

describe("integration: PostToolUse checkpoint carries session_id", () => {
  it("persists session_id from the hook payload onto the saved checkpoint", async () => {
    const { runPostToolUse } = await import("../../src/hooks/post-tool-use.js");
    const payload = {
      session_id: "integration-sess-1",
      cwd: "/tmp/integ",
      tool_name: "Bash",
      tool_input: { command: 'git commit -m "feat: integration check"' },
      tool_response: { stdout: "[main deadbeef1] feat: integration check\n" },
    };
    const stream = (async function* () { yield Buffer.from(JSON.stringify(payload)); })();
    await runPostToolUse(stream);

    const { ContextIndex } = await import("../../src/storage/sqlite.js");
    const index = new ContextIndex();
    try {
      const checkpoint = index.findCheckpointByName("feat-integration-check");
      expect(checkpoint).not.toBeNull();
      expect(checkpoint!.sessionId).toBe("integration-sess-1");
      expect(checkpoint!.type).toBe("checkpoint");
      expect(checkpoint!.pinned).toBe(true);
    } finally {
      index.close();
    }
  });

  it("countMeaningfulSessionEvents matches the same session_id back", async () => {
    const { runPostToolUse } = await import("../../src/hooks/post-tool-use.js");
    const sessionId = "integration-sess-2";
    const payload = {
      session_id: sessionId,
      cwd: "/tmp/integ",
      tool_name: "Bash",
      tool_input: { command: 'git commit -m "feat: second integration"' },
      tool_response: { stdout: "[main deadbeef2] feat: second integration\n" },
    };
    const stream = (async function* () { yield Buffer.from(JSON.stringify(payload)); })();
    await runPostToolUse(stream);

    const { ContextIndex } = await import("../../src/storage/sqlite.js");
    const { countMeaningfulSessionEvents } = await import("../../src/hooks/lib/session-events.js");
    const index = new ContextIndex();
    try {
      const count = countMeaningfulSessionEvents(index, sessionId);
      expect(count).toBe(1);
    } finally {
      index.close();
    }
  });

  it("UserPromptSubmit checkpoint also carries session_id", async () => {
    const { runUserPromptSubmit } = await import("../../src/hooks/user-prompt-submit.js");
    const sessionId = "integration-sess-3";
    const payload = {
      session_id: sessionId,
      cwd: "/tmp/integ",
      prompt: "/checkpoint phase-one-done",
    };
    const stream = (async function* () { yield Buffer.from(JSON.stringify(payload)); })();
    await runUserPromptSubmit(stream);

    const { ContextIndex } = await import("../../src/storage/sqlite.js");
    const index = new ContextIndex();
    try {
      const checkpoint = index.findCheckpointByName("phase-one-done");
      expect(checkpoint).not.toBeNull();
      expect(checkpoint!.sessionId).toBe(sessionId);
    } finally {
      index.close();
    }
  });
});
