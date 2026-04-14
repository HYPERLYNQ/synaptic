/**
 * Init command: One-shot setup for synaptic.
 * - Registers MCP server in ~/.mcp.json
 * - Installs lifecycle hooks in ~/.claude/settings.json
 * - Optionally sets up cross-machine sync
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { execSync, spawnSync } from "node:child_process";
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

  // Step 3: Register plugin in client settings
  // (Hooks themselves are declared in .claude-plugin/plugin.json now;
  // this step only registers the MCP server, marketplace source, and
  // enabledPlugins entry for non-plugin clients and hybrid setups.)
  process.stdout.write("  [3/3] Registering plugin in client...");
  registerPluginInClientSettings(env);

  // Git hooks (project-level only)
  if (!isGlobal) {
    setupGitHook(env);
    setupCommitMsgHook(env);
    setupProjectDir();
  }

  // Prune unused onnxruntime binaries (~493 MB savings).
  // Runs unconditionally at the end of init so npm-direct users get the
  // same disk savings as plugin-installed users. Best-effort — never
  // fails init if the prune is unavailable or fails.
  runPrune();

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

// ── Prune onnxruntime binaries ─────────────────────────────────────────

function runPrune(): void {
  // The prune script lives in the package's `scripts/` directory next to
  // the build output. Resolve relative to this compiled file's location
  // so it works whether init is invoked from the npm-installed package
  // or from a local clone via `node build/src/cli.js init`.
  // build/src/cli/init.js → ../../../scripts/prune-onnxruntime-binaries.cjs
  const here = resolve(import.meta.dirname);
  const prunePath = resolve(
    here,
    "..",
    "..",
    "..",
    "scripts",
    "prune-onnxruntime-binaries.cjs",
  );

  if (!existsSync(prunePath)) {
    // Script missing (unusual local layout) — silently skip. No regression
    // from previous behavior; users just don't get the optimization.
    return;
  }

  // spawnSync (not execSync) so we never go through a shell. Path is
  // internal, but defense in depth is cheap.
  spawnSync(process.execPath, [prunePath], { stdio: "inherit" });
  // Prune failure is non-fatal — install is functional, just bigger.
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
  if (!existsSync(filePath)) return {};
  const raw = readFileSync(filePath, "utf-8");
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `Cannot parse ${filePath} as JSON — aborting to avoid overwriting your settings. ` +
        `Fix or move the file and re-run init. Underlying error: ${(err as Error).message}`,
    );
  }
}

/**
 * Normalize a path to POSIX-style forward slashes.
 * Node handles forward slashes natively on Windows, and this keeps paths
 * immune to JSON-escape corruption when the settings file is hand-edited
 * or re-serialized by external tools.
 */
function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

function writeJsonFile(filePath: string, data: Record<string, unknown>): void {
  const dir = resolve(filePath, "..");
  mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

function setupMcpServer(env: Environment): void {
  const indexPath = toPosix(join(env.buildDir, "src", "index.js"));
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

/**
 * Register synaptic in the user's Claude Code settings.json so that:
 *   1. Non-plugin MCP clients (Claude desktop, VS Code, etc.) can find
 *      the synaptic MCP server via the user-level mcpServers entry.
 *   2. The synaptic source directory is registered as a local plugin
 *      marketplace so users running `synaptic init` from a clone can
 *      enable the plugin without re-fetching it from a remote source.
 *
 * **This function NO LONGER writes hooks.** As of v1.3.0 the hooks are
 * declared in `.claude-plugin/plugin.json` and dispatched by the plugin
 * system's hook-launcher, so writing them to user settings would only
 * cause every hook to fire twice (once via the plugin, once via the
 * user-settings entry). Existing user-settings hook entries from prior
 * versions of `synaptic init` should be removed by hand if you've
 * upgraded; future runs of `synaptic init` will not re-create them.
 */
function registerPluginInClientSettings(env: Environment): void {
  const settings = readJsonFile(env.settingsPath);

  const buildDirPosix = toPosix(env.buildDir);

  // Register MCP server in settings.json for VS Code / Claude desktop /
  // any non-plugin MCP client. Pattern D's plugin-managed install lives
  // in CLAUDE_PLUGIN_DATA, but this entry points at the user's local
  // npm install so other clients can still use it without going through
  // the Claude Code plugin system.
  if (!settings.mcpServers || typeof settings.mcpServers !== "object") {
    settings.mcpServers = {};
  }
  const indexPath = toPosix(join(env.buildDir, "src", "index.js"));
  (settings.mcpServers as Record<string, unknown>).synaptic = {
    command: env.nodeCommand,
    args: [...env.nodeArgs, indexPath],
    type: "stdio",
  };

  // Register as a local-directory marketplace so the plugin system can
  // discover synaptic from this clone (alongside any community-marketplace
  // install). Harmless for users who don't use Claude Code's plugin
  // system, useful for hybrid (npm + plugin) setups.
  if (!settings.extraKnownMarketplaces || typeof settings.extraKnownMarketplaces !== "object") {
    settings.extraKnownMarketplaces = {};
  }
  (settings.extraKnownMarketplaces as Record<string, unknown>).synaptic = {
    source: { source: "directory", path: buildDirPosix },
  };

  // Enable the synaptic plugin from the local marketplace registered above.
  if (!settings.enabledPlugins || typeof settings.enabledPlugins !== "object") {
    settings.enabledPlugins = {};
  }
  (settings.enabledPlugins as Record<string, boolean>)["synaptic@synaptic"] = true;

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
