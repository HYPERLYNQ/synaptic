---
description: List recent checkpoints (project-scoped)
---

Call the `context_list` MCP tool with arguments:
- `type: "checkpoint"`
- `limit: 10`
- `projectRoot: <current git toplevel, or cwd if not in a repo>`

The tool returns entries with these fields per row:
- `name` — human-readable checkpoint name
- `summary` — one-line description, if set
- `timeAgo` — pre-computed relative-time label ("5min ago", "1h ago",
  "yesterday", "3d ago", "in the future"). Use this VERBATIM. Do not
  recompute from other timestamp fields. Server-side computation
  sidesteps agent-side time arithmetic bugs.
- `createdAtUtc` — ISO8601 UTC timestamp. Only use if you need the exact
  moment for some reason; prefer `timeAgo` for display.
- `content` — full checkpoint body (fallback only; prefer `name` + `summary`
  when rendering a list)

Present the result as a numbered list, showing for each checkpoint:
- name (fall back to the first line of content if name is missing — only
  true for pre-v1.7.3 entries that crossed the sync boundary)
- summary (if set)
- `timeAgo` verbatim (e.g. "1h ago", "yesterday"), do NOT recompute

If no checkpoints match, say: "No checkpoints yet for this project. Use `/save-checkpoint <name>` or say 'save progress' to create one."
