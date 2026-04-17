---
description: Load a saved checkpoint into current context
---

Call the `context_load` MCP tool with `name` equal to the argument that follows `/load`.

If the tool returns `checkpoint != null`, inject into the conversation:

## Loaded checkpoint: <name>
_Saved <date> from <projectRoot>_

<content>

### Referenced entries
- [<id>] (<type>, <date>): <contentPreview>
...

Cap total injected content at ~4000 tokens. Truncate the references list first; if the narrative itself exceeds the cap, truncate it with a note.

If `checkpoint == null` and `candidates.length > 0`, list the candidates and ask the user to run `/load <exact-name>`.

If `checkpoint == null` and `candidates.length == 0`, reply: "No checkpoint matched `<name>`. Try `/checkpoints` to list recent ones."
