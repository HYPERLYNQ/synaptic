# Changelog

## 1.7.0 — 2026-04-18

### Added
- Background sync writes a rotating logfile at `~/.claude-context/sync/sync.log` (256 KB, one backup at `.log.1`), so silent stalls are diagnosable after the fact instead of disappearing into stderr.
- SyncScheduler fires a fast initial tick ~30 seconds after MCP server start, so short-lived sessions still push/pull instead of waiting for the first 2-minute interval.
- `context_status` MCP tool now reports `lastTickAt`, `lastTickOk`, `lastTickError`, and `isRunning` in its `sync` block.
- `synaptic sync status` CLI prints the last 10 lines of the background tick log.

### Why
A user's machine silently went 18 days without syncing because a swallowed tick exception left no trace. These three additions turn that class of stall from "invisible" into "obvious at a glance."

## 1.6.0 — 2026-04-17

### Changed (breaking)
- Slash commands renamed for consistency (verb-first, checkpoint-suffixed):
  - `/checkpoint <name>` → `/save-checkpoint <name>`
  - `/checkpoints` → `/list-checkpoints`
  - `/load <name>` → `/load-checkpoint <name>`
- Internal `UserPromptSubmit` hook still matches the literal `/checkpoint` text emitted by the slash-command body, so auto-save behavior is unchanged.

## 1.5.0 — 2026-04-16

### Added
- New `checkpoint` entry type: named, pinnable, loadable save points.
- `/load <name>` — inject a checkpoint and its references into the current conversation.
- `/checkpoints` — list recent checkpoints for the current project.
- `context_load` MCP tool.
- Project-aware SessionStart recall (ranked by content quality, project match, pinned, recency).
- PostToolUse auto-checkpoints now save as `checkpoint` type (was `handoff`), with name derived from commit subject or plan/spec filename.
- UserPromptSubmit auto-checkpoints now save as `checkpoint` type.
- `SYNAPTIC_HOME` env var support in `src/storage/paths.ts` for test isolation (defaults to `$HOME` — zero production behavior change).

### Changed
- Stop hook only writes a handoff when the session had at least one meaningful event (commit, checkpoint, decision, or plan/spec write) and the derived narrative is ≥100 chars. Eliminates content-less aggregation handoffs that crowded out real ones.
- All new entries record `projectRoot` at save time.

### Migration
- Run `npm run migrate:v1.5.0 -- --dry-run` first to preview, then `npm run migrate:v1.5.0` to:
  - Backfill `projectRoot` on existing entries via tag heuristics (rtx-5090-tracker, synaptic, ...)
  - Archive legacy empty-count handoffs (content < 100 chars)
  - Convert v1.4.0 slash-command auto-saves from `handoff` to `checkpoint`
