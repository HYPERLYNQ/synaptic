# Synaptic

**Give Claude a memory that lasts.**

Every time you start a new Claude Code session, Claude has amnesia — it doesn't know what you worked on yesterday, what decisions you made, or what bugs you ran into. Synaptic fixes that. It's a local plugin that saves context across sessions, so Claude picks up where you left off.

Everything runs on your machine. No cloud services, no API keys, no data sent anywhere.

---

## The Problem

Imagine you spend an hour with Claude debugging a tricky authentication issue. You figure out the fix, close the terminal, and come back the next day. Claude has no idea any of that happened. You explain the same context again, maybe even hit the same dead ends.

Synaptic solves this by automatically saving what Claude learns during each session and feeding it back at the start of the next one.

## How It Works

Synaptic runs as an **MCP server** — that's the standard way to give Claude extra capabilities. Think of it like a plugin. Once installed, Claude gets access to tools for saving and retrieving memories, and three things happen automatically:

1. **When Claude starts** — It receives a briefing: recent context, your rules, any recurring problems, what you were working on last
2. **During the session** — Claude can save decisions, insights, and progress as it works
3. **When Claude finishes** — A handoff note is saved summarizing what happened, so the next session has context

All the data lives in a SQLite database on your machine. Search works two ways: keyword matching (like `ctrl+F`) and semantic similarity (finding entries that *mean* similar things, even if they use different words).

---

## Getting Started

### What You Need

- **Node.js 22 or newer** — Synaptic uses Node's built-in SQLite support, which was added in v22
- **Claude Code** — The CLI tool from Anthropic (not the web chat)

### Installation

```bash
# 1. Clone the project
git clone <repo-url> synaptic
cd synaptic

# 2. Install dependencies
npm install

# 3. Build (compiles TypeScript to JavaScript)
npm run build

# 4. Set everything up automatically
npx synaptic init
```

That last command detects your environment and configures Claude Code to use Synaptic. It works on Linux, macOS, and WSL (Windows Subsystem for Linux).

Here's what `init` does:
- Registers Synaptic as an MCP server so Claude can use its tools
- Installs three hooks so Claude automatically loads/saves context
- Sets up a git pre-commit hook that captures test failures into memory
- Creates a `.synaptic/` directory in your project

If you only want the server and hooks (no git hook, no project dir):

```bash
npx synaptic init --global
```

### Manual Setup (if you prefer)

Add this to your `~/.claude/settings.json`:

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

Replace `/path/to/synaptic/` with the actual path where you cloned the project.

---

## What Claude Can Do With Synaptic

Once installed, Claude gets 14 tools organized into four groups.

### Saving and Finding Context

| Tool | What It Does |
|------|-------------|
| `context_save` | Save something to memory — a decision, a bug you found, a learning, etc. |
| `context_search` | Search memory using keywords or natural language |
| `context_list` | Browse recent entries by date or type |
| `context_status` | See how much is stored — entry count, database size, etc. |

### Keeping Things Organized

| Tool | What It Does |
|------|-------------|
| `context_archive` | Hide old entries you don't need anymore |
| `context_save_rule` | Create a rule Claude must always follow (e.g., "never auto-commit") |
| `context_delete_rule` | Remove a rule |
| `context_list_rules` | See all active rules |

### Understanding Your Git History

| Tool | What It Does |
|------|-------------|
| `context_git_index` | Import git commits into searchable memory |
| `context_cochanges` | Find files that tend to change together ("when you edit A, you usually also edit B") |
| `context_dna` | Generate a profile of your codebase — what files are hotspots, how the code is structured |

### Tracking Threads and Sessions

| Tool | What It Does |
|------|-------------|
| `context_session` | See what happened in a specific session |
| `context_chain` | Follow a thread of related entries (a decision and its consequences) |
| `context_resolve_pattern` | Mark a recurring problem as fixed so it stops being flagged |

---

## Key Concepts

### Entry Types

When Claude saves something to memory, it gives it a type:

| Type | When to Use | How Long It Lasts |
|------|------------|------------------|
| **decision** | "We chose X because Y" | Weeks (working tier) |
| **progress** | "Finished implementing the auth flow" | Days (ephemeral tier) |
| **issue** | "Tests fail when run in parallel" | Weeks (working tier) |
| **insight** | "This API returns dates in UTC, not local time" | Weeks (working tier) |
| **reference** | "The project uses tabs, not spaces" | Forever (longterm tier) |
| **handoff** | "Here's what I was doing when the session ended" | Days (ephemeral tier) |
| **rule** | "Always run tests before committing" | Forever (longterm tier) |

### Memory Tiers (How Long Things Last)

Not everything needs to be remembered forever. Synaptic uses three tiers:

- **Ephemeral** — Short-lived. Auto-cleaned after ~4 days of no access. Good for progress updates and handoffs.
- **Working** — Medium-term. Auto-cleaned after ~14 days of no access. Entries that get searched often survive longer automatically.
- **Longterm** — Permanent. Never auto-cleaned. For rules, references, and project conventions.

### Decision Chains

Sometimes a decision leads to consequences that lead to more decisions. Chains let you track these narratives:

```
1. Decision: "Use SQLite for persistence"
   ↓
2. Issue: "SQLite WAL mode conflicts with WSL file locking"
   ↓
3. Decision: "Switch to journal_mode=DELETE for WSL compatibility"
```

Claude links these with a chain tag (like `chain:a1b2c3d4`). Later, anyone can pull up the full story with `context_chain`.

---

## Features In Detail

### Smart Search

Search isn't just keyword matching. Every memory entry gets converted into a mathematical representation (an "embedding") that captures its meaning. When you search for "authentication problems," it also finds entries about "login failures" or "JWT token expiry" — even if those exact words weren't used.

The embeddings are generated locally using a small model from Hugging Face. Nothing is sent to the internet.

### Codebase DNA

Run `context_dna` and Claude analyzes your git history to build a profile:

- **Hotspots** — Which files get changed most often? These are the core of your project.
- **Layers** — How is work distributed? (e.g., 40% in `tools/`, 30% in `storage/`)
- **Patterns** — Do you use commit prefixes like `feat:` and `fix:`? What's the average commit size?
- **Clusters** — Which files always change together? (If you edit `auth.ts`, do you always also edit `auth.test.ts`?)

This profile is saved as a longterm reference that Claude can look up when making architectural decisions.

### Pre-Commit Guardian

If you ran `npx synaptic init`, a git pre-commit hook watches your commits. Before each commit, it runs your project's lint, typecheck, and test scripts (whatever is defined in `package.json`).

- **On failure:** The error is saved to memory with file and chain tags. Claude will know about it next session.
- **On success:** If there were recent failures for the same files, a resolution entry is saved, creating a "failure -> fix" narrative.

Over time, this builds up a history of which files cause problems and how they get resolved.

### Watch Mode

A background file watcher runs inside the MCP server process. It watches your `.git/` directory for:
- Branch switches
- New commits

When something changes, it auto-indexes after a short delay. No separate process to manage — it starts and stops with Claude.

### Session-Start Briefing

Every time Claude starts, it gets a briefing assembled from:

1. Your rules (always included, never truncated)
2. Recent context from the last 3 days (prioritizing your current project)
3. The last handoff note (what happened at the end of the previous session)
4. Any recurring problem patterns
5. Context related to files you've been changing in git
6. Suggestions about files that tend to co-change

All of this fits within a ~4000 character budget so it doesn't overwhelm the conversation.

---

## Project Structure

```
src/
  cli.ts                    CLI entry point (npx synaptic)
  cli/
    init.ts                 Auto-setup for Claude Code
    pre-commit.ts           Git hook — captures test failures
  hooks/
    session-start.ts        Injects context when Claude starts
    pre-compact.ts          Preserves context before compression
    stop.ts                 Saves handoff when Claude finishes
  storage/
    sqlite.ts               Database (SQLite + full-text search + vectors)
    embedder.ts             Local AI embeddings for semantic search
    watcher.ts              Git event observer
    git.ts                  Git log parser
    markdown.ts             Entry formatting
    maintenance.ts          Auto-cleanup (decay, promotion)
    paths.ts                Where data is stored
    project.ts              Auto-detects which project you're in
    session.ts              Tracks session IDs
  tools/                    The 14 tools Claude can use
    context-save.ts
    context-search.ts
    context-list.ts
    context-status.ts
    context-archive.ts
    context-git-index.ts
    context-cochanges.ts
    context-dna.ts
    context-chain.ts
    context-session.ts
    context-save-rule.ts
    context-delete-rule.ts
    context-list-rules.ts
    context-resolve-pattern.ts
  server.ts                 Registers all tools with the MCP server
  index.ts                  Entry point (starts the server)
```

## Development

```bash
npm run build            # Compile TypeScript to JavaScript
npm run smoke-test       # Build + run all 130 tests
```

## License

All rights reserved. This source code is provided for personal use only. You may not copy, modify, distribute, or create derivative works without explicit written permission from the author.
