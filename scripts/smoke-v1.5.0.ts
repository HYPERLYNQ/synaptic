#!/usr/bin/env node
/**
 * Synaptic v1.5.0 end-to-end smoke test.
 * Runs against a throwaway DB in a tmp dir.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function main() {
  const tmp = mkdtempSync(join(tmpdir(), "syn-smoke-"));
  process.env.SYNAPTIC_HOME = tmp;
  let passed = 0, failed = 0;

  function assert(cond: boolean, msg: string) {
    if (cond) { console.log("  ✓ " + msg); passed++; }
    else      { console.log("  ✗ " + msg); failed++; }
  }

  try {
    const { saveCheckpoint } = await import("../src/hooks/lib/save-checkpoint.js");
    const { ContextIndex }   = await import("../src/storage/sqlite.js");

    console.log("1. Auto-checkpoint a commit");
    await saveCheckpoint({
      name: "smoke-commit-1",
      summary: "smoke test commit",
      content: "Full narrative of the commit event here for smoke test assertions.",
      tags: ["trigger:git-commit"],
      projectRoot: "/tmp/smoke-proj",
    });

    const index = new ContextIndex();
    try {
      const c = index.findCheckpointByName("smoke-commit-1");
      assert(c !== null, "checkpoint persisted by name");
      assert(c?.pinned === true, "checkpoint is pinned by default");
      assert(c?.projectRoot === "/tmp/smoke-proj", "projectRoot recorded");

      console.log("2. Dedupe on second save");
      const dup = await saveCheckpoint({
        name: "smoke-commit-1", content: "x", tags: [], projectRoot: "/tmp/smoke-proj",
      });
      assert(dup.deduped === true, "same-name second save deduped");

      console.log("3. Ranking with smart scoring");
      const { rankEntries } = await import("../src/lib/scoring.js");
      const cand = index.listCheckpoints({}).map(e => ({
        id: e.id, content: e.content, projectRoot: e.projectRoot ?? null,
        tags: e.tags, pinned: !!e.pinned,
        createdAtMs: new Date(e.date + "T" + e.time + ":00").getTime(),
      }));
      const ranked = rankEntries(cand, "/tmp/smoke-proj");
      assert(ranked[0].id === c!.id, "smoke checkpoint ranks first for its project");
    } finally { index.close(); }

    console.log(`\nResult: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    delete process.env.SYNAPTIC_HOME;
  }
}

main().catch(err => { console.error(err); process.exit(1); });
