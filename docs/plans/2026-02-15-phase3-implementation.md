# Phase 3: Memory Intelligence Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add memory intelligence to Synaptic — 3-tier hierarchy, auto-decay/consolidation, git commit indexing, and error pattern detection.

**Architecture:** Foundation-first. Tiers are the structural backbone (3a), git commits become a new tiered entry type (3b), patterns are an analysis layer on issues (3c). Each sub-phase builds on the last.

**Tech Stack:** TypeScript, node:sqlite (DatabaseSync), sqlite-vec, Transformers.js, node:child_process (git), node:test (testing)

---

## Sub-phase 3a: Tiers + Decay + Consolidation

### Task 1: Schema migration + type updates

**Files:**
- Modify: `src/storage/sqlite.ts` (add columns, patterns table)
- Modify: `src/storage/markdown.ts` (extend ContextEntry interface)
- Modify: `src/tools/context-save.ts` (extend type enum)
- Modify: `src/tools/context-search.ts` (extend type enum)
- Modify: `src/tools/context-list.ts` (extend type enum)

**Step 1: Extend ContextEntry interface in `src/storage/markdown.ts`**

Add tier fields to the ContextEntry interface:

```typescript
export interface ContextEntry {
  id: string;
  date: string;
  time: string;
  type: string;
  tags: string[];
  content: string;
  sourceFile: string;
  // Phase 3 fields (optional for backward compat)
  tier?: "ephemeral" | "working" | "longterm";
  accessCount?: number;
  lastAccessed?: string | null;
  pinned?: boolean;
  archived?: boolean;
}
```

**Step 2: Add migration logic to `src/storage/sqlite.ts` init()**

After existing table creation in `init()`, add migration for new columns. Use a helper that checks if a column exists before adding:

```typescript
private migrate(): void {
  // Check if tier column exists
  const cols = this.db.prepare("PRAGMA table_info(entries)").all() as Array<{ name: string }>;
  const colNames = new Set(cols.map(c => c.name));

  if (!colNames.has("tier")) {
    this.db.exec("ALTER TABLE entries ADD COLUMN tier TEXT DEFAULT 'working'");
    this.db.exec("ALTER TABLE entries ADD COLUMN access_count INTEGER DEFAULT 0");
    this.db.exec("ALTER TABLE entries ADD COLUMN last_accessed TEXT");
    this.db.exec("ALTER TABLE entries ADD COLUMN pinned INTEGER DEFAULT 0");
    this.db.exec("ALTER TABLE entries ADD COLUMN archived INTEGER DEFAULT 0");

    // Backfill tiers by type
    this.db.exec("UPDATE entries SET tier = 'ephemeral' WHERE type IN ('handoff', 'progress')");
    this.db.exec("UPDATE entries SET tier = 'longterm' WHERE type = 'reference'");
    // 'working' is default, covers decision/issue/insight
  }

  // Patterns table (for 3c, create now to avoid second migration)
  this.db.exec(`
    CREATE TABLE IF NOT EXISTS patterns (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      entry_ids TEXT NOT NULL,
      occurrence_count INTEGER NOT NULL DEFAULT 0,
      first_seen TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      resolved INTEGER DEFAULT 0
    )
  `);

  // Index for tier + archived queries
  this.db.exec("CREATE INDEX IF NOT EXISTS idx_entries_tier ON entries(tier)");
  this.db.exec("CREATE INDEX IF NOT EXISTS idx_entries_archived ON entries(archived)");
}
```

Call `this.migrate()` at the end of `init()`.

**Step 3: Update `insert()` to store tier fields**

```typescript
insert(entry: ContextEntry): number {
  const stmt = this.db.prepare(`
    INSERT OR REPLACE INTO entries (id, date, time, type, tags, content, source_file, tier, access_count, last_accessed, pinned, archived)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    entry.id,
    entry.date,
    entry.time,
    entry.type,
    entry.tags.join(", "),
    entry.content,
    entry.sourceFile,
    entry.tier ?? "working",
    entry.accessCount ?? 0,
    entry.lastAccessed ?? null,
    entry.pinned ? 1 : 0,
    entry.archived ? 1 : 0
  );
  const row = this.db.prepare("SELECT last_insert_rowid() as rowid").get() as Record<string, unknown>;
  return row.rowid as number;
}
```

**Step 4: Update `getByRowids()` and `list()` to return tier fields**

Both map functions need to include:
```typescript
tier: (row.tier as string) as ContextEntry["tier"],
accessCount: row.access_count as number,
lastAccessed: row.last_accessed as string | null,
pinned: !!(row.pinned as number),
archived: !!(row.archived as number),
```

And their SELECT statements need: `tier, access_count, last_accessed, pinned, archived`.

**Step 5: Add `git_commit` to all Zod type enums**

In `context-save.ts`, `context-search.ts`, and `context-list.ts`, change the type enum to:
```typescript
z.enum(["decision", "progress", "issue", "handoff", "insight", "reference", "git_commit"])
```

**Step 6: Build and verify**

Run: `cd /home/hyperlynq/projects/Coding/claude-context-tool && npm run build`
Expected: Clean compile, no errors.

**Step 7: Commit**

```bash
git add -A && git commit -m "feat: add tier/archive schema migration and git_commit type"
```

---

### Task 2: Auto-tier assignment + context_save tier param

**Files:**
- Modify: `src/storage/sqlite.ts` (add `assignTier()` helper)
- Modify: `src/tools/context-save.ts` (add tier param, call assignTier)
- Modify: `src/storage/markdown.ts` (pass tier through appendEntry)

**Step 1: Add `assignTier()` to sqlite.ts**

```typescript
static assignTier(type: string, explicitTier?: string): "ephemeral" | "working" | "longterm" {
  if (explicitTier) return explicitTier as "ephemeral" | "working" | "longterm";
  switch (type) {
    case "handoff":
    case "progress":
      return "ephemeral";
    case "reference":
      return "longterm";
    default:
      return "working";
  }
}
```

**Step 2: Add tier and pinned to context_save schema**

In `src/tools/context-save.ts`:
```typescript
export const contextSaveSchema = {
  content: z.string().describe("The context content to save"),
  type: z
    .enum(["decision", "progress", "issue", "handoff", "insight", "reference", "git_commit"])
    .describe("Type of context entry"),
  tags: z
    .array(z.string())
    .default([])
    .describe("Tags for categorization (e.g. project names, topics)"),
  tier: z
    .enum(["ephemeral", "working", "longterm"])
    .optional()
    .describe("Memory tier override. Auto-assigned by type if omitted."),
  pinned: z
    .boolean()
    .optional()
    .default(false)
    .describe("Pin entry to prevent auto-decay"),
};
```

**Step 3: Update `contextSave()` function**

```typescript
export async function contextSave(
  args: { content: string; type: string; tags: string[]; tier?: string; pinned?: boolean },
  index: ContextIndex,
  embedder: Embedder
): Promise<{ success: boolean; id: string; date: string; time: string; tier: string }> {
  const tier = ContextIndex.assignTier(args.type, args.tier);
  const entry = appendEntry(args.content, args.type, args.tags);
  entry.tier = tier;
  entry.pinned = args.pinned ?? false;
  const rowid = index.insert(entry);

  const embedding = await embedder.embed(args.content);
  index.insertVec(rowid, embedding);

  return {
    success: true,
    id: entry.id,
    date: entry.date,
    time: entry.time,
    tier,
  };
}
```

**Step 4: Build and verify**

Run: `npm run build`
Expected: Clean compile.

**Step 5: Commit**

```bash
git add -A && git commit -m "feat: auto-tier assignment and tier param on context_save"
```

---

### Task 3: Access tracking in search

**Files:**
- Modify: `src/storage/sqlite.ts` (track access in hybridSearch, add bumpAccess method)

**Step 1: Add `bumpAccess()` method to ContextIndex**

```typescript
bumpAccess(ids: string[]): void {
  if (ids.length === 0) return;
  const now = new Date().toISOString().slice(0, 10);
  const stmt = this.db.prepare(`
    UPDATE entries SET access_count = access_count + 1, last_accessed = ? WHERE id = ?
  `);
  for (const id of ids) {
    stmt.run(now, id);
  }
}
```

**Step 2: Call bumpAccess at the end of `hybridSearch()`**

After computing final results, before returning:
```typescript
// Track access for returned results
this.bumpAccess(scored.slice(0, limit).map((s) => s.entry.id));
```

**Step 3: Build and verify**

Run: `npm run build`
Expected: Clean compile.

**Step 4: Commit**

```bash
git add -A && git commit -m "feat: track access count and last_accessed on search"
```

---

### Task 4: Tier weighting + filter in hybrid search

**Files:**
- Modify: `src/storage/sqlite.ts` (tier weight in hybridSearch, filter by tier)
- Modify: `src/tools/context-search.ts` (add tier and include_archived params)

**Step 1: Update `hybridSearch()` signature and logic**

Add `tier` and `includeArchived` to opts:

```typescript
hybridSearch(
  query: string,
  embedding: Float32Array,
  opts: { type?: string; days?: number; limit?: number; tier?: string; includeArchived?: boolean } = {}
): ContextEntry[] {
```

After temporal decay scoring, add tier weighting:

```typescript
const tierWeight = (tier: string | undefined): number => {
  switch (tier) {
    case "longterm": return 1.5;
    case "ephemeral": return 0.5;
    default: return 1.0; // working
  }
};

const scored = allRowids.map((rowid) => {
  const entry = entryMap.get(rowid)!;
  const entryDate = new Date(entry.date);
  const ageDays = (today.getTime() - entryDate.getTime()) / (1000 * 60 * 60 * 24);
  const decay = Math.pow(0.5, ageDays / 30);
  const tw = tierWeight(entry.tier);
  return { entry, score: (scores.get(rowid) ?? 0) * decay * tw };
});
```

Filter out archived unless requested, and filter by tier if specified:

```typescript
const filtered = scored.filter((s) => {
  if (!opts.includeArchived && s.entry.archived) return false;
  if (opts.tier && s.entry.tier !== opts.tier) return false;
  return true;
});
filtered.sort((a, b) => b.score - a.score);
this.bumpAccess(filtered.slice(0, limit).map((s) => s.entry.id));
return filtered.slice(0, limit).map((s) => s.entry);
```

**Step 2: Also update BM25 `search()` to exclude archived by default**

Add `archived = 0` condition to the WHERE clause (unless overridden). And update `list()` similarly:

```typescript
list(opts: { days?: number; type?: string; includeArchived?: boolean } = {}): ContextEntry[] {
  // ...existing conditions...
  if (!opts.includeArchived) {
    conditions.push("archived = 0");
  }
```

**Step 3: Update context_search schema**

In `src/tools/context-search.ts`, add to schema:
```typescript
tier: z
  .enum(["ephemeral", "working", "longterm"])
  .optional()
  .describe("Filter results to specific memory tier"),
include_archived: z
  .boolean()
  .optional()
  .default(false)
  .describe("Include archived entries in results"),
```

Pass through to `index.hybridSearch()`.

**Step 4: Update context_list schema**

In `src/tools/context-list.ts`, add `include_archived` param and pass to `index.list()`.

**Step 5: Build and verify**

Run: `npm run build`
Expected: Clean compile.

**Step 6: Commit**

```bash
git add -A && git commit -m "feat: tier weighting, tier filter, and archive exclusion in search/list"
```

---

### Task 5: context_archive tool

**Files:**
- Create: `src/tools/context-archive.ts`
- Modify: `src/server.ts` (register new tool)
- Modify: `src/storage/sqlite.ts` (add archive method)

**Step 1: Add `archiveEntries()` to ContextIndex**

```typescript
archiveEntries(ids: string[]): number {
  if (ids.length === 0) return 0;
  const placeholders = ids.map(() => "?").join(", ");
  const stmt = this.db.prepare(`
    UPDATE entries SET archived = 1 WHERE id IN (${placeholders}) AND pinned = 0
  `);
  const result = stmt.run(...ids);
  return result.changes;
}
```

**Step 2: Create `src/tools/context-archive.ts`**

```typescript
import { z } from "zod";
import { ContextIndex } from "../storage/sqlite.js";

export const contextArchiveSchema = {
  ids: z
    .array(z.string())
    .min(1)
    .describe("Entry IDs to archive"),
};

export function contextArchive(
  args: { ids: string[] },
  index: ContextIndex
): { archived: number; skipped_pinned: number } {
  const total = args.ids.length;
  const archived = index.archiveEntries(args.ids);
  return { archived, skipped_pinned: total - archived };
}
```

**Step 3: Register in `src/server.ts`**

Import and add:
```typescript
import { contextArchive, contextArchiveSchema } from "./tools/context-archive.js";

server.tool(
  "context_archive",
  "Bulk-archive entries by ID list. Archived entries are excluded from search/list by default.",
  contextArchiveSchema,
  async (args) => {
    const result = contextArchive(args, index);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);
```

**Step 4: Build and verify**

Run: `npm run build`
Expected: Clean compile.

**Step 5: Commit**

```bash
git add -A && git commit -m "feat: add context_archive tool for bulk archiving"
```

---

### Task 6: Decay + promotion logic

**Files:**
- Create: `src/storage/maintenance.ts`
- Modify: `src/storage/sqlite.ts` (add query methods for decay/promotion)

**Step 1: Add maintenance query methods to ContextIndex**

```typescript
/** Archive ephemeral entries older than N days */
decayEphemeral(daysOld: number = 7): number {
  const stmt = this.db.prepare(`
    UPDATE entries SET archived = 1
    WHERE tier = 'ephemeral' AND pinned = 0 AND archived = 0
      AND date < date('now', '-' || ? || ' days')
  `);
  return stmt.run(daysOld).changes;
}

/** Demote working entries not accessed in N days to ephemeral */
demoteIdle(idleDays: number = 30): number {
  const stmt = this.db.prepare(`
    UPDATE entries SET tier = 'ephemeral'
    WHERE tier = 'working' AND pinned = 0 AND archived = 0
      AND (last_accessed IS NULL AND date < date('now', '-' || ? || ' days'))
      OR (last_accessed IS NOT NULL AND last_accessed < date('now', '-' || ? || ' days'))
  `);
  return stmt.run(idleDays, idleDays).changes;
}

/** Promote decisions/insights older than 7 days to longterm */
promoteStable(): number {
  const stmt = this.db.prepare(`
    UPDATE entries SET tier = 'longterm'
    WHERE tier = 'working' AND archived = 0
      AND type IN ('decision', 'insight')
      AND date < date('now', '-7 days')
  `);
  return stmt.run().changes;
}

/** Promote ephemeral entries accessed 3+ times to working */
promoteFrequent(): number {
  const stmt = this.db.prepare(`
    UPDATE entries SET tier = 'working'
    WHERE tier = 'ephemeral' AND archived = 0
      AND access_count >= 3
  `);
  return stmt.run().changes;
}
```

**Step 2: Create `src/storage/maintenance.ts`**

```typescript
import { ContextIndex } from "./sqlite.js";

export interface MaintenanceReport {
  decayed: number;
  demoted: number;
  promotedStable: number;
  promotedFrequent: number;
}

export function runMaintenance(index: ContextIndex): MaintenanceReport {
  const decayed = index.decayEphemeral();
  const demoted = index.demoteIdle();
  const promotedStable = index.promoteStable();
  const promotedFrequent = index.promoteFrequent();
  return { decayed, demoted, promotedStable, promotedFrequent };
}
```

**Step 3: Build and verify**

Run: `npm run build`
Expected: Clean compile.

**Step 4: Commit**

```bash
git add -A && git commit -m "feat: add decay/promotion maintenance logic"
```

---

### Task 7: Consolidation candidate detection

**Files:**
- Modify: `src/storage/sqlite.ts` (add `findConsolidationCandidates()`)
- Modify: `src/storage/maintenance.ts` (add to maintenance flow)

**Step 1: Add `findConsolidationCandidates()` to ContextIndex**

This finds groups of 3+ semantically similar non-archived issue/decision entries.

```typescript
findConsolidationCandidates(
  embedding_lookup: (id: string) => Float32Array | null,
  threshold: number = 0.75
): Array<{ label: string; entries: ContextEntry[] }> {
  // Get all non-archived issue/decision entries from last 30 days
  const candidates = this.list({ days: 30, type: undefined, includeArchived: false })
    .filter(e => e.type === "issue" || e.type === "decision");

  if (candidates.length < 3) return [];

  // Simple greedy clustering by cosine similarity
  const used = new Set<string>();
  const groups: Array<{ label: string; entries: ContextEntry[] }> = [];

  for (let i = 0; i < candidates.length; i++) {
    if (used.has(candidates[i].id)) continue;
    const embA = embedding_lookup(candidates[i].id);
    if (!embA) continue;

    const cluster: ContextEntry[] = [candidates[i]];

    for (let j = i + 1; j < candidates.length; j++) {
      if (used.has(candidates[j].id)) continue;
      const embB = embedding_lookup(candidates[j].id);
      if (!embB) continue;

      const sim = cosineSimilarity(embA, embB);
      if (sim >= threshold) {
        cluster.push(candidates[j]);
      }
    }

    if (cluster.length >= 3) {
      cluster.forEach(e => used.add(e.id));
      groups.push({
        label: cluster[0].content.slice(0, 80),
        entries: cluster,
      });
    }
  }

  return groups;
}
```

**Step 2: Add `cosineSimilarity()` helper to sqlite.ts**

```typescript
function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
```

**Step 3: Add `getEmbedding()` method to ContextIndex**

To look up stored embeddings:
```typescript
getEmbedding(entryId: string): Float32Array | null {
  const rowidRow = this.db.prepare("SELECT rowid FROM entries WHERE id = ?").get(entryId) as { rowid: number } | undefined;
  if (!rowidRow) return null;
  const vecRow = this.db.prepare("SELECT embedding FROM vec_entries WHERE rowid = ?").get(CAST(rowidRow.rowid AS INTEGER)) as { embedding: Uint8Array } | undefined;
  if (!vecRow) return null;
  return new Float32Array(vecRow.embedding.buffer);
}
```

Note: sqlite-vec returns embeddings as raw bytes. The exact retrieval syntax may need adjustment based on sqlite-vec API — test at implementation time.

**Step 4: Build and verify**

Run: `npm run build`
Expected: Clean compile.

**Step 5: Commit**

```bash
git add -A && git commit -m "feat: consolidation candidate detection via cosine clustering"
```

---

### Task 8: Update session-start hook

**Files:**
- Modify: `src/hooks/session-start.ts`

This is the biggest hook change — add decay pass, promotions, tier filtering, consolidation candidates.

**Step 1: Import maintenance and run it before context injection**

```typescript
import { runMaintenance } from "../storage/maintenance.js";

// After creating index, before listing entries:
const maintenance = runMaintenance(index);
```

**Step 2: Filter injected entries to working + longterm only**

Change the `index.list()` calls to exclude ephemeral:
```typescript
const recent = index.list({ days: 3 })
  .filter(e => e.tier !== "ephemeral");
```

For handoffs, keep showing them (they're useful for continuity) but limit to 3:
```typescript
const handoffs = index.list({ days: 7, type: "handoff" }).slice(0, 3);
```

**Step 3: Add consolidation candidates section**

After handoffs and recent context, add:
```typescript
// Consolidation candidates
try {
  const groups = index.findConsolidationCandidates(
    (id) => index.getEmbedding(id)
  );
  if (groups.length > 0) {
    lines.push("## Consolidation Candidates");
    lines.push("The following entry groups are semantically similar and should be consolidated.");
    lines.push("For each group: summarize into one entry via `context_save` (type: longterm), then archive originals via `context_archive`.");
    lines.push("");
    for (const group of groups) {
      lines.push(`**Group** (${group.entries.length} entries, topic: ${group.label}):`);
      for (const e of group.entries) {
        const preview = e.content.length > 120 ? e.content.slice(0, 120) + "..." : e.content;
        lines.push(`- [${e.id}] ${e.date} (${e.type}): ${preview}`);
      }
      lines.push("");
    }
  }
} catch {
  // Don't block session start if consolidation detection fails
}
```

**Step 4: Add maintenance summary at the end**

```typescript
if (maintenance.decayed + maintenance.demoted + maintenance.promotedStable + maintenance.promotedFrequent > 0) {
  const parts: string[] = [];
  if (maintenance.decayed > 0) parts.push(`${maintenance.decayed} archived`);
  if (maintenance.demoted > 0) parts.push(`${maintenance.demoted} demoted`);
  if (maintenance.promotedStable > 0) parts.push(`${maintenance.promotedStable} promoted to longterm`);
  if (maintenance.promotedFrequent > 0) parts.push(`${maintenance.promotedFrequent} promoted to working`);
  lines.push(`_Maintenance: ${parts.join(", ")}._`);
}
```

**Step 5: Build and verify**

Run: `npm run build`
Expected: Clean compile.

**Step 6: Commit**

```bash
git add -A && git commit -m "feat: session-start decay, promotion, tier filter, consolidation"
```

---

### Task 9: Update context_status with tier distribution

**Files:**
- Modify: `src/storage/sqlite.ts` (extend `status()`)
- Modify: `src/tools/context-status.ts` (format new fields)

**Step 1: Extend `status()` in sqlite.ts**

Add tier distribution and pattern count:
```typescript
status(): {
  totalEntries: number;
  dateRange: { earliest: string; latest: string } | null;
  dbSizeBytes: number;
  tierDistribution: Record<string, number>;
  archivedCount: number;
  activePatterns: number;
} {
  // ...existing count and dateRange logic...

  const tierRows = this.db.prepare(
    "SELECT tier, COUNT(*) as count FROM entries WHERE archived = 0 GROUP BY tier"
  ).all() as Array<{ tier: string; count: number }>;
  const tierDistribution: Record<string, number> = {};
  for (const row of tierRows) {
    tierDistribution[row.tier] = row.count;
  }

  const archivedRow = this.db.prepare(
    "SELECT COUNT(*) as count FROM entries WHERE archived = 1"
  ).get() as { count: number };

  const patternRow = this.db.prepare(
    "SELECT COUNT(*) as count FROM patterns WHERE resolved = 0"
  ).get() as { count: number };

  return {
    totalEntries: total,
    dateRange,
    dbSizeBytes,
    tierDistribution,
    archivedCount: archivedRow.count,
    activePatterns: patternRow.count,
  };
}
```

**Step 2: Update `contextStatus()` in context-status.ts**

Add the new fields to the returned object (tier distribution, archived count, active patterns).

**Step 3: Build and verify**

Run: `npm run build`
Expected: Clean compile.

**Step 4: Commit**

```bash
git add -A && git commit -m "feat: context_status shows tier distribution and pattern count"
```

---

## Sub-phase 3b: Git History Indexing

### Task 10: Git log parser utility

**Files:**
- Create: `src/storage/git.ts`

**Step 1: Create git log parser**

```typescript
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface GitCommit {
  sha: string;
  message: string;
  author: string;
  date: string;
  branch: string;
  files: Array<{ path: string; insertions: number; deletions: number }>;
}

export function isGitRepo(dir: string): boolean {
  return existsSync(join(dir, ".git"));
}

export function getCurrentBranch(repoPath: string): string {
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: repoPath,
      encoding: "utf-8",
    }).trim();
  } catch {
    return "unknown";
  }
}

export function getGitLog(
  repoPath: string,
  opts: { days?: number; branch?: string } = {}
): GitCommit[] {
  const days = opts.days ?? 7;
  const branch = opts.branch ?? getCurrentBranch(repoPath);
  const since = `--since="${days} days ago"`;

  try {
    // Get commits with stats
    const raw = execSync(
      `git log ${branch} ${since} --format="COMMIT_SEP%n%H%n%s%n%an%n%aI" --numstat`,
      { cwd: repoPath, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 }
    );

    const commits: GitCommit[] = [];
    const blocks = raw.split("COMMIT_SEP\n").filter(Boolean);

    for (const block of blocks) {
      const lines = block.trim().split("\n");
      if (lines.length < 4) continue;

      const sha = lines[0];
      const message = lines[1];
      const author = lines[2];
      const dateStr = lines[3].slice(0, 10); // YYYY-MM-DD

      const files: GitCommit["files"] = [];
      for (let i = 4; i < lines.length; i++) {
        const parts = lines[i].split("\t");
        if (parts.length === 3) {
          files.push({
            insertions: parseInt(parts[0]) || 0,
            deletions: parseInt(parts[1]) || 0,
            path: parts[2],
          });
        }
      }

      commits.push({ sha, message, author, date: dateStr, branch, files });
    }

    return commits;
  } catch {
    return [];
  }
}

export function formatCommitAsContent(commit: GitCommit): string {
  const fileList = commit.files
    .map(f => {
      const stats = `+${f.insertions}/-${f.deletions}`;
      return `${f.path} (${stats})`;
    })
    .join(", ");
  return `[${commit.branch}] ${commit.message}\nFiles: ${fileList || "none"}`;
}
```

**Step 2: Build and verify**

Run: `npm run build`
Expected: Clean compile.

**Step 3: Commit**

```bash
git add -A && git commit -m "feat: git log parser utility"
```

---

### Task 11: context_git_index tool

**Files:**
- Create: `src/tools/context-git-index.ts`
- Modify: `src/server.ts` (register tool)
- Modify: `src/storage/sqlite.ts` (add `hasEntryWithTag()` for dedup)

**Step 1: Add dedup helper to ContextIndex**

```typescript
hasEntryWithTag(tag: string): boolean {
  const row = this.db.prepare(
    "SELECT 1 FROM entries WHERE tags LIKE ? LIMIT 1"
  ).get(`%${tag}%`);
  return !!row;
}
```

**Step 2: Create `src/tools/context-git-index.ts`**

```typescript
import { z } from "zod";
import { ContextIndex } from "../storage/sqlite.js";
import { Embedder } from "../storage/embedder.js";
import { appendEntry } from "../storage/markdown.js";
import { getGitLog, formatCommitAsContent, isGitRepo } from "../storage/git.js";

export const contextGitIndexSchema = {
  repo_path: z
    .string()
    .optional()
    .describe("Path to git repository (defaults to cwd)"),
  days: z
    .number()
    .int()
    .positive()
    .default(7)
    .describe("Index commits from last N days"),
  branch: z
    .string()
    .optional()
    .describe("Branch to index (defaults to current branch)"),
};

export async function contextGitIndex(
  args: { repo_path?: string; days?: number; branch?: string },
  index: ContextIndex,
  embedder: Embedder
): Promise<{ indexed: number; skipped: number; repo: string }> {
  const repoPath = args.repo_path ?? process.cwd();

  if (!isGitRepo(repoPath)) {
    return { indexed: 0, skipped: 0, repo: repoPath };
  }

  const commits = getGitLog(repoPath, { days: args.days, branch: args.branch });
  let indexed = 0;
  let skipped = 0;

  for (const commit of commits) {
    const shaTag = `sha:${commit.sha.slice(0, 12)}`;

    // Dedup: skip if already indexed
    if (index.hasEntryWithTag(shaTag)) {
      skipped++;
      continue;
    }

    const content = formatCommitAsContent(commit);
    const entry = appendEntry(content, "git_commit", [shaTag, commit.branch]);

    // Auto-tier: recent = working, older = ephemeral
    const commitDate = new Date(commit.date);
    const ageDays = (Date.now() - commitDate.getTime()) / (1000 * 60 * 60 * 24);
    entry.tier = ageDays < 7 ? "working" : "ephemeral";

    const rowid = index.insert(entry);
    const embedding = await embedder.embed(content);
    index.insertVec(rowid, embedding);
    indexed++;
  }

  return { indexed, skipped, repo: repoPath };
}
```

**Step 3: Register in server.ts**

```typescript
import { contextGitIndex, contextGitIndexSchema } from "./tools/context-git-index.js";

server.tool(
  "context_git_index",
  "Index git commits as searchable context entries. Deduplicates by SHA.",
  contextGitIndexSchema,
  async (args) => {
    const result = await contextGitIndex(args, index, embedder);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);
```

**Step 4: Build and verify**

Run: `npm run build`
Expected: Clean compile.

**Step 5: Commit**

```bash
git add -A && git commit -m "feat: add context_git_index tool for git commit indexing"
```

---

### Task 12: Session-start git auto-index

**Files:**
- Modify: `src/hooks/session-start.ts`

**Step 1: Add git auto-indexing to session-start**

After maintenance pass, before listing entries:

```typescript
import { Embedder } from "../storage/embedder.js";
import { contextGitIndex } from "../tools/context-git-index.js";

// Auto-index recent git commits (last 24h, silent failure)
const embedder = new Embedder();
try {
  await contextGitIndex({ days: 1 }, index, embedder);
} catch {
  // Don't block session start
}
```

Note: The embedder needs to be created in session-start now. This adds ~100ms on first run (model loading), but subsequent runs use the cached model.

**Step 2: Build and verify**

Run: `npm run build`
Expected: Clean compile.

**Step 3: Commit**

```bash
git add -A && git commit -m "feat: auto-index git commits on session start"
```

---

## Sub-phase 3c: Error Pattern Detection

### Task 13: Pattern detection in context_save

**Files:**
- Modify: `src/storage/sqlite.ts` (pattern CRUD methods)
- Modify: `src/tools/context-save.ts` (trigger detection on issue save)

**Step 1: Add pattern methods to ContextIndex**

```typescript
findSimilarIssues(embedding: Float32Array, days: number = 30, threshold: number = 0.25): ContextEntry[] {
  // threshold is distance threshold for sqlite-vec (lower = more similar)
  // 0.25 distance ≈ 0.75 cosine similarity
  const vecResults = this.searchVec(embedding, 20);
  const matchingRowids = vecResults
    .filter(r => r.distance <= threshold)
    .map(r => r.rowid);

  if (matchingRowids.length === 0) return [];

  const entries = this.getByRowids(matchingRowids);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  return entries.filter(e =>
    e.type === "issue" && !e.archived && e.date >= cutoffStr
  );
}

createOrUpdatePattern(label: string, entryIds: string[]): string {
  // Check if any existing pattern overlaps with these entries
  const patterns = this.db.prepare(
    "SELECT id, entry_ids, occurrence_count, first_seen FROM patterns WHERE resolved = 0"
  ).all() as Array<{ id: string; entry_ids: string; occurrence_count: number; first_seen: string }>;

  const entryIdSet = new Set(entryIds);
  for (const pat of patterns) {
    const existing = JSON.parse(pat.entry_ids) as string[];
    const overlap = existing.some(id => entryIdSet.has(id));
    if (overlap) {
      // Merge into existing pattern
      const merged = Array.from(new Set([...existing, ...entryIds]));
      const now = new Date().toISOString().slice(0, 10);
      this.db.prepare(`
        UPDATE patterns SET entry_ids = ?, occurrence_count = ?, last_seen = ?, label = ?
        WHERE id = ?
      `).run(JSON.stringify(merged), merged.length, now, label.slice(0, 80), pat.id);
      return pat.id;
    }
  }

  // Create new pattern
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const now = new Date().toISOString().slice(0, 10);
  this.db.prepare(`
    INSERT INTO patterns (id, label, entry_ids, occurrence_count, first_seen, last_seen)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, label.slice(0, 80), JSON.stringify(entryIds), entryIds.length, now, now);
  return id;
}

getActivePatterns(): Array<{
  id: string;
  label: string;
  entryIds: string[];
  occurrenceCount: number;
  firstSeen: string;
  lastSeen: string;
}> {
  const rows = this.db.prepare(
    "SELECT * FROM patterns WHERE resolved = 0 AND occurrence_count >= 3 ORDER BY last_seen DESC"
  ).all() as Array<Record<string, unknown>>;
  return rows.map(r => ({
    id: r.id as string,
    label: r.label as string,
    entryIds: JSON.parse(r.entry_ids as string) as string[],
    occurrenceCount: r.occurrence_count as number,
    firstSeen: r.first_seen as string,
    lastSeen: r.last_seen as string,
  }));
}

getPatternForEntry(entryId: string): { id: string; occurrenceCount: number } | null {
  const rows = this.db.prepare(
    "SELECT id, occurrence_count, entry_ids FROM patterns WHERE resolved = 0"
  ).all() as Array<{ id: string; occurrence_count: number; entry_ids: string }>;
  for (const row of rows) {
    const ids = JSON.parse(row.entry_ids) as string[];
    if (ids.includes(entryId)) {
      return { id: row.id, occurrenceCount: row.occurrence_count };
    }
  }
  return null;
}

resolvePattern(patternId: string): boolean {
  const result = this.db.prepare(
    "UPDATE patterns SET resolved = 1 WHERE id = ?"
  ).run(patternId);
  return result.changes > 0;
}
```

**Step 2: Add pattern detection to contextSave**

At the end of `contextSave()`, after embedding and insert:

```typescript
// Pattern detection for issues
let patternId: string | undefined;
if (args.type === "issue") {
  try {
    const similar = index.findSimilarIssues(embedding);
    if (similar.length >= 2) {
      const allIds = [entry.id, ...similar.map(e => e.id)];
      patternId = index.createOrUpdatePattern(args.content, allIds);
    }
  } catch {
    // Don't fail the save if pattern detection errors
  }
}

return {
  success: true,
  id: entry.id,
  date: entry.date,
  time: entry.time,
  tier,
  ...(patternId ? { pattern_detected: patternId } : {}),
};
```

**Step 3: Build and verify**

Run: `npm run build`
Expected: Clean compile.

**Step 4: Commit**

```bash
git add -A && git commit -m "feat: pattern detection on issue save"
```

---

### Task 14: Pattern annotations in search + context_resolve_pattern tool

**Files:**
- Modify: `src/tools/context-search.ts` (annotate results with pattern info)
- Create: `src/tools/context-resolve-pattern.ts`
- Modify: `src/server.ts` (register tool)

**Step 1: Annotate search results with pattern info**

In `contextSearch()`, after getting results, check each for pattern membership:

```typescript
const enriched = results.map((r) => {
  const pattern = index.getPatternForEntry(r.id);
  return {
    id: r.id,
    date: r.date,
    time: r.time,
    type: r.type,
    tags: r.tags,
    content: r.content,
    ...(r.tier ? { tier: r.tier } : {}),
    ...(pattern ? { pattern: `Recurring pattern: seen ${pattern.occurrenceCount} times (pattern: ${pattern.id})` } : {}),
  };
});
```

**Step 2: Create `src/tools/context-resolve-pattern.ts`**

```typescript
import { z } from "zod";
import { ContextIndex } from "../storage/sqlite.js";

export const contextResolvePatternSchema = {
  pattern_id: z.string().describe("Pattern ID to mark as resolved"),
};

export function contextResolvePattern(
  args: { pattern_id: string },
  index: ContextIndex
): { resolved: boolean; pattern_id: string } {
  const resolved = index.resolvePattern(args.pattern_id);
  return { resolved, pattern_id: args.pattern_id };
}
```

**Step 3: Register in server.ts**

```typescript
import { contextResolvePattern, contextResolvePatternSchema } from "./tools/context-resolve-pattern.js";

server.tool(
  "context_resolve_pattern",
  "Mark a recurring issue pattern as resolved. Stops surfacing in search and session-start.",
  contextResolvePatternSchema,
  async (args) => {
    const result = contextResolvePattern(args, index);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);
```

**Step 4: Build and verify**

Run: `npm run build`
Expected: Clean compile.

**Step 5: Commit**

```bash
git add -A && git commit -m "feat: pattern annotations in search + context_resolve_pattern tool"
```

---

### Task 15: Session-start pattern warnings

**Files:**
- Modify: `src/hooks/session-start.ts`

**Step 1: Add pattern warnings after consolidation section**

```typescript
// Recurring issue patterns
const patterns = index.getActivePatterns();
if (patterns.length > 0) {
  lines.push("## Recurring Issues");
  for (const pattern of patterns) {
    const daySpan = Math.ceil(
      (new Date(pattern.lastSeen).getTime() - new Date(pattern.firstSeen).getTime()) / (1000 * 60 * 60 * 24)
    ) || 1;
    lines.push(`- "${pattern.label}" — ${pattern.occurrenceCount} occurrences over ${daySpan} days (last: ${pattern.lastSeen})`);
  }
  lines.push("");
}
```

**Step 2: Build and verify**

Run: `npm run build`
Expected: Clean compile.

**Step 3: Commit**

```bash
git add -A && git commit -m "feat: session-start recurring issue pattern warnings"
```

---

## Final

### Task 16: Version bump + final build + update server version

**Files:**
- Modify: `package.json` (version 0.3.0)
- Modify: `src/server.ts` (version string)

**Step 1: Bump version**

In `package.json`: `"version": "0.3.0"`
In `src/server.ts`: `version: "0.3.0"`

**Step 2: Full build and verify**

Run: `npm run build`
Expected: Clean compile, no errors.

**Step 3: Commit and tag**

```bash
git add -A && git commit -m "chore: bump version to 0.3.0 — memory intelligence"
git tag v0.3.0
```

**Step 4: Push**

```bash
git push && git push --tags
```
