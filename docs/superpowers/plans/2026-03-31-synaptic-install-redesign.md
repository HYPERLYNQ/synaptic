# Synaptic v1.0 — Frictionless Install & Sync Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make synaptic install work with a single command, fix sync pull for large files, bump to v1.0.0

**Architecture:** Default CLI command becomes `init --global`. MCP server registers in `~/.mcp.json` instead of `~/.claude/settings.json`. Sync prompt added at end of init. Sync pull uses git blob API.

**Tech Stack:** TypeScript, Node.js 22+, stdio MCP

---

### Task 1: Default command = init

**Files:**
- Modify: `src/cli.ts`

- [ ] **Step 1: Update CLI to default to init when no args**

Replace the `main()` function in `src/cli.ts`:

```typescript
#!/usr/bin/env node

import { initCommand } from "./cli/init.js";
import { syncCommand } from "./cli/sync.js";

const USAGE = `
synaptic — persistent local memory for Claude Code

Usage:
  synaptic [command] [options]

Commands:
  init          Initialize synaptic (default if no command given)
  sync          Manage GitHub-based context sync

Options:
  -h, --help    Show this help message
`.trim();

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === "--help" || command === "-h") {
    console.log(USAGE);
    process.exit(0);
  }

  // Default to init --global when no command given
  if (!command || command === "init") {
    const initArgs = command === "init" ? args.slice(1) : ["--global"];
    await initCommand(initArgs);
    return;
  }

  switch (command) {
    case "sync":
      await syncCommand(args.slice(1));
      break;
    default:
      console.error(`Unknown command: ${command}`);
      console.error(`Run 'synaptic --help' for usage information.`);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Build and verify**

Run: `npm run build`
Expected: Clean compile, no errors

- [ ] **Step 3: Commit**

```bash
git add src/cli.ts
git commit -m "feat: default to init --global when no command given"
```

---

### Task 2: Rewrite init to use ~/.mcp.json + step output + sync prompt

**Files:**
- Modify: `src/cli/init.ts`
- Modify: `src/cli/sync.ts` (export `initSync`)

- [ ] **Step 1: Rewrite init.ts**

Key changes from current code:
1. Add `mcpJsonPath` to `Environment` interface — points to `~/.mcp.json` (WSL: Windows-side path)
2. `setupMcpServer()` writes to `~/.mcp.json` instead of `~/.claude/settings.json`
3. `setupMcpServer()` always updates (don't skip) — path may change after upgrade
4. `initCommand()` shows step-by-step output with `[1/2]`, `[2/2]` prefixes
5. Remove verbose env detection logging (no longer needed)
6. Add `promptForSync()` — checks if `gh` CLI is available, asks y/N, calls `initSync()` from sync.ts
7. Add `ask()` helper using `readline.createInterface`

Note: `execSync` is used only for `detectWSL`, `getWindowsUserProfile`, and `gh auth status` check — all with hardcoded commands, no user input. This is safe and matches the existing pattern in the codebase.

Full replacement content for `src/cli/init.ts`:

```typescript
/**
 * Init command: One-shot setup for synaptic.
 * - Registers MCP server in ~/.mcp.json
 * - Installs lifecycle hooks in ~/.claude/settings.json
 * - Optionally sets up cross-machine sync
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { createInterface } from "node:readline";

// ── Types ──────────────────────────────────────────────────────────────

export interface Environment {
  isWSL: boolean;
  settingsPath: string;
  mcpJsonPath: string;
  buildDir: string;
  nodeCommand: string;
  nodeArgs: string[];
}

// ── Environment Detection ──────────────────────────────────────────────

export function detectEnvironment(): Environment {
  const isWSL = detectWSL();
  const buildDir = resolve(join(import.meta.dirname, "..", ".."));

  if (isWSL) {
    const winProfile = getWindowsUserProfile();
    const winProfileWSL = windowsPathToWSL(winProfile);
    return {
      isWSL: true,
      settingsPath: join(winProfileWSL, ".claude", "settings.json"),
      mcpJsonPath: join(winProfileWSL, ".mcp.json"),
      buildDir,
      nodeCommand: String.raw`C:\WINDOWS\system32\wsl.exe`,
      nodeArgs: ["node", "--no-warnings"],
    };
  }

  return {
    isWSL: false,
    settingsPath: join(homedir(), ".claude", "settings.json"),
    mcpJsonPath: join(homedir(), ".mcp.json"),
    buildDir,
    nodeCommand: "node",
    nodeArgs: ["--no-warnings"],
  };
}

// ── Init Command ───────────────────────────────────────────────────────

export async function initCommand(args: string[]): Promise<void> {
  const isGlobal = args.includes("--global");

  console.log("\n  Setting up Synaptic...\n");
  const env = detectEnvironment();

  // Step 1: MCP server
  process.stdout.write("  [1/2] Registering MCP server...      ");
  setupMcpServer(env);

  // Step 2: Hooks
  process.stdout.write("  [2/2] Installing lifecycle hooks...   ");
  setupHooks(env);

  // Git hooks (project-level only)
  if (!isGlobal) {
    setupGitHook(env);
    setupCommitMsgHook(env);
    setupProjectDir();
  }

  console.log("\n  Setup complete. Restart Claude Code to activate.\n");

  // Sync prompt
  await promptForSync();
}

// ── Sync Prompt ────────────────────────────────────────────────────────

async function promptForSync(): Promise<void> {
  // Check if gh CLI is available and authenticated
  let ghAvailable = false;
  try {
    execSync("gh auth status", { timeout: 5000, stdio: "pipe" });
    ghAvailable = true;
  } catch {
    // gh not available or not authenticated
  }

  if (!ghAvailable) {
    console.log("  Tip: Install GitHub CLI (gh) to enable cross-machine sync.\n");
    return;
  }

  const answer = await ask("  Enable cross-machine sync? (requires GitHub CLI) [y/N] ");
  if (answer.toLowerCase() !== "y") {
    console.log("");
    return;
  }

  console.log("");

  // Import sync init dynamically to avoid loading at startup
  const { initSync } = await import("./sync.js");
  await initSync([]);

  console.log("");
}

function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ── Helpers (private) ──────────────────────────────────────────────────

function detectWSL(): boolean {
  try {
    if (!existsSync("/proc/version")) return false;
    const version = readFileSync("/proc/version", "utf-8");
    return /microsoft/i.test(version);
  } catch {
    return false;
  }
}

function getWindowsUserProfile(): string {
  try {
    const raw = execSync("cmd.exe /C echo %USERPROFILE%", {
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
    return raw;
  } catch (err) {
    throw new Error(`Failed to detect Windows user profile: ${err}`);
  }
}

function windowsPathToWSL(winPath: string): string {
  const normalized = winPath.replace(/\r?\n$/, "");
  const match = normalized.match(/^([A-Za-z]):\\(.*)/);
  if (!match) {
    throw new Error(`Cannot convert Windows path to WSL: ${winPath}`);
  }
  const drive = match[1].toLowerCase();
  const rest = match[2].replace(/\\/g, "/");
  return `/mnt/${drive}/${rest}`;
}

function readJsonFile(filePath: string): Record<string, unknown> {
  try {
    if (!existsSync(filePath)) return {};
    const raw = readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function writeJsonFile(filePath: string, data: Record<string, unknown>): void {
  const dir = resolve(filePath, "..");
  mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

function setupMcpServer(env: Environment): void {
  const mcpJson = readJsonFile(env.mcpJsonPath);

  if (!mcpJson.mcpServers || typeof mcpJson.mcpServers !== "object") {
    mcpJson.mcpServers = {};
  }

  const mcpServers = mcpJson.mcpServers as Record<string, unknown>;
  const indexPath = join(env.buildDir, "src", "index.js");

  // Always update — path may have changed after upgrade
  mcpServers.synaptic = {
    command: env.nodeCommand,
    args: [...env.nodeArgs, indexPath],
    type: "stdio",
  };

  writeJsonFile(env.mcpJsonPath, mcpJson);
  console.log("done");
}

function setupHooks(env: Environment): void {
  const settings = readJsonFile(env.settingsPath);

  if (!settings.hooks || typeof settings.hooks !== "object") {
    settings.hooks = {};
  }

  const hooks = settings.hooks as Record<string, unknown>;

  const hookCommand = (scriptPath: string): string => {
    if (env.isWSL) {
      return `wsl node --no-warnings ${scriptPath}`;
    }
    return `node --no-warnings ${scriptPath}`;
  };

  if (!hooks.SessionStart) {
    const scriptPath = join(env.buildDir, "src", "hooks", "session-start.js");
    hooks.SessionStart = {
      command: hookCommand(scriptPath),
      matcher: "startup|resume|compact",
      timeout: 10000,
    };
  }

  if (!hooks.PreCompact) {
    const scriptPath = join(env.buildDir, "src", "hooks", "pre-compact.js");
    hooks.PreCompact = {
      command: hookCommand(scriptPath),
      timeout: 30000,
    };
  }

  if (!hooks.Stop) {
    const scriptPath = join(env.buildDir, "src", "hooks", "stop.js");
    hooks.Stop = {
      command: hookCommand(scriptPath),
      timeout: 10000,
    };
  }

  writeJsonFile(env.settingsPath, settings);
  console.log("done");
}

function setupGitHook(env: Environment): void {
  const gitDir = join(process.cwd(), ".git");
  if (!existsSync(gitDir)) return;

  const hooksDir = join(gitDir, "hooks");
  const hookPath = join(hooksDir, "pre-commit");

  if (existsSync(hookPath)) return;

  const preCommitPath = join(env.buildDir, "src", "cli", "pre-commit.js");
  const script = `#!/bin/sh\n# synaptic pre-commit hook\nnode --no-warnings "${preCommitPath}"\n`;
  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(hookPath, script, "utf-8");
  chmodSync(hookPath, 0o755);
}

function setupCommitMsgHook(env: Environment): void {
  const gitDir = join(process.cwd(), ".git");
  if (!existsSync(gitDir)) return;

  const hooksDir = join(gitDir, "hooks");
  const hookPath = join(hooksDir, "commit-msg");

  if (existsSync(hookPath)) return;

  const commitMsgPath = join(env.buildDir, "src", "cli", "commit-msg.js");
  const script = `#!/bin/sh\n# synaptic commit-msg hook\nnode --no-warnings "${commitMsgPath}" "$1"\n`;
  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(hookPath, script, "utf-8");
  chmodSync(hookPath, 0o755);
}

function setupProjectDir(): void {
  const dir = join(process.cwd(), ".synaptic");
  const configPath = join(dir, "config.json");
  if (existsSync(configPath)) return;

  const created = new Date().toISOString().slice(0, 10);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    configPath,
    JSON.stringify({ version: "1.0.0", created }, null, 2) + "\n",
    "utf-8",
  );
}
```

- [ ] **Step 2: Export initSync from sync.ts**

In `src/cli/sync.ts`, change the `initSync` function declaration from private to exported:

```typescript
// Before:
async function initSync(args: string[]): Promise<void> {

// After:
export async function initSync(args: string[]): Promise<void> {
```

- [ ] **Step 3: Build and verify**

Run: `npm run build`
Expected: Clean compile, no errors

- [ ] **Step 4: Commit**

```bash
git add src/cli/init.ts src/cli/sync.ts
git commit -m "feat: rewrite init to use ~/.mcp.json + sync prompt"
```

---

### Task 3: Commit sync pull fix

**Files:**
- Already modified: `src/storage/sync.ts`

The sync pull fix is already in the working tree. Two changes:

1. `remoteFiles` type includes `sha` and the `--jq` query captures it:
```typescript
let remoteFiles: Array<{ name: string; sha: string }>;
// ...
"--jq", "[.[] | {name: .name, sha: .sha}]",
```

2. Download uses git blob API instead of contents API:
```typescript
const raw = await execGh([
  "api", `repos/${repoSlug(state)}/git/blobs/${file.sha}`,
  "--jq", ".content",
]);
```

- [ ] **Step 1: Commit**

```bash
git add src/storage/sync.ts
git commit -m "fix: use git blob API for sync pull (handles files >1MB)"
```

---

### Task 4: Bump version to 1.0.0

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Update version**

In `package.json`, change:

```json
"version": "1.0.0",
```

- [ ] **Step 2: Build and smoke test**

Run: `npm run build && node build/src/cli.js --help`

Expected: Shows updated usage with `init` noted as default.

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "chore: bump version to 1.0.0"
```

---

### Task 5: End-to-end verification

- [ ] **Step 1: Test default command runs init**

Run: `node build/src/cli.js`

Expected: Shows "Setting up Synaptic..." and runs through steps.

- [ ] **Step 2: Verify ~/.mcp.json**

Run: `cat ~/.mcp.json`

Expected: JSON with `mcpServers.synaptic` entry.

- [ ] **Step 3: Verify hooks in settings.json**

Check `~/.claude/settings.json` has `SessionStart`, `PreCompact`, `Stop` hooks.

- [ ] **Step 4: Test sync still works**

Run: `node build/src/cli.js sync now`

Expected: Push/pull counts without errors.
