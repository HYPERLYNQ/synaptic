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
  settingsLocalPath: string;
  mcpJsonPath: string;
  /** On WSL, the Windows-side ~/.mcp.json so VS Code can find it */
  windowsMcpJsonPath: string | null;
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
      settingsLocalPath: join(winProfileWSL, ".claude", "settings.local.json"),
      mcpJsonPath: join(homedir(), ".mcp.json"),
      windowsMcpJsonPath: join(winProfileWSL, ".mcp.json"),
      buildDir,
      nodeCommand: String.raw`C:\WINDOWS\system32\wsl.exe`,
      nodeArgs: ["node", "--no-warnings"],
    };
  }

  return {
    isWSL: false,
    settingsPath: join(homedir(), ".claude", "settings.json"),
    settingsLocalPath: join(homedir(), ".claude", "settings.local.json"),
    mcpJsonPath: join(homedir(), ".mcp.json"),
    windowsMcpJsonPath: null,
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
  process.stdout.write("  [1/3] Registering MCP server...      ");
  setupMcpServer(env);

  // Step 2: Enable MCP server in settings
  process.stdout.write("  [2/3] Enabling MCP server...         ");
  setupSettingsLocal(env);

  // Step 3: Hooks
  process.stdout.write("  [3/3] Installing lifecycle hooks...   ");
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
      stdio: ["pipe", "pipe", "pipe"],
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
  const indexPath = join(env.buildDir, "src", "index.js");
  const serverEntry = {
    command: env.nodeCommand,
    args: [...env.nodeArgs, indexPath],
    type: "stdio",
  };

  // Write to primary .mcp.json
  const mcpJson = readJsonFile(env.mcpJsonPath);
  if (!mcpJson.mcpServers || typeof mcpJson.mcpServers !== "object") {
    mcpJson.mcpServers = {};
  }
  (mcpJson.mcpServers as Record<string, unknown>).synaptic = serverEntry;
  writeJsonFile(env.mcpJsonPath, mcpJson);

  // On WSL, also write to Windows-side .mcp.json so VS Code can find it
  if (env.windowsMcpJsonPath) {
    const winMcpJson = readJsonFile(env.windowsMcpJsonPath);
    if (!winMcpJson.mcpServers || typeof winMcpJson.mcpServers !== "object") {
      winMcpJson.mcpServers = {};
    }
    (winMcpJson.mcpServers as Record<string, unknown>).synaptic = serverEntry;
    writeJsonFile(env.windowsMcpJsonPath, winMcpJson);
  }

  console.log("done");
}

function setupSettingsLocal(env: Environment): void {
  const settings = readJsonFile(env.settingsLocalPath);

  // Ensure enabledMcpjsonServers includes "synaptic"
  if (!Array.isArray(settings.enabledMcpjsonServers)) {
    settings.enabledMcpjsonServers = [];
  }
  const servers = settings.enabledMcpjsonServers as string[];
  if (!servers.includes("synaptic")) {
    servers.push("synaptic");
  }

  writeJsonFile(env.settingsLocalPath, settings);
  console.log("done");
}

function setupHooks(env: Environment): void {
  const settings = readJsonFile(env.settingsPath);

  // Also register MCP server in settings.json for VS Code compatibility
  if (!settings.mcpServers || typeof settings.mcpServers !== "object") {
    settings.mcpServers = {};
  }
  const indexPath = join(env.buildDir, "src", "index.js");
  (settings.mcpServers as Record<string, unknown>).synaptic = {
    command: env.nodeCommand,
    args: [...env.nodeArgs, indexPath],
    type: "stdio",
  };

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
