# Synaptic Quality Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix Synaptic's five compounding quality issues — search ranking, pending_rule duplication, terse handoffs, missing cleanup features, and weak auto-recall triggers.

**Architecture:** Surgical patches to existing code. No schema changes. Search scoring rebalanced in hybridSearch(), content-hash dedup added to all pending_rule creation paths, handoff generation rewritten for project-grouped detail, cleanup CLI extended with pending_rule purge + FTS rebuild, auto-recall rule updated via context_save_rule.

**Tech Stack:** TypeScript, Node.js 22+, SQLite FTS5, sqlite-vec, @huggingface/transformers

---

### Task 1: Add contentHash and updateTimestamp utilities

**Files:**
- Modify: `src/storage/search-utils.ts`
- Modify: `src/storage/sqlite.ts:597-604`

- [ ] **Step 1: Add contentHash to search-utils.ts**

Append after the existing `conceptToFts5` function (line 96):

```typescript
import { createHash } from "node:crypto";

/**
 * Produce a short content-based hash for deduplication.
 * Normalizes: lowercase, collapse whitespace, strip punctuation.
 */
export function contentHash(text: string): string {
  const normalized = text.toLowerCase().replace(/\s+/g, " ").replace(/[^\w\s]/g, "").trim();
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}
```

Also add the `createHash` import at the top of the file (line 1 area — before the doc comment or after it):

```typescript
import { createHash } from "node:crypto";
```

- [ ] **Step 2: Add updateTimestamp to ContextIndex**

The existing `touchEntry()` at sqlite.ts:598-604 only bumps `access_count`. Add a new method right after it for updating the date/time of an entry:

```typescript
/** Update an entry's date and time to now (for upsert-style dedup). */
updateTimestamp(id: string): boolean {
  const now = new Date();
  const date = now.toISOString().split("T")[0];
  const time = now.toTimeString().slice(0, 5);
  const result = this.db.prepare(
    "UPDATE entries SET date = ?, time = ? WHERE id = ? AND archived = 0"
  ).run(date, time, id);
  return (result.changes ?? 0) > 0;
}
```

- [ ] **Step 3: Add rebuildFts to ContextIndex**

Add after `updateTimestamp`:

```typescript
/** Drop and rebuild the FTS5 index from non-archived entries. */
rebuildFts(): void {
  this.db.exec("DELETE FROM entries_fts");
  this.db.exec(`
    INSERT INTO entries_fts(rowid, content, tags, type)
    SELECT rowid, content, tags, type FROM entries WHERE archived = 0
  `);
}
```

- [ ] **Step 4: Build and verify**

Run: `cd /home/hyperlynq/projects/Coding/claude-context-tool && npm run build`
Expected: No TypeScript errors

- [ ] **Step 5: Commit**

```bash
git add src/storage/search-utils.ts src/storage/sqlite.ts
git commit -m "Add contentHash, updateTimestamp, rebuildFts utilities"
```

---

### Task 2: Rebalance hybridSearch scoring

**Files:**
- Modify: `src/storage/sqlite.ts:646,670`

- [ ] **Step 1: Boost concept-hit scoring weight**

At sqlite.ts:646, change the concept boost multiplier from `0.5` to `1.5`:

```typescript
// BEFORE (line 646):
scores.set(entry.id, (scores.get(entry.id) ?? 0) + conceptBoost * 0.5);

// AFTER:
scores.set(entry.id, (scores.get(entry.id) ?? 0) + conceptBoost * 1.5);
```

- [ ] **Step 2: Boost project match weight**

At sqlite.ts:670, change project boost from `1.5` to `2.0`:

```typescript
// BEFORE (line 670):
return entryProject === curProject ? 1.5 : 1.0;

// AFTER:
return entryProject === curProject ? 2.0 : 1.0;
```

- [ ] **Step 3: Build and run search tests**

Run: `cd /home/hyperlynq/projects/Coding/claude-context-tool && npm run test:search`
Expected: All existing tests pass. The scoring changes only affect relative ranking, not pass/fail of existing tests.

- [ ] **Step 4: Commit**

```bash
git add src/storage/sqlite.ts
git commit -m "Boost concept-hit and project-match scoring in hybridSearch

Concept weight 0.5→1.5, project boost 1.5→2.0. Project-specific
entries matching query concepts now dominate over generic BM25 hits."
```

---

### Task 3: Fix pending_rule duplication in stop.ts

**Files:**
- Modify: `src/hooks/stop.ts:116-157,527-541`

- [ ] **Step 1: Add contentHash import to stop.ts**

At the top of stop.ts, add to imports (after line 21):

```typescript
import { contentHash } from "../storage/search-utils.js";
```

- [ ] **Step 2: Add content-hash gate to real-time directive detection**

Replace the pending_rule creation block at lines 116-157. The key change is adding a content-hash check BEFORE the expensive embedding comparison, and lowering the vector dedup threshold from 0.75 to 0.70:

Find the existing code block starting with `// === Real-time directive detection for user messages ===` and ending with `index.insertVec(rowid, msgEmb);` + closing brace.

Replace the dedup section (around lines 136-157) — specifically the part after `const msgEmb = await embedder.embed(msg.text);`:

```typescript
  // Content-hash dedup: fast check for exact/near-exact content
  const hash = contentHash(msg.text);
  const recentPending = index.list({ days: 30 }).filter(e => e.tags.includes("pending_rule"));
  const hashMatch = recentPending.find(e => contentHash(e.content) === hash);
  if (hashMatch) {
    index.updateTimestamp(hashMatch.id);
    continue;
  }

  // Vector dedup: check against existing rules + pending rules
  const msgEmb = await embedder.embed(msg.text);
  const existingRules = index.listRules();
  let isDuplicate = false;

  for (const rule of [...existingRules, ...recentPending.map(r => ({ label: "", content: r.content }))]) {
    const ruleEmb = await embedder.embed(rule.content);
    let dot = 0;
    for (let i = 0; i < msgEmb.length; i++) dot += msgEmb[i] * ruleEmb[i];
    if (dot >= 0.70) { isDuplicate = true; break; }
  }
  if (isDuplicate) continue;
```

- [ ] **Step 3: Add content-hash gate to correction detection in handoff**

In the correction saving section (around lines 527-541), add the same hash check before saving corrections as pending rules. Find the block:

```typescript
// Save corrections as pending rule proposals
if (corrections.length > 0) {
  for (const corr of corrections.slice(0, 3)) {
```

Add the hash gate inside the loop, before creating the entry:

```typescript
if (corrections.length > 0) {
  const recentPendingForCorr = index.list({ days: 30 }).filter(e => e.tags.includes("pending_rule"));
  for (const corr of corrections.slice(0, 3)) {
    // Content-hash dedup
    const corrHash = contentHash(corr.content);
    const existingMatch = recentPendingForCorr.find(e => contentHash(e.content) === corrHash);
    if (existingMatch) {
      index.updateTimestamp(existingMatch.id);
      continue;
    }

    const label = corr.content.slice(0, 40).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+$/, "");
    // ... rest of existing code unchanged
```

- [ ] **Step 4: Build and verify**

Run: `cd /home/hyperlynq/projects/Coding/claude-context-tool && npm run build`
Expected: No TypeScript errors

- [ ] **Step 5: Commit**

```bash
git add src/hooks/stop.ts
git commit -m "Add content-hash dedup to pending_rule creation in stop hook

Fast SHA-256 hash check before expensive embedding comparison.
Lower vector threshold 0.75→0.70 to catch more near-dupes.
Upsert semantics: update timestamp of existing entry instead
of creating a new one."
```

---

### Task 4: Fix pending_rule duplication in pre-compact.ts

**Files:**
- Modify: `src/hooks/pre-compact.ts:77-116`

- [ ] **Step 1: Add contentHash import**

Add to imports at the top of pre-compact.ts:

```typescript
import { contentHash } from "../storage/search-utils.js";
```

- [ ] **Step 2: Add content-hash gate to directive detection**

Same pattern as stop.ts. In the pending_rule creation loop (lines 77-116), add the hash check before the embedding comparison. Replace the dedup section:

```typescript
  // Content-hash dedup: fast check for exact/near-exact content
  const hash = contentHash(msg.text);
  const recentPending = index.list({ days: 30 }).filter(e => e.tags.includes("pending_rule"));
  const hashMatch = recentPending.find(e => contentHash(e.content) === hash);
  if (hashMatch) {
    index.updateTimestamp(hashMatch.id);
    continue;
  }

  // Vector dedup with lower threshold
  const msgEmb = await embedder.embed(msg.text);
  const existingRules = index.listRules();
  let isDuplicate = false;

  for (const rule of [...existingRules, ...recentPending.map(r => ({ label: "", content: r.content }))]) {
    const ruleEmb = await embedder.embed(rule.content);
    let dot = 0;
    for (let i = 0; i < msgEmb.length; i++) dot += msgEmb[i] * ruleEmb[i];
    if (dot >= 0.70) { isDuplicate = true; break; }
  }
  if (isDuplicate) continue;
```

- [ ] **Step 3: Build and verify**

Run: `cd /home/hyperlynq/projects/Coding/claude-context-tool && npm run build`
Expected: No TypeScript errors

- [ ] **Step 4: Commit**

```bash
git add src/hooks/pre-compact.ts
git commit -m "Add content-hash dedup to pending_rule creation in pre-compact hook"
```

---

### Task 5: Extend cleanup CLI with pending_rule purge and FTS rebuild

**Files:**
- Modify: `src/cli/cleanup.ts`

- [ ] **Step 1: Add pending_rule purge and FTS rebuild to cleanupCommand**

Replace the entire file content of `src/cli/cleanup.ts`:

```typescript
/**
 * CLI command for running smart dedup cleanup.
 *
 * Usage:
 *   synaptic cleanup [--dry-run] [--aggressive] [--purge-pending-dupes]
 */

import { ContextIndex } from "../storage/sqlite.js";
import { ensureDirs } from "../storage/paths.js";
import { contentHash } from "../storage/search-utils.js";

const AGGRESSIVE_THRESHOLDS: Record<string, number> = {
  insight: 0.85,
  progress: 0.85,
  git_commit: 0.85,
  decision: 0.92,
  reference: 0.92,
  rule: 0.95,
};

export async function cleanupCommand(args: string[]): Promise<void> {
  const dryRun = args.includes("--dry-run");
  const aggressive = args.includes("--aggressive");
  const purgePendingDupes = args.includes("--purge-pending-dupes");

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
synaptic cleanup — smart duplicate detection and cleanup

Usage:
  synaptic cleanup [--dry-run] [--aggressive] [--purge-pending-dupes]

Flags:
  --dry-run               Preview what would be merged (no changes made)
  --aggressive            Lower similarity thresholds per entry type
  --purge-pending-dupes   Archive duplicate pending_rule entries (keep newest per label)

Default mode uses a 0.90 cosine similarity threshold (conservative).
Aggressive mode uses type-specific thresholds:
  insight, progress, git_commit: 0.85
  decision, reference: 0.92
    `.trim());
    return;
  }

  ensureDirs();
  const index = new ContextIndex();

  try {
    const status = index.status();
    const mode = aggressive ? "aggressive" : "conservative";
    console.log(`Synaptic Cleanup${dryRun ? " (DRY RUN)" : ""}`);
    console.log(`${"=".repeat(40)}`);
    console.log(`Mode: ${mode}`);
    console.log(`Entries scanned: ${status.totalEntries - status.archivedCount}`);
    console.log();

    let pendingPurged = 0;
    let handoffPurged = 0;

    // Step 1: Purge duplicate pending_rules
    if (purgePendingDupes || aggressive) {
      console.log("--- Pending Rule Dedup ---");
      const allEntries = index.list({ days: 365 });
      const pendingRules = allEntries.filter(e => e.tags.includes("pending_rule"));

      // Group by proposed-label tag
      const byLabel = new Map<string, typeof pendingRules>();
      for (const entry of pendingRules) {
        const labelTag = entry.tags.find(t => t.startsWith("proposed-label:")) || "unlabeled";
        if (!byLabel.has(labelTag)) byLabel.set(labelTag, []);
        byLabel.get(labelTag)!.push(entry);
      }

      for (const [label, entries] of byLabel) {
        if (entries.length <= 1) continue;
        // Sort by date desc, keep newest
        entries.sort((a, b) => b.date.localeCompare(a.date) || b.time.localeCompare(a.time));
        const toArchive = entries.slice(1).map(e => e.id);
        if (!dryRun) {
          index.mergeTagsInto(entries[0].id, toArchive);
          index.archiveEntries(toArchive);
        }
        pendingPurged += toArchive.length;
        console.log(`  ${label}: kept 1, ${dryRun ? "would archive" : "archived"} ${toArchive.length}`);
      }

      // Also catch pending_rules with same content but different labels
      const remaining = pendingRules.filter(e => !byLabel.get(
        e.tags.find(t => t.startsWith("proposed-label:")) || "unlabeled"
      )?.slice(1).some(d => d.id === e.id));

      const byHash = new Map<string, typeof remaining>();
      for (const entry of remaining) {
        const hash = contentHash(entry.content);
        if (!byHash.has(hash)) byHash.set(hash, []);
        byHash.get(hash)!.push(entry);
      }

      for (const [, entries] of byHash) {
        if (entries.length <= 1) continue;
        entries.sort((a, b) => b.date.localeCompare(a.date));
        const toArchive = entries.slice(1).map(e => e.id);
        if (!dryRun) {
          index.mergeTagsInto(entries[0].id, toArchive);
          index.archiveEntries(toArchive);
        }
        pendingPurged += toArchive.length;
      }

      console.log(`Pending rule duplicates: ${pendingPurged} ${dryRun ? "would be archived" : "archived"}\n`);
    }

    // Step 2: Purge useless ephemeral handoffs
    if (aggressive) {
      console.log("--- Empty Handoff Cleanup ---");
      const allEntries = index.list({ days: 365 });
      const handoffs = allEntries.filter(e =>
        e.type === "handoff" &&
        e.tier === "ephemeral" &&
        /^Activity: \d+ entries/.test(e.content) &&
        !e.content.includes("Learnings:")
      );

      if (handoffs.length > 0) {
        if (!dryRun) {
          index.archiveEntries(handoffs.map(e => e.id));
        }
        handoffPurged = handoffs.length;
        console.log(`Empty handoffs: ${handoffPurged} ${dryRun ? "would be archived" : "archived"}\n`);
      } else {
        console.log("No empty handoffs found.\n");
      }
    }

    // Step 3: Smart dedup
    console.log("--- Smart Dedup ---");
    const actions = index.smartDedup({
      threshold: aggressive ? 0.80 : 0.90,
      typeThresholds: aggressive ? AGGRESSIVE_THRESHOLDS : undefined,
      dryRun,
      minAgeDays: aggressive ? 1 : 3,
    });

    if (actions.length === 0) {
      console.log("No duplicates found.\n");
    } else {
      const subsetCount = actions.filter(a => a.reason === "subset").length;
      const similarityCount = actions.filter(a => a.reason === "similarity").length;
      const archivedTotal = actions.reduce((sum, a) => sum + a.archivedIds.length, 0);

      if (dryRun) {
        for (const action of actions) {
          const simStr = action.similarity ? ` (${(action.similarity * 100).toFixed(1)}%)` : "";
          console.log(`  [${action.reason}]${simStr}`);
          console.log(`    Survivor: ${action.survivorId} — "${action.survivorContent}..."`);
          console.log(`    Archive:  ${action.archivedIds.join(", ")}`);
        }
      }

      console.log(`Smart dedup: ${actions.length} groups (subset: ${subsetCount}, similarity: ${similarityCount})`);
      console.log(`Entries ${dryRun ? "would be " : ""}archived: ${archivedTotal}\n`);
    }

    // Step 4: Rebuild FTS5 if changes were made
    const totalChanges = pendingPurged + handoffPurged + actions.length;
    if (!dryRun && totalChanges > 0) {
      index.rebuildFts();
      console.log("FTS5 index rebuilt.");
    }

    // Summary
    console.log(`\n${"=".repeat(40)}`);
    console.log(`Total entries ${dryRun ? "would be " : ""}cleaned: ${pendingPurged + handoffPurged + actions.reduce((s, a) => s + a.archivedIds.length, 0)}`);
    if (dryRun) {
      console.log(`Run without --dry-run to apply changes.`);
    }
  } finally {
    index.close();
  }
}
```

- [ ] **Step 2: Build and verify**

Run: `cd /home/hyperlynq/projects/Coding/claude-context-tool && npm run build`
Expected: No TypeScript errors

- [ ] **Step 3: Test with dry-run**

Run: `cd /home/hyperlynq/projects/Coding/claude-context-tool && node build/src/cli.js cleanup --dry-run --aggressive --purge-pending-dupes`
Expected: Shows what would be purged without making changes

- [ ] **Step 4: Commit**

```bash
git add src/cli/cleanup.ts
git commit -m "Extend cleanup CLI with pending_rule purge, empty handoff cleanup, FTS rebuild

New flags: --purge-pending-dupes, --aggressive now also purges
empty handoffs. FTS5 index auto-rebuilt after any changes."
```

---

### Task 6: Improve handoff generation in stop.ts

**Files:**
- Modify: `src/hooks/stop.ts` (handoff content construction, around lines 400-425)

- [ ] **Step 1: Replace handoff content construction**

Find the section that builds `contentParts` starting with the "Activity line" comment (around line 410). Replace from `const contentParts: string[] = [];` through the end of the "Learnings section" block (around line 425) with:

```typescript
const contentParts: string[] = [];

// Group entries by project for structured handoff
const byProject = new Map<string, typeof todayEntries>();
for (const entry of todayEntries) {
  const proj = entry.project || "general";
  if (!byProject.has(proj)) byProject.set(proj, []);
  byProject.get(proj)!.push(entry);
}

for (const [project, entries] of byProject) {
  const typeCounts = new Map<string, number>();
  for (const e of entries) typeCounts.set(e.type, (typeCounts.get(e.type) ?? 0) + 1);
  const typeStr = Array.from(typeCounts.entries())
    .map(([t, c]) => `${t}:${c}`)
    .join(", ");

  contentParts.push(`**${project}** (${entries.length} entries — ${typeStr}):`);

  // Get insights for this project (up to 8, 300 char limit)
  const projectInsights = entries
    .filter(e =>
      e.type === "insight" &&
      !e.tags.includes("pending_rule") &&
      !e.tags.includes("transcript-scan") &&
      !e.content.startsWith("Activity:")
    )
    .slice(0, 8);

  if (projectInsights.length > 0) {
    contentParts.push("Learnings:");
    for (const insight of projectInsights) {
      const summary = insight.content.length > 300
        ? insight.content.slice(0, 300) + "..."
        : insight.content;
      contentParts.push(`- ${summary}`);
    }
  }

  // List pending/TODO items
  const pending = entries.filter(e =>
    e.tags.some(t => ["todo", "pending", "next", "in-progress"].includes(t))
  );
  if (pending.length > 0) {
    contentParts.push("Pending:");
    for (const p of pending.slice(0, 5)) {
      contentParts.push(`- ${p.content.slice(0, 200)}`);
    }
  }
}
```

Note: Keep the rest of the handoff code unchanged (correction detection, intent classification, etc. that follows).

- [ ] **Step 2: Build and verify**

Run: `cd /home/hyperlynq/projects/Coding/claude-context-tool && npm run build`
Expected: No TypeScript errors

- [ ] **Step 3: Commit**

```bash
git add src/hooks/stop.ts
git commit -m "Improve handoff generation with project-grouped summaries

Replace flat 'Activity: N entries' format with per-project
breakdowns. Increase learning detail (300 chars, 8 per project).
Include pending/TODO items in handoffs."
```

---

### Task 7: Run migration cleanup on live data

**Files:**
- None modified — uses existing cleanup CLI

This task uses the cleanup CLI from Task 5 to clean the live database.

- [ ] **Step 1: Build the project**

Run: `cd /home/hyperlynq/projects/Coding/claude-context-tool && npm run build`

- [ ] **Step 2: Dry-run to preview changes**

Run: `node build/src/cli.js cleanup --dry-run --aggressive --purge-pending-dupes`
Expected: Report showing duplicate pending_rules, empty handoffs, and similarity matches that would be cleaned

- [ ] **Step 3: Apply cleanup**

Run: `node build/src/cli.js cleanup --aggressive --purge-pending-dupes`
Expected: Entries archived, FTS5 rebuilt, summary printed

- [ ] **Step 4: Verify search quality**

Start a Synaptic MCP session and test search:
- Search "lynq beats progress" — should return lynq-beats entries first
- Search "fever project" — should return Fever entries first
- Search "hero logo sizing" — should return 1-2 entries, not 15+

- [ ] **Step 5: Commit (no code changes, just note)**

No commit needed — this is a data operation.

---

### Task 8: Update auto-recall rule

**Files:**
- None (data-level change via context_save_rule MCP tool)

- [ ] **Step 1: Delete the old auto-recall rule**

Call MCP tool: `context_delete_rule` with label `auto-recall`

- [ ] **Step 2: Save the updated rule**

Call MCP tool: `context_save_rule` with:

Label: `auto-recall`

Content:
```
# Auto-recall: MANDATORY Synaptic search triggers

You MUST call context_search BEFORE your first response when ANY of these match:

MANDATORY TRIGGERS (no exceptions):
- User mentions a KNOWN project by name (check MEMORY.md for project list)
- User asks about progress, status, memory, or history ("where did we leave off", "what was done", "progress", "status", "last session", "what did we build")
- User uses continuity language ("continue", "we were", "last time", "that bug", "the issue", "remember", "you said")
- User asks about a past decision ("why did we", "should we still", "what was the approach")
- You are about to say "I don't know" or "I don't have context"

DO NOT TRIGGER when:
- User is clearly starting a NEW project from scratch (no prior history to find)
- User is brainstorming or planning something new (don't search for context on something that doesn't exist yet)
- Generic standalone coding question with no project reference
- Self-contained task where user provides ALL context in the message

SEARCH STRATEGY when triggered:
- Use 2-3 SHORT keyword queries, not long phrases
- Example: search "lynq-beats" then "lynq-beats progress" — NOT "lynq beats project progress status latest session"
- Use context_list for full untruncated content if search results are truncated
- If first search returns irrelevant results, try a more specific query with the project name
```

- [ ] **Step 3: Verify the rule is active**

Call MCP tool: `context_list_rules`
Expected: The updated auto-recall rule appears with the new content

---

### Task 9: Run all tests and final verification

**Files:**
- None modified

- [ ] **Step 1: Run full test suite**

Run: `cd /home/hyperlynq/projects/Coding/claude-context-tool && npm run test:all`
Expected: All tests pass (smoke-test, test:search, test:cleanup)

- [ ] **Step 2: Verify hooks still work**

Run: `node --no-warnings build/src/hooks/session-start.js`
Expected: Session start output with rules injected, no errors

- [ ] **Step 3: Verify MCP server starts**

Run: `echo '{}' | timeout 5 node --no-warnings build/src/index.js 2>&1 || true`
Expected: Server starts without crash (will timeout since no stdin, that's fine)

- [ ] **Step 4: Final commit if any loose changes**

```bash
git status
# If any uncommitted changes:
git add -A && git commit -m "Final verification: all tests pass"
```
