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
import { detectProject, resetProjectCache } from "../src/storage/project.js";
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

  const decayed = index.decayEphemeral();
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
  // 12. Test BM25 fast path
  // -------------------------------------------------------
  console.log("\n[12] BM25 fast path");

  const bm25Results = index.search("PostgreSQL", { limit: 5 });
  assert(bm25Results.length > 0, `BM25 search returned ${bm25Results.length} result(s)`);
  assert(bm25Results[0].content.includes("PostgreSQL"), `BM25 top result is about PostgreSQL`);

  // -------------------------------------------------------
  // 13. Test v0.5.0 schema migration (project, session_id, agent_id columns)
  // -------------------------------------------------------
  console.log("\n[13] v0.5.0 schema migration");

  const colCheck = (rawDbInst: InstanceType<typeof DatabaseSync>, col: string) => {
    const cols = rawDbInst.prepare("PRAGMA table_info(entries)").all() as Array<{ name: string }>;
    return cols.some(c => c.name === col);
  };

  const rawDb3 = new DatabaseSync(DB_PATH);
  assert(colCheck(rawDb3, "project"), "entries table has 'project' column");
  assert(colCheck(rawDb3, "session_id"), "entries table has 'session_id' column");
  assert(colCheck(rawDb3, "agent_id"), "entries table has 'agent_id' column");

  // Check file_pairs table exists
  const tables = rawDb3.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='file_pairs'").all();
  assert(tables.length === 1, "file_pairs table exists");

  // Check indexes
  const indexes = rawDb3.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as Array<{ name: string }>;
  assert(indexes.some(i => i.name === "idx_entries_project"), "idx_entries_project index exists");
  assert(indexes.some(i => i.name === "idx_entries_session"), "idx_entries_session index exists");
  assert(indexes.some(i => i.name === "idx_file_pairs_lookup"), "idx_file_pairs_lookup index exists");
  rawDb3.close();

  // -------------------------------------------------------
  // 14. Test project auto-detection
  // -------------------------------------------------------
  console.log("\n[14] Project auto-detection");

  resetProjectCache();
  const projectFromGit = detectProject(PROJECT_DIR);
  assert(projectFromGit === "synaptic", `detectProject from git repo = "synaptic" (got "${projectFromGit}")`);

  resetProjectCache();
  const projectFromFolder = detectProject("/tmp/claude/fake-project");
  assert(projectFromFolder === "fake-project", `detectProject from folder name = "fake-project" (got "${projectFromFolder}")`);

  // -------------------------------------------------------
  // 15. Test session ID + auto-tagging on save
  // -------------------------------------------------------
  console.log("\n[15] Session ID + auto-tagging");

  const { getSessionId } = await import("../src/storage/session.js");

  const sid = getSessionId();
  assert(typeof sid === "string" && sid.length > 0, `getSessionId returns a string (got "${sid}")`);
  assert(getSessionId() === sid, `getSessionId returns same value on second call (cached)`);

  // Test that insert with enriched fields stores project/sessionId/agentId
  const enrichTestEntry = makeEntry({ type: "insight", content: "Test auto-tagging enrichment" });
  const enrichedInsert = {
    ...enrichTestEntry,
    project: "test-project",
    sessionId: sid,
    agentId: "test-agent",
  };
  index.insert(enrichedInsert);

  const savedEntries = index.list({ includeArchived: true });
  const enrichedEntry = savedEntries.find(e => e.content === "Test auto-tagging enrichment");
  assert(enrichedEntry !== undefined, `Enriched entry found in DB`);
  assert(enrichedEntry!.sessionId === sid, `Entry has sessionId (got "${enrichedEntry?.sessionId}")`);
  assert(enrichedEntry!.agentId === "test-agent", `Entry has agentId "test-agent" (got "${enrichedEntry?.agentId}")`);
  assert(enrichedEntry!.project === "test-project", `Entry has project "test-project" (got "${enrichedEntry?.project}")`);

  // -------------------------------------------------------
  // 16. Test confidence scoring in search
  // -------------------------------------------------------
  console.log("\n[16] Confidence scoring");

  // Create two entries: one with high access count, one with zero
  index.clearAll();
  const highAccess = makeEntry({ type: "decision", content: "Frequently accessed decision about API design patterns" });
  const lowAccess = makeEntry({ type: "decision", content: "Never accessed decision about API caching strategy" });
  highAccess.accessCount = 10;
  lowAccess.accessCount = 0;

  const haRowid = index.insert(highAccess);
  const laRowid = index.insert(lowAccess);
  const haEmb = await embedder.embed(highAccess.content);
  const laEmb = await embedder.embed(lowAccess.content);
  index.insertVec(haRowid, haEmb);
  index.insertVec(laRowid, laEmb);

  const qEmb = await embedder.embed("API design decision");
  const confResults = index.hybridSearch("API design decision", qEmb, { limit: 10 });
  assert(confResults.length === 2, `Confidence search returned 2 results`);
  assert(
    confResults[0].id === highAccess.id,
    `High-access entry ranked first (got ${confResults[0].id === highAccess.id})`
  );

  // -------------------------------------------------------
  // 17. Test access-aware decay windows
  // -------------------------------------------------------
  console.log("\n[17] Access-aware decay");

  index.clearAll();

  // Entry with 0 accesses, 4 days old — should be archived (new threshold: 3 days)
  const zeroAccess = makeEntry({ type: "progress", content: "Zero access entry", tier: "ephemeral" });
  zeroAccess.accessCount = 0;
  index.insert(zeroAccess);

  // Entry with 5 accesses, 4 days old — should NOT be archived (threshold: 14 days)
  const highAccessEph = makeEntry({ type: "progress", content: "High access ephemeral", tier: "ephemeral" });
  highAccessEph.accessCount = 5;
  index.insert(highAccessEph);

  const rawDb4 = new DatabaseSync(DB_PATH);
  rawDb4.exec(`UPDATE entries SET date = date('now', '-4 days') WHERE id IN ('${zeroAccess.id}', '${highAccessEph.id}')`);
  rawDb4.close();

  const decayedCount = index.decayEphemeral();
  assert(decayedCount >= 1, `Access-aware decay archived ${decayedCount} entry(ies)`);

  const remaining = index.list();
  const zeroStillThere = remaining.find(e => e.id === zeroAccess.id);
  const highStillThere = remaining.find(e => e.id === highAccessEph.id);
  assert(zeroStillThere === undefined, `Zero-access entry archived after 4 days`);
  assert(highStillThere !== undefined, `High-access entry NOT archived after 4 days`);

  // -------------------------------------------------------
  // 18. Test co-change pair generation
  // -------------------------------------------------------
  console.log("\n[18] Co-change pairs");

  index.clearAll();

  // Simulate upsertFilePair
  index.upsertFilePair("test-project", "src/a.ts", "src/b.ts", "2026-02-15");
  index.upsertFilePair("test-project", "src/a.ts", "src/b.ts", "2026-02-15");
  index.upsertFilePair("test-project", "src/a.ts", "src/c.ts", "2026-02-15");

  const cochanges = index.getCoChanges("test-project", "src/a.ts", 10);
  assert(cochanges.length === 2, `getCoChanges returned 2 pairs (got ${cochanges.length})`);
  assert(cochanges[0].file === "src/b.ts" && cochanges[0].count === 2, `First pair is b.ts with count 2`);
  assert(cochanges[1].file === "src/c.ts" && cochanges[1].count === 1, `Second pair is c.ts with count 1`);

  // -------------------------------------------------------
  // 19. Test context_session tool
  // -------------------------------------------------------
  console.log("\n[19] context_session");

  index.clearAll();

  // Insert entries with session_id
  const sessionEntries = [
    makeEntry({ type: "decision", content: "Session decision 1" }),
    makeEntry({ type: "insight", content: "Session insight 1" }),
    makeEntry({ type: "progress", content: "Different session progress" }),
  ];
  index.insert({ ...sessionEntries[0], sessionId: "sess-abc" });
  index.insert({ ...sessionEntries[1], sessionId: "sess-abc" });
  index.insert({ ...sessionEntries[2], sessionId: "sess-xyz" });

  const sessionResults = index.listBySession("sess-abc");
  assert(sessionResults.length === 2, `listBySession returned 2 entries for sess-abc (got ${sessionResults.length})`);
  assert(sessionResults.every(e => e.sessionId === "sess-abc"), `All results have session_id = sess-abc`);

  // -------------------------------------------------------
  // 20. Test template embeddings
  // -------------------------------------------------------
  console.log("\n[20] Template embeddings");

  const templates = await embedder.getDirectiveTemplates();
  assert(templates.length > 0, `Directive templates loaded (got ${templates.length})`);
  assert(templates[0].embedding.length === 384, `Template embedding is 384-dim`);

  const categoryTemplates = await embedder.getCategoryTemplates();
  assert(categoryTemplates.length > 0, `Category templates loaded (got ${categoryTemplates.length})`);

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
