/**
 * CLI command for running smart dedup cleanup.
 *
 * Usage:
 *   synaptic cleanup [--dry-run] [--aggressive]
 */

import { ContextIndex } from "../storage/sqlite.js";
import { ensureDirs } from "../storage/paths.js";

const AGGRESSIVE_THRESHOLDS: Record<string, number> = {
  insight: 0.85,
  progress: 0.85,
  git_commit: 0.85,
  decision: 0.92,
  reference: 0.92,
  rule: 0.95,
};

export async function cleanupCommand(args: string[]): Promise<void> {
  const dryRun = args.includes("--dry-run");
  const aggressive = args.includes("--aggressive");

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
synaptic cleanup — smart duplicate detection and cleanup

Usage:
  synaptic cleanup [--dry-run] [--aggressive]

Flags:
  --dry-run      Preview what would be merged (no changes made)
  --aggressive   Lower similarity thresholds per entry type

Default mode uses a 0.90 cosine similarity threshold (conservative).
Aggressive mode uses type-specific thresholds:
  insight, progress, git_commit: 0.85
  decision, reference: 0.92
    `.trim());
    return;
  }

  ensureDirs();
  const index = new ContextIndex();

  try {
    const status = index.status();
    const mode = aggressive ? "aggressive" : "conservative";
    console.log(`Synaptic Cleanup${dryRun ? " (DRY RUN)" : ""}`);
    console.log(`${"=".repeat(40)}`);
    console.log(`Mode: ${mode}`);
    console.log(`Entries scanned: ${status.totalEntries - status.archivedCount}`);
    console.log();

    const actions = index.smartDedup({
      threshold: aggressive ? 0.80 : 0.90,
      typeThresholds: aggressive ? AGGRESSIVE_THRESHOLDS : undefined,
      dryRun,
    });

    if (actions.length === 0) {
      console.log("No duplicates found. Database is clean.");
      return;
    }

    // Print detailed results
    const subsetCount = actions.filter(a => a.reason === "subset").length;
    const similarityCount = actions.filter(a => a.reason === "similarity").length;
    const archivedTotal = actions.reduce((sum, a) => sum + a.archivedIds.length, 0);

    if (dryRun) {
      console.log("Would merge the following:\n");
      for (const action of actions) {
        const simStr = action.similarity ? ` (similarity: ${(action.similarity * 100).toFixed(1)}%)` : "";
        console.log(`  [${action.reason}]${simStr}`);
        console.log(`    Survivor: ${action.survivorId} — "${action.survivorContent}..."`);
        console.log(`    Archive:  ${action.archivedIds.join(", ")}`);
        console.log();
      }
    }

    console.log(`${"=".repeat(40)}`);
    console.log(`Duplicate groups found: ${actions.length}`);
    console.log(`  Subset matches: ${subsetCount}`);
    console.log(`  Similarity matches: ${similarityCount}`);
    console.log(`Entries ${dryRun ? "would be " : ""}archived: ${archivedTotal}`);
    console.log(`Survivors updated: ${actions.length}`);

    if (dryRun) {
      console.log(`\nRun without --dry-run to apply changes.`);
    }
  } finally {
    index.close();
  }
}
