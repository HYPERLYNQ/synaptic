# Changelog

## 1.7.5 — 2026-04-21

### Fixed
- `context_list` tool now returns a pre-computed `timeAgo` string per checkpoint (e.g. `"1h ago"`, `"yesterday"`, `"in the future"`). The `/list-checkpoints` slash command now renders this verbatim instead of doing its own math against `createdAtUtc`. v1.7.4 emitted a correct `createdAtUtc` but the agent's own "X ago" arithmetic was still mis-rendering short durations as "yesterday", for reasons that look like a cached notion of "now" on the agent side. Pre-computing server-side sidesteps it entirely.
- `timeAgo` reports `"in the future"` instead of silently producing a negative duration when a pre-1.7.4 entry has a mis-stored date/time pair that derives to a future timestamp.

### Notes
- 9 new tests in `tests/tools/time-ago-label.test.ts` cover just-now, minutes, hours, yesterday-semantics, multi-day, past-7d fallback, future timestamps, and unparseable input.

## 1.7.4 — 2026-04-21

### Fixed
- `formatDate()` used UTC while `formatTime()` used local tz, producing date/time pairs that diverged whenever an entry was created during the few hours when local is "yesterday evening" but UTC has rolled to "tomorrow". Concretely: a checkpoint created at 22:36 EDT (02:36 UTC next day) was stored as `date=2026-04-21` + `time=22:36`, a fictional future wall time. `/list-checkpoints` rendered that as "~22h ago". Now both functions use local tz, so the pair is always internally consistent, and `createdAtUtc` (added in 1.7.3) derives a correct UTC timestamp from it.

### Notes
- This completes the time-display fix started in 1.7.3. 1.7.3 shipped `createdAtUtc` as a derived field but it was computed from the already-broken `date`+`time` pair, so it inherited the same inconsistency. Entries created by any 1.7.4 machine are internally coherent going forward. Pre-1.7.4 entries with divergent pairs stay as-is (cosmetic only — data is intact).

## 1.7.3 — 2026-04-21

### Fixed
- **Sync was silently dropping `projectRoot`, `name`, `summary`, and `referencedEntryIds`** from entries as they crossed between machines. The `SyncableEntry` wire format only carried the original pre-v1.5 column set; the `name` and `projectRoot` columns added for checkpoints in v1.5 were never added to the serializer. On receiving machines, synced checkpoints arrived with `project_root=NULL`, which meant `listCheckpoints` (and `/list-checkpoints`) filtered them all out because it scopes by `project_root = <current cwd>`. Result: cross-machine checkpoints were invisible.
- `context_list` tool now returns `name`, `summary`, `projectRoot`, and an ISO8601 UTC `createdAtUtc` on each entry. Previously it stripped these fields before returning to the agent, which forced `/list-checkpoints` to synthesize display names from content substrings and guess relative times from timezone-naive `date`+`time` strings.
- `/list-checkpoints` slash command is now instructed to use `createdAtUtc` for relative-time calculations instead of reconstructing a timestamp from the local-tz `date`+`time` pair, which was producing wildly wrong "X hours ago" values across machines in different timezones.

### Compatibility
- Pre-v1.7.3 entries already in a sync repo will still arrive with the new fields missing; receivers tolerate them as undefined. Once any machine in the sync group upgrades to v1.7.3, newly created entries from that machine will carry full fidelity. No migration required.
- Wire format remains forward and backward compatible: older readers ignore the new optional fields, newer readers treat them as optional.

## 1.7.2 — 2026-04-18

### Fixed
- CLI and MCP server now exit early with a clear, actionable error when a Windows-installed synaptic is executed under WSL, instead of crashing deep inside a native dependency with "Could not load the sharp module using the linux-x64 runtime". The guard fires when `process.platform === 'linux'` and the script path starts with `/mnt/<drive>/`, and tells the user to run `npm install -g @hyperlynq/synaptic` inside WSL. Windows-native and Linux-native installs are unaffected.

## 1.7.1 — 2026-04-18

### Fixed
- Plugin installer no longer fails on Windows with `spawnSync npm.cmd EINVAL`. Node 18.20.2+ / 20.12.2+ (CVE-2024-27980 mitigation) requires `shell: true` when spawning `.cmd`/`.bat` files. Passing args are static literals so there is no injection risk.

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
