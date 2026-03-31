# Synaptic v1.0 — Frictionless Install & Sync Fix

## Problem

The current install process is unreliable and multi-step:
- `npx @hyperlynq/synaptic init` doesn't reliably register the MCP server (settings format issues, overwrites by Claude Code on restart)
- Sync requires a separate `sync init` command that users don't discover
- No feedback when things fail silently (empty pulls for >1MB files, model downloads with no progress)
- Config spread across multiple files with different format expectations

## Scope

- Fix the install to be one-command, zero-config
- Fix sync pull bug for large entry files (>1MB)
- Bump to v1.0.0

Out of scope: new features, refactoring internals, non-developer user paths.

## Design

### 1. Default command = init

When user runs `npx @hyperlynq/synaptic` with no args, it runs `init --global`. The `init` subcommand still works explicitly but is no longer required.

**File:** `src/cli.ts`
**Change:** If no command argument is provided, default to `init --global`.

### 2. Bulletproof init flow

The init command does everything in sequence with clear step-by-step output:

```
$ npx @hyperlynq/synaptic

  Setting up Synaptic...

  [1/3] Registering MCP server...     done
  [2/3] Installing lifecycle hooks...  done
  [3/3] Downloading embedding model... done (first run only)

  Setup complete. Restart Claude Code to activate.

  Enable cross-machine sync? (requires GitHub CLI) [y/N] y

  [sync] Checking gh auth...           done
  [sync] Creating sync repo...         done
  [sync] Initial pull...               pulled 1001 entries
  [sync] Background sync enabled (every 2 min)

  All done. Restart Claude Code to start using Synaptic.
```

Steps:
1. Register MCP server in `~/.mcp.json`
2. Install lifecycle hooks in `~/.claude/settings.json`
3. Pre-download the embedding model (~100MB, with progress indication)
4. Prompt for sync setup (only if `gh` CLI is available)
5. Print clear restart instruction

### 3. MCP registration fix

**Problem:** Writing the MCP server config to `~/.claude/settings.json` is unreliable — Claude Code can overwrite it, and the format has changed between versions.

**Fix:** Write the MCP server to `~/.mcp.json` using the `mcpServers` wrapper format. This is the user-level MCP config that Claude Code reads reliably without managing/overwriting.

**Format:**
```json
{
  "mcpServers": {
    "synaptic": {
      "command": "node",
      "args": ["--no-warnings", "/path/to/build/src/index.js"],
      "type": "stdio"
    }
  }
}
```

Lifecycle hooks still go in `~/.claude/settings.json` — that's the correct location for hooks and is not subject to the same overwrite issues.

**File:** `src/cli/init.ts`

### 4. Sync pull fix (already patched)

**Problem:** The pull logic uses GitHub's contents API (`repos/{owner}/{repo}/contents/entries/{file}`) which returns empty `content` for files >1MB.

**Fix:** Use the git blob API (`repos/{owner}/{repo}/git/blobs/{sha}`) which handles files of any size. The SHA is already available from the directory listing — just needs to be captured and used.

**File:** `src/storage/sync.ts`
**Status:** Already patched in current working tree.

### 5. File changes summary

| File | Change |
|------|--------|
| `src/cli.ts` | Default to `init --global` when no args |
| `src/cli/init.ts` | Use `~/.mcp.json` for MCP server, add step-by-step output, add sync prompt, pre-download model |
| `src/storage/sync.ts` | Use git blob API for pull (already done) |
| `package.json` | Bump version to 1.0.0 |

### 6. What doesn't change

- All 14 MCP tools (same interface, same behavior)
- Lifecycle hooks format and content
- Sync architecture (GitHub repo, JSONL, machine IDs, background scheduler)
- Database/storage paths (`~/.claude-context/`)
- Git hooks for project-level init (still available without `--global`)

### 7. Success criteria

After running `npx @hyperlynq/synaptic`:
1. User restarts Claude Code
2. All `mcp__synaptic__context_*` tools appear immediately
3. If sync was enabled, entries from other machines are pulled
4. No manual JSON editing required at any point
