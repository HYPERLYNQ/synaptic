/**
 * Smoke test for Synaptic MCP server Phase 3 features.
 * Exercises ContextIndex, Embedder, git parser, maintenance, and pattern detection
 * against a temporary database.
 *
 * Usage: npm run smoke-test
 */

import { unlinkSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { ContextIndex } from "../src/storage/sqlite.js";
import { Embedder } from "../src/storage/embedder.js";
import { getGitLog, formatCommitAsContent } from "../src/storage/git.js";
import type { ContextEntry } from "../src/storage/markdown.js";

const DB_PATH = "/tmp/claude/synaptic-smoke-test.db";
const PROJECT_DIR = "/home/hyperlynq/projects/Coding/claude-context-tool";

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
    // SQLite WAL/SHM files
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
    tags: overrides.tags ?? ["smoke-test"],
    content: overrides.content,
    sourceFile: overrides.sourceFile ?? "smoke-test",
    tier: overrides.tier ?? ContextIndex.assignTier(overrides.type),
    accessCount: overrides.accessCount ?? 0,
    lastAccessed: overrides.lastAccessed ?? null,
    pinned: overrides.pinned ?? false,
    archived: overrides.archived ?? false,
  };
}

async function main(): Promise<void> {
  console.log("Synaptic Phase 3 Smoke Test");
  console.log("===========================\n");

  // Ensure temp directory exists and clean up any leftover DB from previous run
  mkdirSync(dirname(DB_PATH), { recursive: true });
  cleanup();

  const index = new ContextIndex(DB_PATH);
  const embedder = new Embedder();

  // -------------------------------------------------------
  // 1. Test tier assignment
  // -------------------------------------------------------
  console.log("[1] Tier assignment");

  const tierCases: Array<{ type: string; expected: string }> = [
    { type: "handoff", expected: "ephemeral" },
    { type: "progress", expected: "ephemeral" },
    { type: "reference", expected: "longterm" },
    { type: "issue", expected: "working" },
    { type: "decision", expected: "working" },
    { type: "insight", expected: "working" },
    { type: "git_commit", expected: "working" },
  ];

  for (const tc of tierCases) {
    const tier = ContextIndex.assignTier(tc.type);
    assert(tier === tc.expected, `${tc.type} -> ${tc.expected} (got ${tier})`);
  }

  // Insert entries and verify tier persists in DB
  const tierEntries: ContextEntry[] = [];
  for (const tc of tierCases) {
    const entry = makeEntry({ type: tc.type, content: `Tier test entry for ${tc.type}` });
    index.insert(entry);
    tierEntries.push(entry);
  }

  const listed = index.list({ includeArchived: true });
  for (const tc of tierCases) {
    const found = listed.find(e => e.content === `Tier test entry for ${tc.type}`);
    assert(
      found !== undefined && found.tier === tc.expected,
      `DB tier for ${tc.type} is ${tc.expected} (got ${found?.tier})`
    );
  }

  // Clear for next tests
  index.clearAll();

  // -------------------------------------------------------
  // 2. Test insert + hybrid search
  // -------------------------------------------------------
  console.log("\n[2] Insert + hybrid search");

  const searchEntries = [
    makeEntry({ type: "decision", content: "We decided to use PostgreSQL for the main database because of its JSON support" }),
    makeEntry({ type: "issue", content: "Authentication tokens expire too quickly causing user session drops" }),
    makeEntry({ type: "insight", content: "React server components reduce bundle size by 40 percent on our landing page" }),
  ];

  const rowids: number[] = [];
  for (const entry of searchEntries) {
    const rowid = index.insert(entry);
    const emb = await embedder.embed(entry.content);
    index.insertVec(rowid, emb);
    rowids.push(rowid);
  }

  assert(rowids.length === 3, `Inserted 3 entries (rowids: ${rowids.join(", ")})`);

  const queryEmb = await embedder.embed("database decision PostgreSQL");
  const searchResults = index.hybridSearch("database PostgreSQL", queryEmb, { limit: 10 });

  assert(searchResults.length > 0, `Hybrid search returned ${searchResults.length} result(s)`);
  assert(
    searchResults[0].content.includes("PostgreSQL"),
    `Top result is about PostgreSQL`
  );
  assert(searchResults[0].tier !== undefined, `Search results have tier field (tier=${searchResults[0].tier})`);

  // -------------------------------------------------------
  // 3. Test access tracking
  // -------------------------------------------------------
  console.log("\n[3] Access tracking");

  // hybridSearch calls bumpAccess internally, so the entries returned should have been bumped
  const afterSearch = index.list();
  const bumpedEntry = afterSearch.find(e => e.id === searchResults[0].id);
  assert(
    bumpedEntry !== undefined && (bumpedEntry.accessCount ?? 0) >= 1,
    `access_count incremented after search (count=${bumpedEntry?.accessCount})`
  );

  // -------------------------------------------------------
  // 4. Test archive
  // -------------------------------------------------------
  console.log("\n[4] Archive");

  const archiveTarget = searchEntries[2]; // the insight entry
  const archiveCount = index.archiveEntries([archiveTarget.id]);
  assert(archiveCount === 1, `Archived 1 entry`);

  const defaultList = index.list();
  const archivedInDefault = defaultList.find(e => e.id === archiveTarget.id);
  assert(archivedInDefault === undefined, `Archived entry not in default list`);

  const fullList = index.list({ includeArchived: true });
  const archivedInFull = fullList.find(e => e.id === archiveTarget.id);
  assert(archivedInFull !== undefined && archivedInFull.archived === true, `Archived entry appears with includeArchived: true`);

  // -------------------------------------------------------
  // 5. Test decay and promotion
  // -------------------------------------------------------
  console.log("\n[5] Decay / promotion");

  // 5a. Decay ephemeral
  const oldEphemeral = makeEntry({
    type: "progress",
    content: "Old ephemeral progress entry that should be decayed",
    tier: "ephemeral",
  });
  index.insert(oldEphemeral);

  // Manually backdate it via raw SQL through a helper
  // We need direct DB access -- use a small trick: insert, then update via the index's internal methods
  // Since ContextIndex doesn't expose raw exec, we create a second connection
  const { DatabaseSync } = await import("node:sqlite");
  const rawDb = new DatabaseSync(DB_PATH);
  rawDb.exec(`UPDATE entries SET date = date('now', '-10 days') WHERE id = '${oldEphemeral.id}'`);
  rawDb.close();

  const decayed = index.decayEphemeral(7);
  assert(decayed >= 1, `decayEphemeral archived ${decayed} old ephemeral entry(ies)`);

  const afterDecay = index.list();
  const decayedEntry = afterDecay.find(e => e.id === oldEphemeral.id);
  assert(decayedEntry === undefined, `Decayed entry no longer in default list`);

  // 5b. Promote stable (decision older than 7 days -> longterm)
  const oldDecision = makeEntry({
    type: "decision",
    content: "Important architectural decision about caching strategy that should be promoted",
    tier: "working",
  });
  index.insert(oldDecision);

  const rawDb2 = new DatabaseSync(DB_PATH);
  rawDb2.exec(`UPDATE entries SET date = date('now', '-10 days') WHERE id = '${oldDecision.id}'`);
  rawDb2.close();

  const promoted = index.promoteStable();
  assert(promoted >= 1, `promoteStable promoted ${promoted} decision(s) to longterm`);

  const afterPromotion = index.list({ includeArchived: true });
  const promotedEntry = afterPromotion.find(e => e.id === oldDecision.id);
  assert(
    promotedEntry !== undefined && promotedEntry.tier === "longterm",
    `Decision entry promoted to longterm (tier=${promotedEntry?.tier})`
  );

  // -------------------------------------------------------
  // 6. Test pattern detection
  // -------------------------------------------------------
  console.log("\n[6] Pattern detection");

  // Insert 3 similar issue entries about the same topic
  const issueContent = [
    "Memory leak in the WebSocket connection handler causing OOM after 24 hours",
    "Memory leak in WebSocket handler leads to server out of memory crash",
    "WebSocket connection memory leak causes out-of-memory on production server",
  ];

  const issueEntries: ContextEntry[] = [];
  const issueEmbedding = await embedder.embed("memory leak WebSocket connection handler OOM");

  for (const content of issueContent) {
    const entry = makeEntry({ type: "issue", content });
    const rowid = index.insert(entry);
    // Use the same embedding for all 3 to guarantee high similarity
    index.insertVec(rowid, issueEmbedding);
    issueEntries.push(entry);
  }

  // findSimilarIssues
  const similar = index.findSimilarIssues(issueEmbedding, 30, 0.5);
  assert(similar.length >= 3, `findSimilarIssues found ${similar.length} similar issue(s) (expected >= 3)`);

  // createOrUpdatePattern
  const issueIds = issueEntries.map(e => e.id);
  const patternId = index.createOrUpdatePattern("Memory leak in WebSocket handler", issueIds);
  assert(typeof patternId === "string" && patternId.length > 0, `Pattern created with id: ${patternId}`);

  // getActivePatterns (occurrence_count >= 3)
  const activePatterns = index.getActivePatterns();
  assert(
    activePatterns.length >= 1 && activePatterns.some(p => p.id === patternId),
    `getActivePatterns returns the pattern (found ${activePatterns.length} active pattern(s))`
  );

  // resolvePattern
  const resolved = index.resolvePattern(patternId);
  assert(resolved === true, `resolvePattern returned true`);

  const afterResolve = index.getActivePatterns();
  assert(
    !afterResolve.some(p => p.id === patternId),
    `Resolved pattern no longer in active patterns`
  );

  // -------------------------------------------------------
  // 7. Test consolidation candidates
  // -------------------------------------------------------
  console.log("\n[7] Consolidation candidates");

  // The 3 issue entries above should form a consolidation group
  // findConsolidationCandidates looks at issue/decision entries from last 30 days
  const groups = index.findConsolidationCandidates(0.75);
  assert(groups.length >= 1, `findConsolidationCandidates returned ${groups.length} group(s)`);
  if (groups.length > 0) {
    assert(
      groups[0].entries.length >= 3,
      `First group has ${groups[0].entries.length} entries (expected >= 3)`
    );
  }

  // -------------------------------------------------------
  // 8. Test git parser
  // -------------------------------------------------------
  console.log("\n[8] Git parser");

  const commits = getGitLog(PROJECT_DIR, { days: 90 });
  assert(commits.length > 0, `getGitLog returned ${commits.length} commit(s)`);

  if (commits.length > 0) {
    const commit = commits[0];
    assert(typeof commit.sha === "string" && commit.sha.length > 0, `Commit has sha`);
    assert(typeof commit.message === "string" && commit.message.length > 0, `Commit has message`);
    assert(typeof commit.author === "string" && commit.author.length > 0, `Commit has author`);
    assert(typeof commit.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(commit.date), `Commit has valid date (${commit.date})`);
    assert(typeof commit.branch === "string" && commit.branch.length > 0, `Commit has branch (${commit.branch})`);
    assert(Array.isArray(commit.files), `Commit has files array`);

    const formatted = formatCommitAsContent(commit);
    assert(formatted.includes(commit.message), `formatCommitAsContent includes commit message`);
    assert(formatted.startsWith(`[${commit.branch}]`), `formatCommitAsContent starts with branch`);
  }

  // -------------------------------------------------------
  // 9. Test status
  // -------------------------------------------------------
  console.log("\n[9] Status");

  const status = index.status();
  assert(typeof status.totalEntries === "number" && status.totalEntries > 0, `status.totalEntries = ${status.totalEntries}`);
  assert(status.tierDistribution !== undefined && typeof status.tierDistribution === "object", `status.tierDistribution exists`);
  assert(typeof status.activePatterns === "number", `status.activePatterns = ${status.activePatterns}`);
  assert(typeof status.archivedCount === "number" && status.archivedCount > 0, `status.archivedCount = ${status.archivedCount}`);
  assert(status.dateRange !== null, `status.dateRange is not null`);

  // -------------------------------------------------------
  // 10. Test rule CRUD
  // -------------------------------------------------------
  console.log("\n[10] Rule CRUD");

  const ruleRowid = index.saveRule("no-emoji", "Never use emoji in commit messages");
  assert(typeof ruleRowid === "number" && ruleRowid > 0, `saveRule returned rowid ${ruleRowid}`);

  const rules = index.listRules();
  assert(rules.length === 1, `listRules returns 1 rule (got ${rules.length})`);
  assert(rules[0].label === "no-emoji", `Rule label is no-emoji`);
  assert(rules[0].content.includes("emoji"), `Rule content mentions emoji`);
  assert(rules[0].tier === "longterm", `Rule tier is longterm`);
  assert(rules[0].pinned === true, `Rule is pinned`);

  // saveRule with same label overwrites (upsert)
  index.saveRule("no-emoji", "Do not include emoji in any commit messages ever");
  const rulesAfterUpdate = index.listRules();
  assert(rulesAfterUpdate.length === 1, `Still 1 rule after upsert (got ${rulesAfterUpdate.length})`);
  assert(rulesAfterUpdate[0].content.includes("Do not include"), `Rule content was updated`);

  // deleteRule removes it
  const deleted = index.deleteRule("no-emoji");
  assert(deleted === true, `deleteRule returned true`);
  const rulesAfterDelete = index.listRules();
  assert(rulesAfterDelete.length === 0, `0 rules after delete (got ${rulesAfterDelete.length})`);

  // deleteRule on non-existent returns false
  const deletedAgain = index.deleteRule("no-emoji");
  assert(deletedAgain === false, `deleteRule on missing rule returns false`);

  // -------------------------------------------------------
  // 11. Test embedder cache
  // -------------------------------------------------------
  console.log("\n[11] Embedder cache");

  const t0 = performance.now();
  const emb1 = await embedder.embed("test cache query");
  const t1 = performance.now();
  const emb2 = await embedder.embed("test cache query");
  const t2 = performance.now();

  assert(emb1.length === 384, `Embedding has 384 dims`);
  const firstMs = t1 - t0;
  const secondMs = t2 - t1;
  assert(secondMs < firstMs, `Cached embed is faster (${secondMs.toFixed(1)}ms vs ${firstMs.toFixed(1)}ms)`);
  assert(secondMs < 5, `Cached embed is under 5ms (got ${secondMs.toFixed(1)}ms)`);

  // -------------------------------------------------------
  // Summary
  // -------------------------------------------------------
  index.close();
  cleanup();

  console.log("\n===========================");
  console.log(`Results: ${passed} passed, ${failed} failed out of ${passed + failed} total`);

  if (failed > 0) {
    process.exit(1);
  } else {
    console.log("\nAll smoke tests passed.");
  }
}

main().catch((err) => {
  console.error("Smoke test crashed:", err);
  cleanup();
  process.exit(1);
});
