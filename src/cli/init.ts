/**
 * Init command: Detects environment, configures MCP server, hooks, git hook,
 * and project directory for synaptic.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";

// ── Types ──────────────────────────────────────────────────────────────

export interface Environment {
  isWSL: boolean;
  settingsPath: string;
  buildDir: string;
  nodeCommand: string;
  nodeArgs: string[];
}

// ── Environment Detection ──────────────────────────────────────────────

export function detectEnvironment(): Environment {
  const isWSL = detectWSL();

  // buildDir: from build/src/cli/ go up two levels to build/
  const buildDir = resolve(join(import.meta.dirname, "..", ".."));

  if (isWSL) {
    const winProfile = getWindowsUserProfile();
    const winProfileWSL = windowsPathToWSL(winProfile);
    return {
      isWSL: true,
      settingsPath: join(winProfileWSL, ".claude", "settings.json"),
      buildDir,
      nodeCommand: String.raw`C:\WINDOWS\system32\wsl.exe`,
      nodeArgs: ["node", "--no-warnings"],
    };
  }

  return {
    isWSL: false,
    settingsPath: join(homedir(), ".claude", "settings.json"),
    buildDir,
    nodeCommand: "node",
    nodeArgs: ["--no-warnings"],
  };
}

// ── Init Command ───────────────────────────────────────────────────────

export async function initCommand(args: string[]): Promise<void> {
  const isGlobal = args.includes("--global");

  console.log("Detecting environment...\n");
  const env = detectEnvironment();

  console.log(`  WSL:           ${env.isWSL}`);
  console.log(`  Settings:      ${env.settingsPath}`);
  console.log(`  Build dir:     ${env.buildDir}`);
  console.log(`  Node command:  ${env.nodeCommand}`);
  console.log(`  Node args:     ${env.nodeArgs.join(" ")}`);
  console.log("");

  setupMcpServer(env);
  setupHooks(env);

  if (!isGlobal) {
    setupGitHook(env);
    setupCommitMsgHook(env);
    setupProjectDir();
  }

  console.log("\nDone.");
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
  // C:\Users\foo  →  /mnt/c/Users/foo
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
  const settings = readJsonFile(env.settingsPath);

  if (!settings.mcpServers || typeof settings.mcpServers !== "object") {
    settings.mcpServers = {};
  }

  const mcpServers = settings.mcpServers as Record<string, unknown>;
  if (mcpServers.synaptic) {
    console.log("  [skip] MCP server 'synaptic' already configured.");
    return;
  }

  const indexPath = join(env.buildDir, "src", "index.js");
  mcpServers.synaptic = {
    command: env.nodeCommand,
    args: [...env.nodeArgs, indexPath],
    type: "stdio",
  };

  writeJsonFile(env.settingsPath, settings);
  console.log("  [done] MCP server 'synaptic' added to settings.");
}

function setupHooks(env: Environment): void {
  const settings = readJsonFile(env.settingsPath);

  if (!settings.hooks || typeof settings.hooks !== "object") {
    settings.hooks = {};
  }

  const hooks = settings.hooks as Record<string, unknown>;
  let changed = false;

  // Helper to build the hook command
  const hookCommand = (scriptPath: string): string => {
    if (env.isWSL) {
      return `wsl node --no-warnings ${scriptPath}`;
    }
    return `node --no-warnings ${scriptPath}`;
  };

  // SessionStart hook
  if (!hooks.SessionStart) {
    const scriptPath = join(env.buildDir, "src", "hooks", "session-start.js");
    hooks.SessionStart = {
      command: hookCommand(scriptPath),
      matcher: "startup|resume|compact",
      timeout: 10000,
    };
    changed = true;
    console.log("  [done] SessionStart hook added.");
  } else {
    console.log("  [skip] SessionStart hook already present.");
  }

  // PreCompact hook
  if (!hooks.PreCompact) {
    const scriptPath = join(env.buildDir, "src", "hooks", "pre-compact.js");
    hooks.PreCompact = {
      command: hookCommand(scriptPath),
      timeout: 30000,
    };
    changed = true;
    console.log("  [done] PreCompact hook added.");
  } else {
    console.log("  [skip] PreCompact hook already present.");
  }

  // Stop hook
  if (!hooks.Stop) {
    const scriptPath = join(env.buildDir, "src", "hooks", "stop.js");
    hooks.Stop = {
      command: hookCommand(scriptPath),
      timeout: 10000,
    };
    changed = true;
    console.log("  [done] Stop hook added.");
  } else {
    console.log("  [skip] Stop hook already present.");
  }

  if (changed) {
    writeJsonFile(env.settingsPath, settings);
  }
}

function setupGitHook(env: Environment): void {
  const gitDir = join(process.cwd(), ".git");
  if (!existsSync(gitDir)) {
    console.log("  [skip] No .git/ directory found, skipping git hook.");
    return;
  }

  const hooksDir = join(gitDir, "hooks");
  const hookPath = join(hooksDir, "pre-commit");

  // Check if hook already has synaptic
  if (existsSync(hookPath)) {
    const existing = readFileSync(hookPath, "utf-8");
    if (existing.includes("synaptic")) {
      console.log("  [skip] Git pre-commit hook already contains synaptic.");
      return;
    }
    // Don't overwrite existing non-synaptic hooks
    console.log("  [skip] Existing pre-commit hook found (not synaptic), leaving untouched.");
    return;
  }

  const preCommitPath = join(env.buildDir, "src", "cli", "pre-commit.js");

  const script = `#!/bin/sh
# synaptic pre-commit hook
node --no-warnings ${preCommitPath}
`;

  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(hookPath, script, "utf-8");
  chmodSync(hookPath, 0o755);
  console.log("  [done] Git pre-commit hook installed.");
}

function setupCommitMsgHook(env: Environment): void {
  const gitDir = join(process.cwd(), ".git");
  if (!existsSync(gitDir)) {
    console.log("  [skip] No .git/ directory found, skipping commit-msg hook.");
    return;
  }

  const hooksDir = join(gitDir, "hooks");
  const hookPath = join(hooksDir, "commit-msg");

  if (existsSync(hookPath)) {
    const existing = readFileSync(hookPath, "utf-8");
    if (existing.includes("synaptic")) {
      console.log("  [skip] Git commit-msg hook already contains synaptic.");
      return;
    }
    console.log("  [skip] Existing commit-msg hook found (not synaptic), leaving untouched.");
    return;
  }

  const commitMsgPath = join(env.buildDir, "src", "cli", "commit-msg.js");

  const script = `#!/bin/sh
# synaptic commit-msg hook
node --no-warnings ${commitMsgPath} "$1"
`;

  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(hookPath, script, "utf-8");
  chmodSync(hookPath, 0o755);
  console.log("  [done] Git commit-msg hook installed.");
}

function setupProjectDir(): void {
  const dir = join(process.cwd(), ".synaptic");

  const configPath = join(dir, "config.json");
  if (existsSync(configPath)) {
    console.log("  [skip] .synaptic/config.json already exists.");
    return;
  }

  const now = new Date();
  const created = now.toISOString().slice(0, 10); // YYYY-MM-DD

  mkdirSync(dir, { recursive: true });
  writeFileSync(
    configPath,
    JSON.stringify({ version: "0.6.0", created }, null, 2) + "\n",
    "utf-8",
  );
  console.log("  [done] .synaptic/config.json created.");
}
