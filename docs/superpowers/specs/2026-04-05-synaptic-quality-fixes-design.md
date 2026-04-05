# Synaptic Quality Fixes — Design Spec

**Date:** 2026-04-05
**Status:** Approved
**Builds on:** 2026-03-31-smart-cleanup-intelligent-search-design.md (Tasks 2-7 incomplete)

## Problem Statement

Synaptic has five compounding quality issues that make it unreliable:

1. **Search returns irrelevant results** — Searching "lynq beats progress" returns I: drive sorting scripts and Ollama discussions. The concept-hit scoring in `hybridSearch()` is weighted too low (0.5) vs single-pass BM25 fallback, letting generic keyword matches outrank project-specific content.

2. **Massive pending_rule duplication** — The same correction (e.g., "hero logo sizing") is saved 15+ times as `pending_rule` entries because multiple creation paths (stop.ts, pre-compact.ts) lack content-hash dedup and use upsert-or-insert semantics.

3. **Handoffs are useless** — Stop hook generates "Activity: 84 entries across project..." with max 5 learnings truncated to 150 chars. No project-grouped detail, no pending items, no actionable context.

4. **No cleanup CLI** — `smartDedup()` exists but only runs during maintenance at session start. No user-facing command to purge junk on demand.

5. **Auto-recall doesn't trigger** — Claude fails to search Synaptic when users ask about project progress/memory because the rule language is advisory, not mandatory.

## Scope

Six deliverables, ordered by dependency:

1. Data cleanup migration script (one-time)
2. Search scoring rebalance (hybridSearch tuning)
3. Pending rule dedup fix (stop.ts + pre-compact.ts)
4. Handoff generation improvement (stop.ts)
5. Cleanup CLI command (new file)
6. Auto-recall rule enhancement (Synaptic rule update)

## Section 1: Data Cleanup & Migration Script

**New file:** `scripts/migrate-cleanup.ts`

One-time script that runs against the live SQLite database.

### Steps (in order):

#### 1a. Purge duplicate pending_rules

```
- Query all entries with tag "pending_rule"
- Group by proposed-label tag (e.g., "proposed-label:lynq-beats-hero-logo-sizing-is-extremely")
- For each group with 2+ entries: keep the NEWEST entry, archive all others
- Also group by content similarity (cosine >= 0.85) for entries without matching labels
- Archive duplicates, merge tags into survivor
```

#### 1b. Purge useless ephemeral handoffs

```
- Query all entries where type="handoff" AND tier="ephemeral"
- Filter to entries matching: /^Activity: \d+ entries/
- Check if entry has a "Learnings:" section with actual content
- If no learnings section OR all learnings are just truncated "Activity:" references: archive
```

#### 1c. Aggressive smart dedup pass

```
- Call smartDedup({ threshold: 0.80, minAgeDays: 1, dryRun: true })
- Print dry-run report to stdout
- Prompt for confirmation (or --force flag to skip)
- Call smartDedup({ threshold: 0.80, minAgeDays: 1 }) to apply
```

#### 1d. Rebuild FTS5 index

```
- DROP TABLE IF EXISTS entries_fts
- Recreate FTS5 table with same schema
- Repopulate from non-archived entries
- VACUUM the database
```

#### 1e. Print report

```
Before: X total entries (Y archived)
Pending rules purged: N
Empty handoffs purged: N
Smart dedup archived: N
After: X total entries (Y archived)
FTS5 index rebuilt: Z entries indexed
```

### CLI invocation:

```bash
npx tsx scripts/migrate-cleanup.ts [--force] [--dry-run]
```

## Section 2: Search Scoring Rebalance

**Modified file:** `src/storage/sqlite.ts` — `hybridSearch()` method (lines 606-709)

### Problem

Concept-hit score formula: `(conceptHits / totalConcepts) * 0.5`

The `* 0.5` weight means a perfect concept match (all terms hit) only contributes 0.5 to the RRF score, while a single BM25 rank-1 hit contributes `1 / (60 + 0 + 1) = 0.016` and vector rank-1 contributes the same. The concept score SHOULD dominate when query terms match project-specific entries.

### Fix

Change concept-hit scoring:

```typescript
// BEFORE (line ~618):
const conceptScore = (conceptHits / totalConcepts) * 0.5;

// AFTER:
const conceptScore = (conceptHits / totalConcepts) * 1.5;
```

Also boost project match weight:

```typescript
// BEFORE (line ~693):
const projectBoost = (entry.project === currentProject) ? 1.5 : 1.0;

// AFTER:
const projectBoost = (entry.project === currentProject) ? 2.0 : 1.0;
```

### Rationale

- Concept hits (fuzzy multi-pass) are the most reliable signal that an entry is relevant to the query
- Project boost at 2.0 means entries from the same project rank significantly higher
- Combined: a lynq-beats entry matching 2/3 concept terms scores `(2/3) * 1.5 * 2.0 = 2.0`, which dominates any single BM25/vector match

## Section 3: Pending Rule Dedup Fix

**Modified files:** `src/hooks/stop.ts`, `src/hooks/pre-compact.ts`

### Problem

Multiple creation paths create pending_rule entries without cross-checking:
- stop.ts:116-157 (real-time directive detection)
- stop.ts:527-539 (correction detection in handoff)
- pre-compact.ts:78-116 (pre-compact safety net)

Each path does its own vector dedup (cosine >= 0.75) but they can race or overlap across sessions.

### Fix: Content-hash gate + upsert semantics

Add a shared utility function in a new file or in `search-utils.ts`:

```typescript
function contentHash(text: string): string {
  // Normalize: lowercase, collapse whitespace, strip punctuation
  const normalized = text.toLowerCase().replace(/\s+/g, " ").replace(/[^\w\s]/g, "").trim();
  // Simple hash (crypto.createHash is available in Node)
  return crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}
```

Before every pending_rule save in all three paths:

```typescript
// Check for existing pending_rule with same content hash (last 30 days)
const hash = contentHash(msg.text);
const existing = index.list({ days: 30 })
  .filter(e => e.tags.includes("pending_rule") && contentHash(e.content) === hash);

if (existing.length > 0) {
  // Update timestamp of existing entry instead of creating new one
  index.touchEntry(existing[0].id);  // New method: updates date/time to now
  continue;
}
```

### New method: `touchEntry(id)`

Add to `ContextIndex` in sqlite.ts:

```typescript
touchEntry(id: string): void {
  const now = new Date();
  const date = now.toISOString().split("T")[0];
  const time = now.toTimeString().slice(0, 5);
  this.db.prepare("UPDATE entries SET date = ?, time = ? WHERE id = ?").run(date, time, id);
}
```

### Also raise the vector dedup threshold

In stop.ts:142, change `dot >= 0.75` to `dot >= 0.70` to catch more near-dupes.

## Section 4: Handoff Generation Improvement

**Modified file:** `src/hooks/stop.ts` — handoff generation (lines 359-614)

### Problem

Handoffs are terse: "Activity: 84 entries across lynq-beats, synaptic..." with max 5 learnings at 150 chars each. Not enough context for next-session pickup.

### Fix: Project-grouped summaries with more detail

Replace the current handoff content construction (lines 410-425) with:

```typescript
const contentParts: string[] = [];

// Group entries by project
const byProject = new Map<string, ContextEntry[]>();
for (const entry of todayEntries) {
  const proj = entry.project || "general";
  if (!byProject.has(proj)) byProject.set(proj, []);
  byProject.get(proj)!.push(entry);
}

// Per-project summary
for (const [project, entries] of byProject) {
  const typeCounts = new Map<string, number>();
  for (const e of entries) typeCounts.set(e.type, (typeCounts.get(e.type) ?? 0) + 1);
  const typeStr = Array.from(typeCounts.entries())
    .map(([t, c]) => `${t}:${c}`)
    .join(", ");

  contentParts.push(`**${project}** (${entries.length} entries — ${typeStr}):`);

  // Get insights for this project (up to 8, 300 char limit)
  const projectInsights = entries
    .filter(e => e.type === "insight" && !e.tags.includes("pending_rule") && !e.content.startsWith("Activity:"))
    .slice(0, 8);

  for (const insight of projectInsights) {
    const summary = insight.content.length > 300
      ? insight.content.slice(0, 300) + "..."
      : insight.content;
    contentParts.push(`- ${summary}`);
  }

  // List pending items
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

### Changes summary:

| Aspect | Before | After |
|--------|--------|-------|
| Learnings per project | Max 5 total | Max 8 per project |
| Truncation | 150 chars | 300 chars |
| Project grouping | None (flat list) | Grouped by project with type counts |
| Pending items | Not included | Listed if tagged todo/pending/next |

## Section 5: Cleanup CLI Command

**New file:** `src/cli/cleanup.ts`
**Modified file:** `src/cli.ts` (register command)

### Interface

```bash
synaptic cleanup              # Conservative (0.90 threshold, 3+ days)
synaptic cleanup --dry-run    # Show what would be archived
synaptic cleanup --aggressive # Lower threshold (0.80), type-specific
synaptic cleanup --purge-pending-dupes  # Specifically target duplicate pending_rules
```

### Implementation

```typescript
export async function cleanup(opts: {
  dryRun?: boolean;
  aggressive?: boolean;
  purgePendingDupes?: boolean;
}): Promise<void> {
  const index = new ContextIndex();

  // Step 1: Purge duplicate pending_rules (always, unless --dry-run)
  if (opts.purgePendingDupes || true) {
    const pendingRules = index.list({ days: 365 })
      .filter(e => e.tags.includes("pending_rule"));

    // Group by proposed-label tag
    const byLabel = new Map<string, ContextEntry[]>();
    for (const entry of pendingRules) {
      const labelTag = entry.tags.find(t => t.startsWith("proposed-label:")) || "unlabeled";
      if (!byLabel.has(labelTag)) byLabel.set(labelTag, []);
      byLabel.get(labelTag)!.push(entry);
    }

    let purged = 0;
    for (const [label, entries] of byLabel) {
      if (entries.length <= 1) continue;
      // Sort by date desc, keep newest
      entries.sort((a, b) => b.date.localeCompare(a.date));
      const toArchive = entries.slice(1).map(e => e.id);
      if (!opts.dryRun) {
        index.archiveEntries(toArchive);
      }
      purged += toArchive.length;
      console.log(`  ${label}: kept 1, archived ${toArchive.length}`);
    }
    console.log(`Pending rule duplicates: ${purged} archived`);
  }

  // Step 2: Smart dedup
  const threshold = opts.aggressive ? 0.80 : 0.90;
  const typeThresholds = opts.aggressive ? {
    insight: 0.80,
    handoff: 0.82,
    decision: 0.85,
    reference: 0.88,
    progress: 0.80,
  } : undefined;

  const actions = index.smartDedup({
    threshold,
    typeThresholds,
    dryRun: opts.dryRun,
    minAgeDays: opts.aggressive ? 1 : 3,
  });

  // Step 3: Print report
  console.log(`\nSmart dedup: ${actions.length} groups merged`);
  for (const action of actions) {
    console.log(`  Survivor: ${action.survivorId} | Archived: ${action.archivedIds.join(", ")} | Reason: ${action.reason}${action.similarity ? ` (${(action.similarity * 100).toFixed(0)}%)` : ""}`);
  }

  if (opts.dryRun) {
    console.log("\n(dry run — no changes made)");
  }

  // Step 4: Rebuild FTS5 if changes were made
  if (!opts.dryRun && actions.length > 0) {
    index.rebuildFts();  // New method needed
    console.log("FTS5 index rebuilt.");
  }
}
```

### New method: `rebuildFts()`

Add to `ContextIndex` in sqlite.ts:

```typescript
rebuildFts(): void {
  this.db.exec("DELETE FROM entries_fts");
  this.db.exec(`
    INSERT INTO entries_fts(rowid, content, tags, type)
    SELECT rowid, content, tags, type FROM entries WHERE archived = 0
  `);
}
```

### Register in cli.ts

Add `cleanup` to the command registry alongside existing `init`, `sync`, etc.

## Section 6: Auto-Recall Rule Enhancement

**Action:** Update the Synaptic rule via `context_save_rule` to use stronger trigger language.

### Current rule (auto-recall)

Advisory language: "Search when signals suggest prior context exists. SKIP when: generic standalone question..."

### Updated rule

```
# Auto-recall: MANDATORY Synaptic search triggers

You MUST call context_search BEFORE your first response when ANY of these match:

MANDATORY TRIGGERS (no exceptions):
- User mentions ANY known project by name (lynq-beats, wholesale-harmony, field-bridge, fever, machina-muzik, social-studio, amazon-don, synaptic, cinema-storyboard)
- User asks about progress, status, memory, or history ("where did we leave off", "what was done", "progress", "status", "last session")
- User uses continuity language ("continue", "we were", "last time", "that bug", "the issue", "remember", "you said")
- User asks about a past decision ("why did we", "should we still", "what was the approach")
- You are about to say "I don't know" or "I don't have context"

SEARCH STRATEGY:
- Use 2-3 SHORT keyword queries, not long phrases
- Search by project name + topic separately (e.g., "lynq-beats" then "lynq-beats progress")
- Use context_list for full untruncated content if search results are truncated

SKIP ONLY when:
- Generic standalone coding question with no project context
- Self-contained task where user provides ALL context in the message
- User is clearly starting fresh with no implied history
```

### Also update the SessionStart hook output

The hook at `session-start.ts` injects rules into the session context. The auto-recall rule will be updated via `context_save_rule` (not code change — it's a data-level rule). But the hook output format should also include the current project name prominently so Claude knows which project to search for.

## Implementation Order

1. **Migration script** (Section 1) — clean the data first
2. **Search scoring** (Section 2) — immediate search quality improvement
3. **Pending rule dedup** (Section 3) — prevent future duplicates
4. **Cleanup CLI** (Section 5) — give user control (depends on rebuildFts method from Section 1)
5. **Handoff improvement** (Section 4) — better session-end context
6. **Auto-recall rule** (Section 6) — update the rule last, after search actually works

## Files Changed

| File | Change |
|------|--------|
| `scripts/migrate-cleanup.ts` | NEW — one-time migration script |
| `src/storage/sqlite.ts` | MODIFIED — hybridSearch scoring, touchEntry(), rebuildFts() |
| `src/storage/search-utils.ts` | MODIFIED — add contentHash() |
| `src/hooks/stop.ts` | MODIFIED — pending rule dedup gate, handoff generation |
| `src/hooks/pre-compact.ts` | MODIFIED — pending rule dedup gate |
| `src/cli/cleanup.ts` | NEW — cleanup command |
| `src/cli.ts` | MODIFIED — register cleanup command |

## Testing

- Run `test:search` after Section 2 changes — verify concept scoring improvements
- Run `test:cleanup` after Section 5 — verify CLI cleanup works
- Run `scripts/migrate-cleanup.ts --dry-run` before applying migration
- Manual test: search "lynq beats progress" and verify lynq-beats entries rank first
