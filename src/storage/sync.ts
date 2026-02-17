/**
 * GitHub-based context sync engine.
 *
 * Each machine writes to its own JSONL file (entries/{machineId}.jsonl).
 * Entry IDs are globally unique → dedup is a simple ID check.
 * Embeddings are NOT synced — regenerated locally on pull.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SYNC_STATE_PATH, SYNC_DIR } from "./paths.js";
import type { ContextIndex } from "./sqlite.js";
import type { Embedder } from "./embedder.js";
import type { ContextEntry } from "./markdown.js";
import { join } from "node:path";

const execFileAsync = promisify(execFile);

const GH_TIMEOUT = 15_000; // 15s for each gh call

// --- Types ---

export interface SyncConfig {
  machineId: string;
  machineName: string;
  repoName: string;
  repoOwner: string;
  enabled: boolean;
}

export interface SyncState {
  config: SyncConfig;
  lastPushAt: string | null;
  lastPullAt: string | null;
  remoteCursors: Record<string, number>; // machineId -> line count processed
}

interface SyncableEntry {
  id: string;
  date: string;
  time: string;
  type: string;
  tags: string[];
  content: string;
  tier: string;
  pinned: boolean;
  project: string | null;
  sessionId: string | null;
  agentId: string | null;
}

// --- State management ---

export function readSyncState(): SyncState | null {
  try {
    if (!existsSync(SYNC_STATE_PATH)) return null;
    const raw = readFileSync(SYNC_STATE_PATH, "utf-8");
    return JSON.parse(raw) as SyncState;
  } catch {
    return null;
  }
}

export function writeSyncState(state: SyncState): void {
  writeFileSync(SYNC_STATE_PATH, JSON.stringify(state, null, 2), "utf-8");
}

export function isSyncEnabled(): boolean {
  const state = readSyncState();
  if (!state?.config.enabled) return false;
  // Check gh is available
  try {
    const { execFileSync } = require("node:child_process");
    execFileSync("gh", ["auth", "status"], { timeout: 5000, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

// --- GitHub helpers ---

async function execGh(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("gh", args, {
    timeout: GH_TIMEOUT,
    maxBuffer: 10 * 1024 * 1024, // 10MB for large JSONL files
  });
  return stdout;
}

function repoSlug(state: SyncState): string {
  return `${state.config.repoOwner}/${state.config.repoName}`;
}

// --- Push ---

export async function pushEntries(
  index: ContextIndex,
  state: SyncState
): Promise<{ pushed: number }> {
  const { machineId } = state.config;
  const remotePath = `entries/${machineId}.jsonl`;
  const localCache = join(SYNC_DIR, `${machineId}.jsonl`);

  // Query entries newer than lastPushAt
  const allEntries = state.lastPushAt
    ? index.list({ includeArchived: false }).filter(e => {
        const entryTs = new Date(`${e.date}T${e.time}:00`).toISOString();
        return entryTs > state.lastPushAt!;
      })
    : index.list({ includeArchived: false });

  if (allEntries.length === 0) {
    return { pushed: 0 };
  }

  // Convert to syncable format
  const newLines = allEntries.map(e => JSON.stringify(toSyncable(e)));

  // Read existing local cache (to append)
  let existingContent = "";
  if (existsSync(localCache)) {
    existingContent = readFileSync(localCache, "utf-8");
  }

  // Deduplicate: parse existing IDs from cache
  const existingIds = new Set<string>();
  if (existingContent) {
    for (const line of existingContent.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as SyncableEntry;
        existingIds.add(parsed.id);
      } catch { /* skip corrupt lines */ }
    }
  }

  // Only append truly new entries
  const deduped = newLines.filter(line => {
    try {
      const parsed = JSON.parse(line) as SyncableEntry;
      return !existingIds.has(parsed.id);
    } catch { return false; }
  });

  if (deduped.length === 0) {
    return { pushed: 0 };
  }

  const updatedContent = existingContent + deduped.join("\n") + "\n";

  // Write local cache
  writeFileSync(localCache, updatedContent, "utf-8");

  // Upload to GitHub
  const contentB64 = Buffer.from(updatedContent).toString("base64");

  // Get current file SHA (if exists) for update
  let sha: string | undefined;
  try {
    const fileInfo = await execGh([
      "api", `repos/${repoSlug(state)}/contents/${remotePath}`,
      "--jq", ".sha",
    ]);
    sha = fileInfo.trim();
  } catch {
    // File doesn't exist yet — will create
  }

  const body: Record<string, string> = {
    message: `sync: ${machineId} +${deduped.length} entries`,
    content: contentB64,
  };
  if (sha) body.sha = sha;

  await execGh([
    "api", `repos/${repoSlug(state)}/contents/${remotePath}`,
    "-X", "PUT",
    "-f", `message=${body.message}`,
    "-f", `content=${body.content}`,
    ...(sha ? ["-f", `sha=${sha}`] : []),
  ]);

  // Update state
  state.lastPushAt = new Date().toISOString();
  writeSyncState(state);

  return { pushed: deduped.length };
}

// --- Pull ---

export async function pullEntries(
  index: ContextIndex,
  embedder: Embedder,
  state: SyncState
): Promise<{ pulled: number; machines: string[] }> {
  const { machineId } = state.config;
  let totalPulled = 0;
  const machinesSeen: string[] = [];

  // List remote entry files
  let remoteFiles: Array<{ name: string }>;
  try {
    const raw = await execGh([
      "api", `repos/${repoSlug(state)}/contents/entries`,
      "--jq", "[.[] | {name: .name}]",
    ]);
    remoteFiles = JSON.parse(raw);
  } catch {
    // entries/ dir doesn't exist yet
    return { pulled: 0, machines: [] };
  }

  for (const file of remoteFiles) {
    // Skip our own file
    const remoteMachineId = file.name.replace(".jsonl", "");
    if (remoteMachineId === machineId) continue;

    machinesSeen.push(remoteMachineId);

    // Download file content
    let content: string;
    try {
      const raw = await execGh([
        "api", `repos/${repoSlug(state)}/contents/entries/${file.name}`,
        "--jq", ".content",
      ]);
      content = Buffer.from(raw.trim(), "base64").toString("utf-8");
    } catch {
      continue; // skip this machine's file
    }

    const lines = content.split("\n").filter(l => l.trim());
    const cursor = state.remoteCursors[remoteMachineId] ?? 0;

    // Skip already-processed lines
    const newLines = lines.slice(cursor);
    if (newLines.length === 0) continue;

    for (const line of newLines) {
      let entry: SyncableEntry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue; // skip corrupt line
      }

      // Dedup check
      if (index.hasEntry(entry.id)) continue;

      // Insert entry
      const contextEntry = fromSyncable(entry);
      const rowid = index.insert(contextEntry);

      // Generate embedding locally
      try {
        const embedding = await embedder.embed(contextEntry.content);
        index.insertVec(rowid, embedding);
      } catch {
        // Embedding failure is non-fatal
      }

      totalPulled++;
    }

    // Update cursor
    state.remoteCursors[remoteMachineId] = lines.length;
  }

  // Update state
  state.lastPullAt = new Date().toISOString();
  writeSyncState(state);

  return { pulled: totalPulled, machines: machinesSeen };
}

// --- Full sync cycle ---

export async function syncCycle(
  index: ContextIndex,
  embedder: Embedder
): Promise<{ pushed: number; pulled: number; error?: string }> {
  const state = readSyncState();
  if (!state?.config.enabled) {
    return { pushed: 0, pulled: 0, error: "sync not enabled" };
  }

  let pushed = 0;
  let pulled = 0;

  try {
    const pushResult = await pushEntries(index, state);
    pushed = pushResult.pushed;
  } catch (err) {
    return { pushed: 0, pulled: 0, error: `push failed: ${err}` };
  }

  // Re-read state after push (it was updated)
  const freshState = readSyncState();
  if (!freshState) {
    return { pushed, pulled: 0, error: "state lost after push" };
  }

  try {
    const pullResult = await pullEntries(index, embedder, freshState);
    pulled = pullResult.pulled;
  } catch (err) {
    return { pushed, pulled: 0, error: `pull failed: ${err}` };
  }

  return { pushed, pulled };
}

// --- Init helpers ---

export async function ensureSyncRepo(owner: string, repoName: string): Promise<void> {
  // Check if repo exists
  try {
    await execGh(["repo", "view", `${owner}/${repoName}`, "--json", "name"]);
    return; // already exists
  } catch {
    // Doesn't exist — create it
  }

  await execGh([
    "repo", "create", `${owner}/${repoName}`,
    "--private",
    "--description", "Synaptic context sync (auto-managed)",
  ]);

  // Create manifest.json
  const manifest = JSON.stringify({ version: 1, machines: {} }, null, 2);
  const manifestB64 = Buffer.from(manifest).toString("base64");
  await execGh([
    "api", `repos/${owner}/${repoName}/contents/manifest.json`,
    "-X", "PUT",
    "-f", "message=init: create manifest",
    "-f", `content=${manifestB64}`,
  ]);

  // Create entries/ directory with .gitkeep
  const gitkeepB64 = Buffer.from("").toString("base64");
  await execGh([
    "api", `repos/${owner}/${repoName}/contents/entries/.gitkeep`,
    "-X", "PUT",
    "-f", "message=init: create entries directory",
    "-f", `content=${gitkeepB64}`,
  ]);
}

export async function registerMachine(
  owner: string,
  repoName: string,
  machineId: string,
  machineName: string
): Promise<void> {
  // Get current manifest
  let manifest: { version: number; machines: Record<string, { name: string }> };
  let sha: string;

  try {
    const raw = await execGh([
      "api", `repos/${owner}/${repoName}/contents/manifest.json`,
      "--jq", "{content: .content, sha: .sha}",
    ]);
    const parsed = JSON.parse(raw);
    sha = parsed.sha;
    manifest = JSON.parse(Buffer.from(parsed.content, "base64").toString("utf-8"));
  } catch {
    manifest = { version: 1, machines: {} };
    sha = "";
  }

  manifest.machines[machineId] = { name: machineName };

  const contentB64 = Buffer.from(JSON.stringify(manifest, null, 2)).toString("base64");
  const args = [
    "api", `repos/${owner}/${repoName}/contents/manifest.json`,
    "-X", "PUT",
    "-f", "message=sync: register machine " + machineName,
    "-f", `content=${contentB64}`,
  ];
  if (sha) args.push("-f", `sha=${sha}`);

  await execGh(args);
}

export async function getGhUsername(): Promise<string> {
  const raw = await execGh(["api", "user", "--jq", ".login"]);
  return raw.trim();
}

// --- Conversion helpers ---

function toSyncable(entry: ContextEntry): SyncableEntry {
  return {
    id: entry.id,
    date: entry.date,
    time: entry.time,
    type: entry.type,
    tags: entry.tags,
    content: entry.content,
    tier: entry.tier ?? "working",
    pinned: entry.pinned ?? false,
    project: entry.project ?? null,
    sessionId: entry.sessionId ?? null,
    agentId: entry.agentId ?? null,
  };
}

function fromSyncable(s: SyncableEntry): ContextEntry {
  return {
    id: s.id,
    date: s.date,
    time: s.time,
    type: s.type,
    tags: s.tags,
    content: s.content,
    sourceFile: "sync",
    tier: s.tier as ContextEntry["tier"],
    pinned: s.pinned,
    project: s.project,
    sessionId: s.sessionId,
    agentId: s.agentId,
  };
}
