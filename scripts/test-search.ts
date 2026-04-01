/**
 * Tests for query expansion utilities and (placeholder) multi-pass search.
 *
 * Usage: npm run build && node build/scripts/test-search.js
 */

import { unlinkSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expandQuery, conceptToFts5, fuzzyDeletions, STOP_WORDS } from "../src/storage/search-utils.js";
import { ContextIndex } from "../src/storage/sqlite.js";
import { Embedder } from "../src/storage/embedder.js";
import type { ContextEntry } from "../src/storage/markdown.js";

const DB_PATH = "/tmp/claude/synaptic-search-test.db";

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
  try {
    if (existsSync(DB_PATH)) unlinkSync(DB_PATH);
    if (existsSync(DB_PATH + "-wal")) unlinkSync(DB_PATH + "-wal");
    if (existsSync(DB_PATH + "-shm")) unlinkSync(DB_PATH + "-shm");
  } catch {
    // best effort
  }
}

function makeEntry(overrides: Partial<ContextEntry> & { type: string; content: string }): ContextEntry {
  const id = overrides.id ?? (Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
  const date = overrides.date ?? new Date().toISOString().slice(0, 10);
  const time = overrides.time ?? new Date().toTimeString().slice(0, 5);
  return {
    id,
    date,
    time,
    type: overrides.type,
    tags: overrides.tags ?? ["test"],
    content: overrides.content,
    sourceFile: overrides.sourceFile ?? "test-search",
    tier: overrides.tier ?? ContextIndex.assignTier(overrides.type),
    accessCount: overrides.accessCount ?? 0,
    lastAccessed: overrides.lastAccessed ?? null,
    pinned: overrides.pinned ?? false,
    archived: overrides.archived ?? false,
  };
}

// -------------------------------------------------------
// 1. expandQuery tests
// -------------------------------------------------------
function testExpandQuery(): void {
  console.log("[1] expandQuery — basic expansion");

  const result = expandQuery("fever project styling");
  assert(result.length === 3, `3 concepts returned (got ${result.length})`);
  assert(result[0].original === "fever", `First concept is "fever" (got "${result[0]?.original}")`);
  assert(result[1].original === "project", `Second concept is "project" (got "${result[1]?.original}")`);
  assert(result[2].original === "styling", `Third concept is "styling" (got "${result[2]?.original}")`);

  // Each 5+ char term should have fuzzy deletions
  assert(result[0].variations.length > 0, `"fever" has fuzzy deletions (got ${result[0].variations.length})`);
  assert(result[1].variations.length > 0, `"project" has fuzzy deletions (got ${result[1].variations.length})`);
  assert(result[2].variations.length > 0, `"styling" has fuzzy deletions (got ${result[2].variations.length})`);

  // Verify deletion length: each variant is original.length - 1
  for (const v of result[0].variations) {
    assert(v.length === result[0].original.length - 1,
      `Deletion variant "${v}" has length ${result[0].original.length - 1}`);
  }
}

// -------------------------------------------------------
// 2. Stop word filtering
// -------------------------------------------------------
function testStopWords(): void {
  console.log("\n[2] expandQuery — stop word filtering");

  const result = expandQuery("the fever in this project");
  const originals = result.map(c => c.original);
  assert(result.length === 2, `2 concepts after filtering (got ${result.length})`);
  assert(originals.includes("fever"), `"fever" kept`);
  assert(originals.includes("project"), `"project" kept`);
  assert(!originals.includes("the"), `"the" filtered`);
  assert(!originals.includes("in"), `"in" filtered`);
  assert(!originals.includes("this"), `"this" filtered`);
}

// -------------------------------------------------------
// 3. Short words skip fuzzy
// -------------------------------------------------------
function testShortWords(): void {
  console.log("\n[3] expandQuery — short words skip fuzzy");

  const result = expandQuery("fix css");
  assert(result.length === 2, `2 concepts returned (got ${result.length})`);

  const fix = result.find(c => c.original === "fix");
  const css = result.find(c => c.original === "css");

  assert(fix !== undefined, `"fix" concept exists`);
  assert(fix!.variations.length === 0, `"fix" (3 chars) has no fuzzy deletions (got ${fix!.variations.length})`);
  assert(css !== undefined, `"css" concept exists`);
  assert(css!.variations.length === 0, `"css" (3 chars) has no fuzzy deletions (got ${css!.variations.length})`);
}

// -------------------------------------------------------
// 4. Empty / all stop words
// -------------------------------------------------------
function testEmpty(): void {
  console.log("\n[4] expandQuery — empty and all-stop-words");

  assert(expandQuery("").length === 0, `Empty string → empty array`);
  assert(expandQuery("   ").length === 0, `Whitespace → empty array`);
  assert(expandQuery("the and or but").length === 0, `All stop words → empty array`);
}

// -------------------------------------------------------
// 5. Special characters stripped
// -------------------------------------------------------
function testSpecialChars(): void {
  console.log("\n[5] expandQuery — special characters stripped");

  const result = expandQuery("fever's project! @styling #stuff");
  const originals = result.map(c => c.original);
  assert(originals.includes("fever"), `Possessive apostrophe stripped, "fever" kept (got: ${originals})`);
  assert(originals.includes("project"), `Exclamation stripped, "project" kept`);
  assert(originals.includes("styling"), `@ stripped, "styling" kept`);
  assert(originals.includes("stuff"), `# stripped, "stuff" kept`);
  // s from fever's becomes its own short token — verify it's either filtered or present
  // (it should appear since 's' is a 1-char token that gets filtered by the length > 0 check but not by stop words)
  // Actually "s" has length 1, passes the length > 0 filter, but is not a stop word — it will be present.
  // That's fine — it will have no fuzzy deletions and won't affect search much.
}

// -------------------------------------------------------
// 6. conceptToFts5
// -------------------------------------------------------
function testConceptToFts5(): void {
  console.log("\n[6] conceptToFts5 — FTS5 MATCH expression");

  const concept = expandQuery("fever")[0];
  const fts5 = conceptToFts5(concept);

  assert(fts5.startsWith('"fever"'), `Starts with quoted original term`);
  assert(fts5.includes(" OR "), `Contains OR operator`);

  // All deletions should appear quoted
  for (const v of concept.variations) {
    assert(fts5.includes(`"${v}"`), `Contains quoted variant "${v}"`);
  }
}

// -------------------------------------------------------
// 7. Short word conceptToFts5
// -------------------------------------------------------
function testShortConceptToFts5(): void {
  console.log("\n[7] conceptToFts5 — short word (no OR)");

  const concept = expandQuery("fix")[0];
  const fts5 = conceptToFts5(concept);

  assert(fts5 === '"fix"', `Short word produces single quoted term (got "${fts5}")`);
  assert(!fts5.includes(" OR "), `No OR for short words`);
}

// -------------------------------------------------------
// 8. fuzzyDeletions edge cases
// -------------------------------------------------------
function testFuzzyDeletions(): void {
  console.log("\n[8] fuzzyDeletions — edge cases");

  assert(fuzzyDeletions("abc").length === 0, `3-char term → no deletions`);
  assert(fuzzyDeletions("ab").length === 0, `2-char term → no deletions`);
  assert(fuzzyDeletions("a").length === 0, `1-char term → no deletions`);
  assert(fuzzyDeletions("").length === 0, `Empty term → no deletions`);

  const abcd = fuzzyDeletions("abcd");
  assert(abcd.length === 4, `"abcd" → 4 deletions (got ${abcd.length})`);
  assert(abcd.includes("bcd"), `Contains "bcd"`);
  assert(abcd.includes("acd"), `Contains "acd"`);
  assert(abcd.includes("abd"), `Contains "abd"`);
  assert(abcd.includes("abc"), `Contains "abc"`);

  // Duplicate character: "aaab" should deduplicate
  const aaab = fuzzyDeletions("aaab");
  assert(aaab.includes("aab"), `"aaab" deletions include "aab"`);
  // "aab" appears from deleting position 0, 1, or 2 — but deduplication means only 1 copy
  const aabCount = aaab.filter(v => v === "aab").length;
  assert(aabCount === 1, `"aab" appears exactly once (deduplication works)`);
}

// -------------------------------------------------------
// 9. Multi-pass search placeholder (expected to FAIL until Task 2)
// -------------------------------------------------------
async function testMultiPassSearch(): Promise<void> {
  console.log("\n[9] Multi-pass search (placeholder — expected to FAIL until Task 2)");

  mkdirSync(dirname(DB_PATH), { recursive: true });
  cleanup();

  let index: ContextIndex | null = null;

  try {
    index = new ContextIndex(DB_PATH);
    const embedder = new Embedder();

    // Insert test entries with varied wording
    const entries = [
      makeEntry({ type: "insight", content: "fever project styling — dark theme with orange accent colors" }),
      makeEntry({ type: "issue", content: "fever CSS spacing is off, padding needs adjustment" }),
      makeEntry({ type: "reference", content: "wholesale harmony — Shopify app for B2B pricing" }),
      makeEntry({ type: "reference", content: "field bridge — Electron DAW app for Teenage Engineering" }),
      makeEntry({ type: "insight", content: "fever color palette uses #ff6b00 as primary accent" }),
    ];

    for (const entry of entries) {
      const rowid = index.insert(entry);
      const emb = await embedder.embed(entry.content);
      index.insertVec(rowid, emb);
    }

    // Test 1: Search for "fever styling" — fever entries should rank higher
    const queryEmb1 = await embedder.embed("fever styling");
    const results1 = index.hybridSearch("fever styling", queryEmb1, { limit: 5 });

    assert(results1.length > 0, `"fever styling" returns results (got ${results1.length})`);
    // Top 2 results should be fever-related
    const top2Fever = results1.slice(0, 2).every(r =>
      r.content.toLowerCase().includes("fever")
    );
    assert(top2Fever, `Top 2 results for "fever styling" are fever-related`);

    // Test 2: Search with typo "fevr project" — fever entries should still be found
    // This requires multi-pass concept search (Task 2) to expand "fevr" to match "fever"
    const queryEmb2 = await embedder.embed("fevr project");
    const results2 = index.hybridSearch("fevr project", queryEmb2, { limit: 5 });

    const feverFound = results2.some(r =>
      r.content.toLowerCase().includes("fever")
    );
    assert(feverFound, `Typo "fevr project" still finds fever entries (multi-pass expansion)`);

  } finally {
    if (index) index.close();
    cleanup();
  }
}

// -------------------------------------------------------
// Main
// -------------------------------------------------------
async function main(): Promise<void> {
  console.log("Search Utilities Tests");
  console.log("======================\n");

  // Pure function tests (no DB needed)
  testExpandQuery();
  testStopWords();
  testShortWords();
  testEmpty();
  testSpecialChars();
  testConceptToFts5();
  testShortConceptToFts5();
  testFuzzyDeletions();

  // Integration test (needs DB + embedder)
  await testMultiPassSearch();

  // Summary
  console.log("\n======================");
  console.log(`Results: ${passed} passed, ${failed} failed out of ${passed + failed} total`);

  if (failed > 0) {
    console.log("\nNote: Multi-pass search test failures are EXPECTED until Task 2 is implemented.");
  }

  console.log("\nDone.");
}

main().catch((err) => {
  console.error("Test crashed:", err);
  cleanup();
  process.exit(1);
});
