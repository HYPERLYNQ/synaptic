# Phase 3 Design: Memory Intelligence

**Date:** 2026-02-15
**Version:** 0.3.0 target
**Approach:** Foundation-First (Tiers → Decay → Git → Patterns)

## Overview

Phase 3 adds intelligence to Synaptic's memory layer. Four features, delivered in three sub-phases:

- **3a:** 3-Tier Memory Hierarchy + Decay/Consolidation
- **3b:** Git History Indexing
- **3c:** Error Pattern Detection

## Sub-phase 3a: 3-Tier Memory Hierarchy + Decay

### Tiers

Three tiers organize entries by longevity:

| Tier | Purpose | Examples |
|------|---------|----------|
| `ephemeral` | Session noise, short-lived | handoffs, compaction snapshots, progress notes |
| `working` | Active project context | issues, recent decisions, references |
| `longterm` | Stable knowledge | confirmed decisions, insights, recurring patterns |

### Auto-Tiering Rules

| Entry Type | Initial Tier | Promotion Rule | Demotion Rule |
|------------|-------------|----------------|---------------|
| `handoff` | ephemeral | → working if accessed 3+ times | — |
| `progress` | ephemeral | → working if accessed 3+ times | — |
| `issue` | working | → longterm if pattern detected (3c) | → ephemeral after 30 days idle |
| `decision` | working | → longterm after 7 days | → ephemeral after 60 days idle |
| `insight` | working | → longterm after 7 days | → ephemeral after 60 days idle |
| `reference` | longterm | — | — |

### Manual Override

- `context_save` gets optional `tier` parameter
- `pinned` flag — pinned entries never auto-demote

### Schema Changes

```sql
ALTER TABLE entries ADD COLUMN tier TEXT DEFAULT 'working';
ALTER TABLE entries ADD COLUMN access_count INTEGER DEFAULT 0;
ALTER TABLE entries ADD COLUMN last_accessed TEXT;
ALTER TABLE entries ADD COLUMN pinned INTEGER DEFAULT 0;
ALTER TABLE entries ADD COLUMN archived INTEGER DEFAULT 0;
```

### Search Impact

- Tier weighting in hybrid search: longterm 1.5x, working 1.0x, ephemeral 0.5x
- `context_search` gets optional `tier` filter param
- `context_search` and `context_list` get `include_archived` param (default false)

### Session-Start Impact

- Only inject `working` and `longterm` entries
- Ephemeral entries excluded from auto-injection (still searchable)

### Decay Rules

Runs on session-start as a maintenance pass before injecting context.

| Tier | Decay Rule | Action |
|------|-----------|--------|
| ephemeral | Older than 7 days | Archived |
| working | No access in 30 days | Demoted to ephemeral |
| longterm | Never | No auto-decay |
| Any (pinned) | Never | Immune |

"Archived" = `archived = 1`. Excluded from search/list by default. Never deleted.

### Promotion Checks

Also run on session-start:

- Decisions/insights older than 7 days → promote to longterm
- Ephemeral entries accessed 3+ times → promote to working

### Consolidation (Claude-in-the-Loop)

Full consolidation requires LLM summarization. Instead of adding a separate model, we use Claude itself:

1. MCP server clusters `issue`/`decision` entries by cosine similarity (> 0.75) + shared tags
2. Groups of 3+ similar entries become consolidation candidates
3. Session-start hook injects candidates with instructions for Claude to consolidate
4. Claude summarizes, saves consolidated entry as `longterm`, archives originals via `context_archive`

### New Tool: `context_archive`

- Bulk-archive entries by ID list
- Used after consolidation and for manual cleanup

## Sub-phase 3b: Git History Indexing

### Approach

Treat git commits as a new entry type `git_commit` in the existing system. They get embedded, searched, and tiered like any other entry.

### New Entry Type

`git_commit` added to the Zod enum.

### Content Format

```
[branch-name] commit-message
Files: path/to/file1.ts, path/to/file2.ts (+45/-12)
```

### New Tool: `context_git_index`

- Parameters: `repo_path` (optional, defaults to cwd), `days` (default 7), `branch` (default current)
- Runs `git log` to get commits
- Deduplicates by SHA (stored in tags as `sha:<hash>`)
- Creates entries, embeds them, stores in all three layers
- Auto-tiers: commits < 7 days → `working`, older → `ephemeral`

### Session-Start Integration

- Hook calls `git log` for last 24h of current working directory
- Auto-indexes new commits not yet in database
- Skips if no `.git` directory found

### Search Integration

- `context_search` naturally includes git commits (they're entries)
- Optional `type: "git_commit"` filter

## Sub-phase 3c: Error Pattern Detection

### Pattern Engine

When an `issue` entry is saved via `context_save`, the server compares its embedding against existing `issue` entries from the last 30 days. If cosine similarity > 0.75 with 2+ other entries, a pattern is created or updated.

### Schema

```sql
CREATE TABLE patterns (
  id TEXT PRIMARY KEY,
  label TEXT,
  entry_ids TEXT,          -- JSON array
  occurrence_count INTEGER,
  first_seen TEXT,
  last_seen TEXT,
  resolved INTEGER DEFAULT 0
);
```

### Two Surfaces

1. **Search annotation:** Results matching a pattern get `[Pattern: seen N times since DATE]` appended.
2. **Session-start warning:** Unresolved patterns with 3+ occurrences injected as "Recurring Issues" section.

### New Tool: `context_resolve_pattern`

- Mark a pattern as resolved by ID
- Stops surfacing in search and session-start

### Detection Trigger

Runs inside `context_save` when `type === 'issue'`. ~50ms overhead (one vector query).

## Tool Changes Summary

### New Tools

| Tool | Purpose |
|------|---------|
| `context_archive` | Bulk-archive entries by ID list |
| `context_git_index` | Index git commits as entries |
| `context_resolve_pattern` | Mark pattern as resolved |

### Modified Tools

| Tool | Changes |
|------|---------|
| `context_save` | Optional `tier` param; pattern detection on `issue` type |
| `context_search` | Tier weighting (1.5x/1.0x/0.5x), `tier` filter, `include_archived`, pattern annotations |
| `context_list` | `include_archived` param |
| `context_status` | Tier distribution + active pattern count |

### Modified Hooks

| Hook | Changes |
|------|---------|
| `session-start` | Decay pass, promotion checks, consolidation candidates, pattern warnings, git auto-index; filter by tier |

## Migration

- Schema migrations run on server startup (check for column existence before ALTER)
- Existing entries get `tier` assigned by type using auto-tiering rules
- Existing entries get `access_count = 0`, `last_accessed = NULL`, `pinned = 0`, `archived = 0`
- No data loss — purely additive changes
