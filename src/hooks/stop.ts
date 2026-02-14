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
import { ensureDirs, DB_DIR } from "../storage/paths.js";

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

    const typeSummary = Array.from(types.entries())
      .map(([t, c]) => `${c} ${t}`)
      .join(", ");
    const tagList = Array.from(tags);

    const content = [
      `Session handoff note (auto-generated).`,
      `Today's activity: ${todayEntries.length} entries (${typeSummary}).`,
    ];

    if (tagList.length > 0) {
      content.push(`Active topics: ${tagList.join(", ")}.`);
    }

    // Include the most recent non-handoff entry as context
    const lastEntry = todayEntries.find((e) => e.type !== "handoff");
    if (lastEntry) {
      const preview =
        lastEntry.content.length > 200
          ? lastEntry.content.slice(0, 200) + "..."
          : lastEntry.content;
      content.push(`Last activity (${lastEntry.type}): ${preview}`);
    }

    const entry = appendEntry(content.join("\n"), "handoff", tagList);
    index.insert(entry);
    updateDebounceTimestamp();
  } finally {
    index.close();
  }
}

main().catch((err) => {
  process.stderr.write(`stop hook error: ${err}\n`);
  process.exit(0);
});
