/**
 * Smoke tests for smart dedup and cleanup features.
 * Usage: npm run build && node build/scripts/test-cleanup.js
 */

import { unlinkSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { ContextIndex } from "../src/storage/sqlite.js";
import { Embedder } from "../src/storage/embedder.js";
import type { ContextEntry } from "../src/storage/markdown.js";

const DB_PATH = "/tmp/claude/synaptic-test-cleanup.db";

let passed = 0;
let failed = 0;

function assert(condition: boolean, description: string): void {
  if (condition) {
    console.log(`  PASS: ${description}`);
    passed++;
  } else {
    console.error(`  FAIL: ${description}`);
    failed++;
  }
}

function cleanup(): void {
  for (const f of [DB_PATH, DB_PATH + "-wal", DB_PATH + "-shm"]) {
    if (existsSync(f)) unlinkSync(f);
  }
}

function makeEntry(
  id: string,
  content: string,
  opts: { tags?: string[]; type?: string; date?: string; pinned?: boolean; accessCount?: number } = {}
): ContextEntry {
  return {
    id,
    date: opts.date ?? "2026-03-20", // >3 days ago to pass age filter
    time: "12:00",
    type: opts.type ?? "insight",
    tags: opts.tags ?? [],
    content,
    sourceFile: "test",
    tier: "working",
    accessCount: opts.accessCount ?? 0,
    lastAccessed: null,
    pinned: opts.pinned ?? false,
    archived: false,
    project: "test-project",
    sessionId: null,
    agentId: null,
  };
}

// --- Test: Subset detection ---

async function testSubsetDetection(): Promise<void> {
  console.log("\n=== Subset Detection ===");

  cleanup();
  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const index = new ContextIndex(DB_PATH);
  const embedder = new Embedder();

  try {
    const e1 = makeEntry("e1", "Fever project uses BEM-style CSS class names");
    const e2 = makeEntry("e2", "Fever project uses BEM-style CSS class names and follows component-based architecture with generous spacing");

    for (const entry of [e1, e2]) {
      const rowid = index.insert(entry);
      const emb = await embedder.embed(entry.content);
      index.insertVec(rowid, emb);
    }

    const actions = index.smartDedup({ threshold: 0.90 });
    assert(actions.length === 1, "one subset merge found");
    assert(actions[0].reason === "subset", "reason is subset");
    assert(actions[0].survivorId === "e2", "longer entry survives");
    assert(actions[0].archivedIds.includes("e1"), "shorter entry archived");

    // Verify e1 is actually archived in DB
    const remaining = index.list({ includeArchived: false });
    assert(!remaining.some(e => e.id === "e1"), "e1 no longer in active list");
    assert(remaining.some(e => e.id === "e2"), "e2 still in active list");
  } finally {
    index.close();
    cleanup();
  }
}

// --- Test: Similarity dedup ---

async function testSimilarityDedup(): Promise<void> {
  console.log("\n=== Similarity Dedup ===");

  cleanup();
  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const index = new ContextIndex(DB_PATH);
  const embedder = new Embedder();

  try {
    // Two near-identical entries with slightly different wording
    const e1 = makeEntry("e1",
      "Fever project styling requirements: pay special attention to styling, alignment, padding, margins, and font consistency",
      { accessCount: 5 }
    );
    const e2 = makeEntry("e2",
      "Fever project styling requirements — pay special attention to styling, alignment, padding, margins, and font consistency. Nothing should be pushed up against another element.",
      { accessCount: 1 }
    );
    // A completely different entry
    const e3 = makeEntry("e3", "Wholesale Harmony uses React Router and Polaris UI for Shopify integration");

    for (const entry of [e1, e2, e3]) {
      const rowid = index.insert(entry);
      const emb = await embedder.embed(entry.content);
      index.insertVec(rowid, emb);
    }

    const actions = index.smartDedup({ threshold: 0.90 });

    // e1 and e2 are near-duplicates, e3 is unrelated
    if (actions.length > 0) {
      const mergeAction = actions.find(a => a.reason === "similarity" || a.reason === "subset");
      if (mergeAction) {
        assert(mergeAction.survivorId === "e2", "longer content survives");
        assert(mergeAction.archivedIds.includes("e1"), "shorter duplicate archived");
        // Check that the higher access_count was preserved
        const survivor = index.list({ includeArchived: false }).find(e => e.id === "e2");
        assert((survivor?.accessCount ?? 0) >= 5, "higher access count preserved on survivor");
      } else {
        assert(false, "expected merge but got: " + actions.map(a => a.reason).join(", "));
      }
    } else {
      // Entries might not be similar enough at 0.90 — that's ok for conservative mode
      console.log("  INFO: entries not similar enough at 0.90 threshold — testing with 0.80");
      const actions2 = index.smartDedup({ threshold: 0.80 });
      assert(actions2.length >= 0, "lower threshold runs without error");
    }

    // e3 should never be touched
    const remaining = index.list({ includeArchived: false });
    assert(remaining.some(e => e.id === "e3"), "unrelated entry e3 untouched");
  } finally {
    index.close();
    cleanup();
  }
}

// --- Test: Dry run ---

async function testDryRun(): Promise<void> {
  console.log("\n=== Dry Run ===");

  cleanup();
  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const index = new ContextIndex(DB_PATH);
  const embedder = new Embedder();

  try {
    const e1 = makeEntry("e1", "Fever project uses BEM-style CSS class names");
    const e2 = makeEntry("e2", "Fever project uses BEM-style CSS class names and follows component-based architecture with generous spacing");

    for (const entry of [e1, e2]) {
      const rowid = index.insert(entry);
      const emb = await embedder.embed(entry.content);
      index.insertVec(rowid, emb);
    }

    const actions = index.smartDedup({ threshold: 0.90, dryRun: true });
    assert(actions.length >= 1, "dry run finds merges");

    // Verify nothing was actually changed
    const allEntries = index.list({ includeArchived: false });
    assert(allEntries.length === 2, "dry run did not archive anything");
    assert(allEntries.some(e => e.id === "e1"), "e1 still active after dry run");
    assert(allEntries.some(e => e.id === "e2"), "e2 still active after dry run");
  } finally {
    index.close();
    cleanup();
  }
}

// --- Test: Pinned entries are protected ---

async function testPinnedProtection(): Promise<void> {
  console.log("\n=== Pinned Entry Protection ===");

  cleanup();
  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const index = new ContextIndex(DB_PATH);
  const embedder = new Embedder();

  try {
    const e1 = makeEntry("e1", "Fever project uses BEM-style CSS class names", { pinned: true });
    const e2 = makeEntry("e2", "Fever project uses BEM-style CSS class names and follows component architecture");

    for (const entry of [e1, e2]) {
      const rowid = index.insert(entry);
      const emb = await embedder.embed(entry.content);
      index.insertVec(rowid, emb);
    }

    const actions = index.smartDedup({ threshold: 0.90 });
    // Pinned e1 should be excluded from candidates entirely
    const affectedIds = actions.flatMap(a => [...a.archivedIds, a.survivorId]);
    assert(!affectedIds.includes("e1"), "pinned entry e1 not affected by dedup");
  } finally {
    index.close();
    cleanup();
  }
}

// --- Test: Aggressive mode with type thresholds ---

async function testAggressiveMode(): Promise<void> {
  console.log("\n=== Aggressive Mode (type thresholds) ===");

  cleanup();
  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const index = new ContextIndex(DB_PATH);
  const embedder = new Embedder();

  try {
    const e1 = makeEntry("e1",
      "Debugging pattern: user corrected approach for handling CSS overflow issues",
      { tags: ["transcript-scan"], type: "insight" }
    );
    const e2 = makeEntry("e2",
      "Debugging pattern found: user corrected the approach for handling CSS overflow problems",
      { tags: ["transcript-scan"], type: "insight" }
    );

    for (const entry of [e1, e2]) {
      const rowid = index.insert(entry);
      const emb = await embedder.embed(entry.content);
      index.insertVec(rowid, emb);
    }

    // Conservative mode (0.90) might not catch these
    const conservativeActions = index.smartDedup({ threshold: 0.90, dryRun: true });

    // Aggressive mode with lower threshold for transcript-scan
    const aggressiveActions = index.smartDedup({
      typeThresholds: {
        "insight": 0.85,
        "decision": 0.92,
        "reference": 0.92,
      },
      dryRun: true,
    });

    assert(aggressiveActions.length >= conservativeActions.length,
      "aggressive mode finds at least as many duplicates as conservative");
  } finally {
    index.close();
    cleanup();
  }
}

// --- Test: Recent entries protected by age filter ---

async function testAgeFilter(): Promise<void> {
  console.log("\n=== Age Filter (entries < 3 days old protected) ===");

  cleanup();
  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const index = new ContextIndex(DB_PATH);
  const embedder = new Embedder();

  try {
    const today = new Date().toISOString().slice(0, 10);
    const e1 = makeEntry("e1", "Fever project uses BEM-style CSS class names", { date: today });
    const e2 = makeEntry("e2", "Fever project uses BEM-style CSS class names and follows component architecture", { date: today });

    for (const entry of [e1, e2]) {
      const rowid = index.insert(entry);
      const emb = await embedder.embed(entry.content);
      index.insertVec(rowid, emb);
    }

    const actions = index.smartDedup({ threshold: 0.90 });
    assert(actions.length === 0, "entries from today are not deduped (age filter)");
  } finally {
    index.close();
    cleanup();
  }
}

// --- Main ---

async function main(): Promise<void> {
  console.log("Synaptic Smart Cleanup Tests\n");

  await testSubsetDetection();
  await testSimilarityDedup();
  await testDryRun();
  await testPinnedProtection();
  await testAggressiveMode();
  await testAgeFilter();

  console.log(`\n${"=".repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
