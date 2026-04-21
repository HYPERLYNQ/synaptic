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
- `createdAtUtc` — ISO8601 UTC timestamp. ALWAYS use this for relative-time
  ("2h ago") calculations. Do NOT reconstruct from `date` + `time` — those
  are stored in the creating machine's local timezone and cannot be compared
  reliably across machines.
- `content` — full checkpoint body (fallback only; prefer `name` + `summary`
  when rendering a list)

Present the result as a numbered list, showing for each checkpoint:
- name (fall back to the first line of content if name is missing — only
  true for pre-v1.7.3 entries that crossed the sync boundary)
- summary (if set)
- relative timestamp derived from `createdAtUtc` (e.g. "2h ago", "yesterday")

If no checkpoints match, say: "No checkpoints yet for this project. Use `/save-checkpoint <name>` or say 'save progress' to create one."
