/**
 * Stop hook: Saves debounced handoff notes when Claude finishes responding.
 * Only saves if 5+ minutes have passed since the last handoff note.
 *
 * Receives JSON on stdin: { stop_hook_active: boolean, ... }
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendEntry } from "../storage/markdown.js";
import { ContextIndex } from "../storage/sqlite.js";
import { Embedder } from "../storage/embedder.js";
import { ensureDirs, DB_DIR } from "../storage/paths.js";
import { detectProject } from "../storage/project.js";

const DEBOUNCE_FILE = join(DB_DIR, ".last-handoff");
const DEBOUNCE_MS = 5 * 60 * 1000; // 5 minutes

interface StopInput {
  stop_hook_active?: boolean;
}

function shouldDebounce(): boolean {
  if (!existsSync(DEBOUNCE_FILE)) return false;
  try {
    const last = parseInt(readFileSync(DEBOUNCE_FILE, "utf-8").trim(), 10);
    return Date.now() - last < DEBOUNCE_MS;
  } catch {
    return false;
  }
}

function updateDebounceTimestamp(): void {
  writeFileSync(DEBOUNCE_FILE, Date.now().toString(), "utf-8");
}

async function main(): Promise<void> {
  ensureDirs();

  let input: StopInput = {};
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer);
    }
    const raw = Buffer.concat(chunks).toString("utf-8").trim();
    if (raw) {
      input = JSON.parse(raw);
    }
  } catch {
    // Use defaults
  }

  // Prevent infinite loops
  if (input.stop_hook_active) {
    return;
  }

  // Debounce: skip if a handoff was saved recently
  if (shouldDebounce()) {
    return;
  }

  const index = new ContextIndex();
  const embedder = new Embedder();

  try {
    // Check if there's been meaningful activity today
    const todayEntries = index.list({ days: 1 });
    if (todayEntries.length === 0) {
      return; // No activity to create a handoff for
    }

    // Create a handoff summary from today's entries
    const types = new Map<string, number>();
    const tags = new Set<string>();
    for (const entry of todayEntries) {
      types.set(entry.type, (types.get(entry.type) ?? 0) + 1);
      entry.tags.forEach((t) => tags.add(t));
    }

    const tagList = Array.from(tags);

    // Collect real-time insight saves from today (the primary distillation source)
    const todayInsights = todayEntries
      .filter(e => e.type === "insight")
      .slice(0, 5);

    const contentParts: string[] = [];

    // Activity line
    const projects = new Set(todayEntries.map(e => e.project).filter(Boolean));
    const projectStr = projects.size > 0 ? ` across ${Array.from(projects).join(", ")}` : "";
    contentParts.push(`Activity: ${todayEntries.length} entries${projectStr}.`);

    // Learnings section (from real-time insight saves)
    if (todayInsights.length > 0) {
      contentParts.push("Learnings:");
      for (const insight of todayInsights) {
        const summary = insight.content.length > 150
          ? insight.content.slice(0, 150) + "..."
          : insight.content;
        contentParts.push(`- ${summary}`);
      }
    }

    const content = contentParts.join("\n");

    const entry = appendEntry(content, "handoff", tagList);
    entry.tier = ContextIndex.assignTier(entry.type);
    const rowid = index.insert(entry);
    const embedding = await embedder.embed(entry.content);
    index.insertVec(rowid, embedding);
    updateDebounceTimestamp();
  } finally {
    index.close();
  }
}

main().catch((err) => {
  process.stderr.write(`stop hook error: ${err}\n`);
  process.exit(0);
});
