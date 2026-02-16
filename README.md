<div align="center">

```
 ███████╗██╗   ██╗███╗   ██╗ █████╗ ██████╗ ████████╗██╗ ██████╗
 ██╔════╝╚██╗ ██╔╝████╗  ██║██╔══██╗██╔══██╗╚══██╔══╝██║██╔════╝
 ███████╗ ╚████╔╝ ██╔██╗ ██║███████║██████╔╝   ██║   ██║██║
 ╚════██║  ╚██╔╝  ██║╚██╗██║██╔══██║██╔═══╝    ██║   ██║██║
 ███████║   ██║   ██║ ╚████║██║  ██║██║        ██║   ██║╚██████╗
 ╚══════╝   ╚═╝   ╚═╝  ╚═══╝╚═╝  ╚═╝╚═╝        ╚═╝   ╚═╝ ╚═════╝
```

### Persistent memory for Claude Code

**Claude forgets everything between sessions. Synaptic fixes that.**

[![Version](https://img.shields.io/badge/version-0.7.0-blue)](https://github.com/HYPERLYNQ/synaptic)
[![Tests](https://img.shields.io/badge/tests-147%20passing-brightgreen)](https://github.com/HYPERLYNQ/synaptic)
[![Node](https://img.shields.io/badge/node-22%2B-339933)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-source--available-orange)](LICENSE)

[Getting Started](#getting-started) · [Features](#features) · [How It Works](#how-it-works) · [Enterprise](#enterprise)

</div>

<br>

Every time you start a new Claude Code session, Claude doesn't remember what you worked on yesterday, what decisions you made, or what bugs you hit.

Synaptic gives Claude a **persistent memory** that carries across sessions. Decisions, insights, bug fixes, project patterns — saved locally and surfaced automatically when Claude starts up.

No cloud. No API keys. Everything stays on your machine.

<br>

---

<br>

## Why Not Just Use Claude's Built-In Memory?

Claude Code already has a few memory features. Here's how Synaptic is different.

<br>

### CLAUDE.md

`CLAUDE.md` is a file you write by hand with project instructions. Claude reads it at the start of each session. It's great for static rules like "use tabs" or "run pytest."

But it doesn't capture anything that happens *during* a session — the bugs you found, the decisions you made, the dead ends you explored. When you close the terminal, all of that is gone.

<br>

### Auto-Compacting

When Claude runs out of context window, it compresses the conversation to make room. This loses detail and nuance.

Synaptic's **PreCompact hook** runs *before* compression happens. It saves the important parts to permanent storage. After compacting, Claude still has access to what mattered.

<br>

### Auto-Memory

Claude's auto-memory (`~/.claude/memory/`) saves short notes to files. But there's no real search, no semantic understanding, no awareness of which notes are related, and no way for old notes to expire naturally. It's a flat list that grows forever.

<br>

### The Comparison

| | CLAUDE.md | Auto Memory | **Synaptic** |
|:---|:---|:---|:---|
| What it stores | Static instructions | Short notes | Typed, tagged, tiered entries |
| Search | None | Filename only | Keyword + semantic similarity |
| Cross-session | Only what you manually write | Basic notes | Handoffs, chains, failure history |
| Git awareness | None | None | Commits, co-changes, codebase DNA |
| Memory cleanup | Manual | Grows forever | Auto-decay by tier |
| Pattern detection | None | None | Tracks recurring failures |
| Auto-capture | None | None | Detects declarations, preferences, corrections |
| Predictive context | None | None | Surfaces relevant history at session start |

<br>

**Synaptic doesn't replace `CLAUDE.md`** — it complements it. Use `CLAUDE.md` for static project instructions. Use Synaptic for the living, evolving knowledge that builds up as you work.

<br>

---

<br>

## Getting Started

### What You Need

- **Node.js 22+** — uses Node's built-in SQLite
- **Claude Code** — Anthropic's CLI tool

<br>

### Install

```bash
npx @hyperlynq/synaptic init
```

That's it. The `init` command auto-detects your environment (Linux, macOS, WSL) and configures everything:

- **MCP server** — so Claude can use Synaptic's tools
- **3 lifecycle hooks** — auto-load on start, preserve on compress, save on stop
- **Git pre-commit hook** — captures test/lint failures into memory
- **Project directory** — `.synaptic/` for local config

> Skip git hook and project dir with `npx synaptic init --global`

<br>

<details>
<summary><strong>Install from source</strong></summary>

<br>

```bash
git clone https://github.com/HYPERLYNQ/synaptic.git
cd synaptic
npm install
npm run build
npx synaptic init
```

</details>

<br>

<details>
<summary><strong>Manual MCP setup</strong></summary>

<br>

Add to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "synaptic": {
      "command": "node",
      "args": ["--no-warnings", "/path/to/synaptic/build/src/index.js"],
      "type": "stdio"
    }
  }
}
```

</details>

<br>

---

<br>

## Features

### 14 Tools for Claude

<table>
<tr>
<td width="50%">

**Memory**
| Tool | Purpose |
|:-----|:--------|
| `context_save` | Save decisions, bugs, insights |
| `context_search` | Keyword + semantic search |
| `context_list` | Browse by date or type |
| `context_status` | Storage stats |

</td>
<td width="50%">

**Organization**
| Tool | Purpose |
|:-----|:--------|
| `context_archive` | Hide old entries |
| `context_save_rule` | Create permanent rules |
| `context_delete_rule` | Remove rules |
| `context_list_rules` | List active rules |

</td>
</tr>
<tr>
<td>

**Git Intelligence**
| Tool | Purpose |
|:-----|:--------|
| `context_git_index` | Index commits into memory |
| `context_cochanges` | Files that change together |
| `context_dna` | Profile your codebase |

</td>
<td>

**Threads & Sessions**
| Tool | Purpose |
|:-----|:--------|
| `context_session` | View session history |
| `context_chain` | Trace decision threads |
| `context_resolve_pattern` | Dismiss recurring alerts |

</td>
</tr>
</table>

<br>

### Smart Search

Every entry gets a 384-dimensional embedding generated **locally** using a Hugging Face model.

Search combines keyword matching with semantic similarity — searching for "auth problems" also finds entries about "login failures" and "JWT expiry," even if those exact words were never used.

Nothing is sent to the internet. Ever.

<br>

### Codebase DNA

One command analyzes your git history and builds a profile:

```
Codebase DNA (myapp, 100 commits analyzed):
Hotspots: sqlite.ts (45%), session-start.ts (30%)
Layers: tools/ (35%), storage/ (30%), hooks/ (25%), cli/ (10%)
Patterns: 60% feat, 25% fix, 15% chore. Avg 3.2 files/commit.
Clusters: [sqlite.ts + embedder.ts + server.ts]
```

- **Hotspots** — Your most-changed files
- **Layers** — Where work concentrates
- **Patterns** — Your commit habits
- **Clusters** — Files that always change together

Saved permanently so Claude can reference it during architectural decisions.

<br>

### Pre-Commit Guardian

Runs your lint, typecheck, and test scripts before each commit.

**When something fails** — the error is saved with file tags and a chain ID. Claude knows about it next session.

**When everything passes** — if those files recently failed, a resolution entry is saved. Over time, this builds traceable **failure → fix** narratives.

<br>

### Decision Chains

Track how decisions evolve:

```
Decision: "Use SQLite for persistence"
    ↓
Issue: "SQLite WAL mode conflicts with WSL file locking"
    ↓
Decision: "Switch to journal_mode=DELETE for WSL compatibility"
```

Every entry in a chain shares a tag. Pull up the full story anytime with `context_chain`.

<br>

### Rules

Permanent instructions injected every session. Tell Claude how to behave, forever:

```
context_save_rule(
  label: "preserve-bug-fixes",
  content: "Bug fixes and debugging techniques should be saved
    as longterm entries. They have cross-project value and
    should never auto-decay."
)
```

More examples: `"never auto-commit"` · `"use bun instead of npm"` · `"always write tests first"`

<br>

### Memory Tiers

Not everything lasts forever. Synaptic manages it for you:

| Tier | Lifespan | Best For |
|:-----|:---------|:---------|
| **Ephemeral** | ~4 days | Progress updates, handoffs |
| **Working** | ~14 days | Decisions, bugs, insights |
| **Longterm** | Forever | Rules, references, conventions |

Entries that get searched often survive longer automatically.

<br>

### Proactive Intelligence

Synaptic doesn't just store what Claude explicitly saves — it **captures what Claude misses**.

**Intent Classification** — The stop hook scans each session for declarations, preferences, identities, and frustrations using semantic similarity against intent templates. If you say "X is my project" or "I prefer bun over npm," Synaptic auto-captures it as a longterm reference without you asking.

**Predicted Focus** — At session start, Synaptic analyzes your current git branch, uncommitted files, and last session's handoff to predict what you're about to work on. It surfaces the 2-3 most relevant past entries automatically.

**Consolidation Engine** — Duplicate entries about the same topic are automatically merged during maintenance. The highest-access entry survives with merged tags; the rest are archived. Keeps your memory clean without losing information.

**Handoff Access Bumps** — Entries important enough to appear in session handoffs get their access counts incremented, making them survive longer in the decay system. Important memories are self-reinforcing.

<br>

### Watch Mode

A background watcher observes your `.git/` directory for branch switches and new commits. Changes are auto-indexed after a 2-second debounce. Starts and stops with the MCP server — nothing extra to manage.

<br>

---

<br>

## How It Works

Synaptic runs as an **MCP server** — the standard way to extend Claude with new capabilities.

Three hooks handle the lifecycle automatically:

```
┌─────────────────────────────────────────────────────┐
│                                                     │
│   START ──→  Injects rules, predicted focus,        │
│              recent context, last handoff            │
│                                                     │
│   WORK ───→  Claude saves and searches context      │
│              Git watcher auto-indexes in background  │
│                                                     │
│   COMPRESS →  Preserves important context before     │
│               conversation is compressed             │
│                                                     │
│   END ────→  Saves handoff, detects corrections,    │
│              auto-captures declarations/preferences  │
│                                                     │
└─────────────────────────────────────────────────────┘
```

Data is stored in SQLite with full-text search and vector similarity search. All local.

<br>

---

<br>

## Enterprise

<table>
<tr>
<td width="50%">

### Personal
**Free — always**

- All 14 tools
- Unlimited entries
- Local-only storage
- Full search
- Git intelligence
- Pre-commit guardian

</td>
<td width="50%">

### Team & Enterprise
**Coming soon**

- Shared context across team members
- Cloud sync between machines
- Team rules and conventions
- Analytics dashboard
- Priority support
- Custom integrations

</td>
</tr>
</table>

<br>

Interested in Synaptic for your team? **[Get in touch →](mailto:hyperlynq@outlook.com)**

<br>

---

<br>

## Development

```bash
npm run build            # Compile TypeScript
npm run smoke-test       # Build + run all 147 tests
```

<br>

## License

Copyright (c) 2026 HYPERLYNQ. All rights reserved.

Synaptic is **source-available**. You can use it freely for personal and internal purposes. You may not copy, modify, redistribute, or create derivative works from the source code. See [LICENSE](LICENSE) for details.

For commercial licensing, contact **[hyperlynq@outlook.com](mailto:hyperlynq@outlook.com)**.

<br>

---

<div align="center">

**Built by [HYPERLYNQ](https://github.com/HYPERLYNQ)**

</div>
