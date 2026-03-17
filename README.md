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

[![Version](https://img.shields.io/badge/version-0.9.9-blue)](https://github.com/HYPERLYNQ/synaptic/releases)
[![npm](https://img.shields.io/npm/v/@hyperlynq/synaptic)](https://www.npmjs.com/package/@hyperlynq/synaptic)
[![Tests](https://img.shields.io/badge/tests-175%20passing-brightgreen)](https://github.com/HYPERLYNQ/synaptic)
[![Node](https://img.shields.io/badge/node-22%2B-339933)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-source--available-orange)](LICENSE)

[Getting Started](#getting-started) · [Features](#features) · [How It Works](#how-it-works) · [Enterprise](#enterprise)

</div>

<br>

Every time you start a new Claude Code session, Claude doesn't remember what you worked on yesterday, what decisions you made, or what bugs you hit.

Synaptic gives Claude a **persistent memory** that carries across sessions. Decisions, insights, bug fixes, project patterns — saved locally and surfaced automatically when Claude starts up.

No cloud dependencies. No API keys. Everything stays on your machine — with optional GitHub sync across your own devices.

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
| Auto-capture | None | None | Semantic anchors capture preferences, decisions, debugging patterns |
| Fact extraction | None | None | Structural parsing + LLM synthesis of tool output |
| Rule enforcement | None | None | Hard (commit-msg hook) + soft (violation detection) |
| Transcript scanning | None | None | Passively captures from conversation history |
| Predictive context | None | None | Surfaces relevant history at session start |
| Multi-machine sync | None | None | GitHub-based sync across devices |

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
- **Git commit-msg hook** — blocks commits that violate your rules
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

Search is **always hybrid** by default — combining BM25 keyword matching with semantic vector similarity. Searching for "email provider" finds entries about "Cloudflare Email Routing" even if those exact words were never used. Only single-word ID lookups fall back to keyword-only.

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

### Rule Enforcement

Rules aren't just suggestions — Synaptic enforces them at multiple levels:

**Hard enforcement** — A `commit-msg` git hook extracts forbidden patterns from your rules (quoted strings, negative directives like "never add X") and blocks commits that contain violations. The commit is rejected with a clear error showing which rule was broken.

**Soft enforcement** — The stop hook scans the conversation transcript for `git commit` tool calls and checks their messages against rules. Violations are saved as pinned issues.

**Violation surfacing** — At session start, recent violations are shown as warnings above the rules section. Claude sees what it got wrong recently and is reminded to be extra careful.

```
⚠ RECENT RULE VIOLATIONS — you broke these rules recently, be extra careful:
- Rule "no-co-author": commit message contained "Co-Authored-By" (today)
```

<br>

### Memory Tiers

Not everything lasts forever. Synaptic manages it for you:

| Tier | Lifespan | Best For |
|:-----|:---------|:---------|
| **Ephemeral** | 7-21 days | Progress updates, handoffs |
| **Working** | 21-90 days | Decisions, bugs, insights |
| **Longterm** | Forever | Rules, references, conventions |

Entries that get searched often survive longer automatically. Unused ephemeral entries decay after 7 days; frequently accessed ones last up to 21. Working entries idle for 21-90 days demote to ephemeral.

<br>

### Proactive Intelligence

Synaptic doesn't just store what Claude explicitly saves — it **captures what Claude misses**.

**Semantic Capture** — Every message in the conversation is embedded and classified against 6 semantic anchors (rules, preferences, recommendations, corrections, standards, debugging). Regex signal detection provides a confidence boost. This means natural language like "keep design consistent," "that looks terrible," or "I recommend Cloudflare" is captured automatically — no template matching required.

**Directive Detection** — User messages that express rules or standards ("always use tabs," "never auto-commit") are automatically flagged as pending rule proposals when both semantic anchors and signal words agree. Deduplicated against existing rules.

**Debugging Patterns** — Trial-and-error sequences (errors followed by resolutions) are detected and saved as longterm insights. When Claude tries something that fails before finding the fix, the entire pattern is preserved so the same mistakes aren't repeated across sessions.

**Predicted Focus** — At session start, Synaptic analyzes your current git branch, uncommitted files, and last session's handoff to predict what you're about to work on. It surfaces the 2-3 most relevant past entries automatically.

**Consolidation Engine** — Duplicate entries about the same topic are automatically merged during maintenance. The highest-access entry survives with merged tags; the rest are archived. Keeps your memory clean without losing information.

**Handoff Access Bumps** — Entries important enough to appear in session handoffs get their access counts incremented, making them survive longer in the decay system. Important memories are self-reinforcing.

<br>

### Hybrid Fact Extraction

The transcript scanner can't reason about raw tool output — database query results, error traces, CLI output. Synaptic solves this with a **3-layer extraction pipeline** that runs automatically at the end of every session:

**Layer 1: Structural Parsing** — Pattern-matches known output shapes from tool results with zero dependencies. Detects Python dicts (model fields), SQL table schemas, AttributeError/KeyError messages, route/auth patterns, environment variables, and Docker commands. Runs instantly on every session.

**Layer 2: Semantic Classification** — The existing anchor template system with dedicated `discovery` and `credentials` categories that catch schema revelations and credential references in conversation.

**Layer 3: LLM Synthesis** — Sends Layer 1 snippets to Claude Haiku for intelligent fact extraction. Produces structured facts categorized as `schema`, `credentials`, `route`, `config`, `architecture`, or `behavior`. Saved as longterm reference entries with vector deduplication.

Facts like *"User model has `name` not `username`"* or *"seed user is demo@example.com"* that would otherwise be lost between sessions are now captured automatically.

**Security hardened:**
- Credential values are redacted before leaving your machine (env vars, Docker `-e` flags, Dockerfile `ENV`/`ARG` instructions, Python dict values)
- LLM prompt explicitly instructs never to include actual credential values
- Tool output is wrapped in XML delimiters with content escaping to mitigate prompt injection
- OAuth tokens use proper `Authorization: Bearer` headers

**Zero configuration** — uses your existing Claude Code subscription (OAuth token from `~/.claude/.credentials.json`). Falls back gracefully if no token is available. Costs ~$0.001 per session via Haiku.

<br>

### Watch Mode

A background watcher observes your `.git/` directory for branch switches and new commits. Changes are auto-indexed after a 2-second debounce. Starts and stops with the MCP server — nothing extra to manage.

<br>

### Cross-Machine Sync

Use Synaptic on multiple machines? Sync your context between them via a private GitHub repo.

```bash
synaptic sync init          # One-time setup — creates private repo, generates machine ID
synaptic sync now           # Push & pull immediately
synaptic sync status        # Show machines, last sync times
```

Each machine writes to its own append-only JSONL file — no merge conflicts. Entry IDs are globally unique, so dedup is automatic. Embeddings are regenerated locally on each machine.

Sync also runs automatically:
- **Session start** — pulls new entries from other machines
- **Session end** — pushes your new entries
- **Background** — push/pull every 2 minutes while the MCP server is running

Requires the `gh` CLI (already installed for most developers). All data flows through your own private GitHub repo — nothing touches third-party servers.

<br>

---

<br>

## How It Works

Synaptic runs as an **MCP server** — the standard way to extend Claude with new capabilities.

Three hooks handle the lifecycle automatically:

```
┌──────────────────────────────────────────────────────────────┐
│                                                              │
│   START ────→  Injects rules, violation warnings,            │
│                predicted focus, recent context                │
│                                                              │
│   WORK ─────→  Claude saves and searches context             │
│                Git watcher auto-indexes in background         │
│                                                              │
│   COMPRESS ─→  Preserves important context before            │
│                conversation is compressed                     │
│                                                              │
│   END ──────→  Semantic transcript scan                      │
│                Hybrid extraction (structural → LLM)          │
│                Directive detection, debugging patterns        │
│                Handoff summary, rule violation checks         │
│                                                              │
└──────────────────────────────────────────────────────────────┘
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
- Cross-machine sync via GitHub

</td>
<td width="50%">

### Team & Enterprise
**Coming soon**

- Shared context across team members
- Team rules and conventions
- Analytics dashboard
- Priority support
- Custom integrations

</td>
</tr>
</table>

<br>

Interested in Synaptic for your team? **[Get in touch →](mailto:hyperlynq@gmail.com)**

<br>

---

<br>

## Development

```bash
npm run build            # Compile TypeScript
npm run smoke-test       # Build + run all 175 tests
```

<br>

## License

Copyright (c) 2026 HYPERLYNQ. All rights reserved.

Synaptic is **source-available**. You can use it freely for personal and internal purposes. You may not copy, modify, redistribute, or create derivative works from the source code. See [LICENSE](LICENSE) for details.

For commercial licensing, contact **[hyperlynq@gmail.com](mailto:hyperlynq@gmail.com)**.

<br>

---

<div align="center">

**Built by [HYPERLYNQ](https://github.com/HYPERLYNQ)**

</div>
