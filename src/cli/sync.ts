/**
 * CLI commands for managing GitHub-based context sync.
 *
 * Usage:
 *   synaptic sync init [--name <machine-name>] [--repo <repo-name>]
 *   synaptic sync status
 *   synaptic sync now
 *   synaptic sync disable
 */

import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { ContextIndex } from "../storage/sqlite.js";
import { Embedder } from "../storage/embedder.js";
import { ensureDirs } from "../storage/paths.js";
import { runMaintenance } from "../storage/maintenance.js";
import {
  readSyncState,
  writeSyncState,
  ensureSyncRepo,
  registerMachine,
  getGhUsername,
  pullEntries,
  syncCycle,
  type SyncState,
} from "../storage/sync.js";
import { readSyncLogTail, SYNC_LOG_PATH } from "../storage/sync-background.js";

function generateMachineId(): string {
  return randomBytes(4).toString("hex");
}

function parseFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

export async function initSync(args: string[]): Promise<void> {
  // Check gh auth
  const { execFileSync, execFile: execFileCb } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFileCb);
  try {
    execFileSync("gh", ["auth", "status"], { timeout: 5000, stdio: "pipe" });
  } catch {
    console.error("Error: gh CLI is not authenticated. Run 'gh auth login' first.");
    process.exit(1);
  }

  const machineName = parseFlag(args, "--name") ?? hostname();
  let repoName = parseFlag(args, "--repo") ?? "synaptic-sync";

  // Check if already initialized
  const existing = readSyncState();
  if (existing?.config.enabled) {
    console.log(`Sync already initialized as "${existing.config.machineName}" (${existing.config.machineId})`);
    console.log(`Repo: ${existing.config.repoOwner}/${existing.config.repoName}`);
    return;
  }

  console.log("Initializing sync...");

  // Get GitHub username
  const owner = await getGhUsername();
  console.log(`GitHub user: ${owner}`);

  // Auto-detect existing sync repo on GitHub if none specified
  if (!parseFlag(args, "--repo")) {
    try {
      const { stdout } = await execFileAsync("gh", [
        "repo", "view", `${owner}/synaptic-sync`, "--json", "name",
      ], { timeout: 10000 });
      if (stdout.includes("synaptic-sync")) {
        console.log(`Found existing sync repo: ${owner}/synaptic-sync`);
        repoName = "synaptic-sync";
      }
    } catch {
      // No existing repo — will create one
    }
  }

  // Create or verify repo
  console.log(`Ensuring repo ${owner}/${repoName}...`);
  await ensureSyncRepo(owner, repoName);

  // Generate machine ID
  const machineId = generateMachineId();
  console.log(`Machine ID: ${machineId}`);
  console.log(`Machine name: ${machineName}`);

  // Register machine in manifest
  await registerMachine(owner, repoName, machineId, machineName);

  // Write sync state
  const state: SyncState = {
    config: {
      machineId,
      machineName,
      repoName,
      repoOwner: owner,
      enabled: true,
    },
    lastPushAt: null,
    lastPullAt: null,
    remoteCursors: {},
  };
  writeSyncState(state);

  // Run initial pull
  console.log("Running initial pull...");
  ensureDirs();
  const index = new ContextIndex();
  const embedder = new Embedder();
  try {
    const result = await pullEntries(index, embedder, state);
    if (result.pulled > 0) {
      console.log(`Pulled ${result.pulled} entries from ${result.machines.length} machine(s)`);
    } else {
      console.log("No entries to pull (this might be the first machine)");
    }
  } finally {
    index.close();
  }

  console.log("\nSync initialized successfully!");
  console.log(`Run 'synaptic sync now' to push your entries.`);
}

async function syncStatus(): Promise<void> {
  const state = readSyncState();
  if (!state) {
    console.log("Sync is not configured. Run 'synaptic sync init' to set up.");
    return;
  }

  console.log(`Sync: ${state.config.enabled ? "enabled" : "disabled"}`);
  console.log(`Machine: ${state.config.machineName} (${state.config.machineId})`);
  console.log(`Repo: ${state.config.repoOwner}/${state.config.repoName}`);
  console.log(`Last push: ${state.lastPushAt ?? "never"}`);
  console.log(`Last pull: ${state.lastPullAt ?? "never"}`);

  const knownMachines = Object.entries(state.remoteCursors);
  if (knownMachines.length > 0) {
    console.log("\nKnown remote machines:");
    for (const [id, cursor] of knownMachines) {
      console.log(`  ${id}: ${cursor} entries processed`);
    }
  }

  const tail = readSyncLogTail(10);
  if (tail.length > 0) {
    console.log(`\nRecent background ticks (${SYNC_LOG_PATH}):`);
    for (const line of tail) {
      console.log(`  ${line}`);
    }
  } else {
    console.log("\nNo background tick log yet — the MCP server may not have run a tick in this install.");
  }
}

async function syncNow(): Promise<void> {
  const state = readSyncState();
  if (!state?.config.enabled) {
    console.error("Sync is not enabled. Run 'synaptic sync init' first.");
    process.exit(1);
  }

  ensureDirs();
  const index = new ContextIndex();
  const embedder = new Embedder();
  try {
    // Run maintenance (includes smart dedup) before pushing
    console.log("Running maintenance...");
    const report = runMaintenance(index);
    const parts: string[] = [];
    if (report.decayed > 0) parts.push(`${report.decayed} decayed`);
    if (report.demoted > 0) parts.push(`${report.demoted} demoted`);
    if (report.promotedStable > 0) parts.push(`${report.promotedStable} promoted`);
    if (report.consolidated > 0) parts.push(`${report.consolidated} consolidated`);
    if (report.smartDeduped > 0) parts.push(`${report.smartDeduped} deduped`);
    if (parts.length > 0) {
      console.log(`Maintenance: ${parts.join(", ")}`);
    } else {
      console.log("Maintenance: nothing to do");
    }

    // Sync cycle
    console.log("Running sync cycle...");
    const result = await syncCycle(index, embedder);
    console.log(`Pushed: ${result.pushed} entries`);
    console.log(`Pulled: ${result.pulled} entries`);
    if (result.error) {
      console.error(`Warning: ${result.error}`);
    }
  } finally {
    index.close();
  }
}

async function syncDisable(): Promise<void> {
  const state = readSyncState();
  if (!state) {
    console.log("Sync is not configured.");
    return;
  }

  state.config.enabled = false;
  writeSyncState(state);
  console.log("Sync disabled. Run 'synaptic sync init' to re-enable.");
}

export async function syncCommand(args: string[]): Promise<void> {
  const subcommand = args[0];

  switch (subcommand) {
    case "init":
      await initSync(args.slice(1));
      break;
    case "status":
      await syncStatus();
      break;
    case "now":
      await syncNow();
      break;
    case "disable":
      await syncDisable();
      break;
    default:
      console.log(`
synaptic sync — GitHub-based context synchronization

Usage:
  synaptic sync init [--name <machine-name>] [--repo <repo-name>]
  synaptic sync status
  synaptic sync now
  synaptic sync disable
      `.trim());
      break;
  }
}
