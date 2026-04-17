import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "syn-ss-"));
  process.env.SYNAPTIC_HOME = tmp;
  vi.resetModules();
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.SYNAPTIC_HOME;
});

async function runAndCapture(): Promise<string> {
  const { runSessionStart } = await import("../../src/hooks/session-start.js");
  (process as any).stdin_override = undefined;
  // Simulate stdin with empty JSON
  const stream = (async function* () { yield Buffer.from("{}"); })();
  const chunks: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  (process.stdout as any).write = (s: string) => { chunks.push(s); return true; };
  try {
    // If runSessionStart doesn't accept stdin, it reads from process.stdin by default — we
    // can't easily override, so pass the empty-string path: write empty JSON to stdin if feasible.
    // If runSessionStart accepts an optional stdin argument (Task 8/9/10 pattern), pass `stream`.
    await (runSessionStart as unknown as (s?: AsyncIterable<unknown>) => Promise<void>)(stream);
  } finally {
    (process.stdout as any).write = origWrite;
  }
  return chunks.join("");
}

describe("runSessionStart — smart recall", () => {
  it("excludes handoffs shorter than 100 chars from the panel", async () => {
    const { ContextIndex } = await import("../../src/storage/sqlite.js");
    const { appendEntry } = await import("../../src/storage/markdown.js");
    const index = new ContextIndex();
    try {
      const short = appendEntry("**proj** (3 entries — x:3)", "handoff", []);
      index.insert(short);
      const long = appendEntry("x".repeat(500), "handoff", []);
      index.insert(long);
    } finally { index.close(); }

    const out = await runAndCapture();
    expect(out).not.toContain("3 entries — x:3");
  });

  it("surfaces checkpoints by name when they outrank handoffs", async () => {
    const { ContextIndex } = await import("../../src/storage/sqlite.js");
    const { appendEntry } = await import("../../src/storage/markdown.js");
    const index = new ContextIndex();
    try {
      const c = appendEntry("ckpt body ".repeat(40), "checkpoint", ["rtx"], {
        name: "named-checkpoint", pinned: true,
        projectRoot: "/home/u/rtx-5090-tracker",
      });
      index.insert(c);
    } finally { index.close(); }

    const out = await runAndCapture();
    expect(out).toContain("named-checkpoint");
  });
});
