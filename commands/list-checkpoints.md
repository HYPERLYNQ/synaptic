---
description: List recent checkpoints (project-scoped)
---

Call the `context_list` MCP tool with arguments:
- `type: "checkpoint"`
- `limit: 10`
- `projectRoot: <current git toplevel, or cwd if not in a repo>`

Present the result as a numbered list, showing for each checkpoint:
- name
- summary (if set)
- relative timestamp (e.g. "2h ago", "yesterday")

If no checkpoints match, say: "No checkpoints yet for this project. Use `/save-checkpoint <name>` or say 'save progress' to create one."
