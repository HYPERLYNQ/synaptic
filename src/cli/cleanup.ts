/**
 * CLI command for running smart dedup cleanup.
 *
 * Usage:
 *   synaptic cleanup [--dry-run] [--aggressive] [--purge-pending-dupes]
 */

import { ContextIndex } from "../storage/sqlite.js";
import { ensureDirs } from "../storage/paths.js";
import { contentHash } from "../storage/search-utils.js";

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
  const purgePendingDupes = args.includes("--purge-pending-dupes");

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
synaptic cleanup — smart duplicate detection and cleanup

Usage:
  synaptic cleanup [--dry-run] [--aggressive] [--purge-pending-dupes]

Flags:
  --dry-run               Preview what would be merged (no changes made)
  --aggressive            Lower similarity thresholds per entry type, also purges empty handoffs
  --purge-pending-dupes   Archive duplicate pending_rule entries (keep newest per label)

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

    let pendingPurged = 0;
    let handoffPurged = 0;

    // Step 1: Purge duplicate pending_rules
    if (purgePendingDupes || aggressive) {
      console.log("--- Pending Rule Dedup ---");
      const allEntries = index.list({ days: 365 });
      const pendingRules = allEntries.filter(e => e.tags.includes("pending_rule"));

      // Group by proposed-label tag
      const byLabel = new Map<string, typeof pendingRules>();
      for (const entry of pendingRules) {
        const labelTag = entry.tags.find(t => t.startsWith("proposed-label:")) || "unlabeled";
        if (!byLabel.has(labelTag)) byLabel.set(labelTag, []);
        byLabel.get(labelTag)!.push(entry);
      }

      for (const [label, entries] of byLabel) {
        if (entries.length <= 1) continue;
        // Sort by date desc, keep newest
        entries.sort((a, b) => b.date.localeCompare(a.date) || b.time.localeCompare(a.time));
        const toArchive = entries.slice(1).map(e => e.id);
        if (!dryRun) {
          index.mergeTagsInto(entries[0].id, toArchive);
          index.archiveEntries(toArchive);
        }
        pendingPurged += toArchive.length;
        console.log(`  ${label}: kept 1, ${dryRun ? "would archive" : "archived"} ${toArchive.length}`);
      }

      // Also catch pending_rules with same content hash but different labels
      const survivorIds = new Set<string>();
      for (const [, entries] of byLabel) {
        if (entries.length > 0) survivorIds.add(entries[0].id);
      }
      const remainingPending = pendingRules.filter(e => !survivorIds.has(e.id) || byLabel.get(
        e.tags.find(t => t.startsWith("proposed-label:")) || "unlabeled"
      )?.length === 1);

      const byHash = new Map<string, typeof remainingPending>();
      for (const entry of remainingPending) {
        const hash = contentHash(entry.content);
        if (!byHash.has(hash)) byHash.set(hash, []);
        byHash.get(hash)!.push(entry);
      }

      for (const [, entries] of byHash) {
        if (entries.length <= 1) continue;
        entries.sort((a, b) => b.date.localeCompare(a.date));
        const toArchive = entries.slice(1).map(e => e.id);
        if (!dryRun) {
          index.mergeTagsInto(entries[0].id, toArchive);
          index.archiveEntries(toArchive);
        }
        pendingPurged += toArchive.length;
      }

      console.log(`Pending rule duplicates: ${pendingPurged} ${dryRun ? "would be archived" : "archived"}\n`);
    }

    // Step 2: Purge useless ephemeral handoffs
    if (aggressive) {
      console.log("--- Empty Handoff Cleanup ---");
      const allEntries = index.list({ days: 365 });
      const handoffs = allEntries.filter(e =>
        e.type === "handoff" &&
        e.tier === "ephemeral" &&
        /^Activity: \d+ entries/.test(e.content) &&
        !e.content.includes("Learnings:")
      );

      if (handoffs.length > 0) {
        if (!dryRun) {
          index.archiveEntries(handoffs.map(e => e.id));
        }
        handoffPurged = handoffs.length;
        console.log(`Empty handoffs: ${handoffPurged} ${dryRun ? "would be archived" : "archived"}\n`);
      } else {
        console.log("No empty handoffs found.\n");
      }
    }

    // Step 3: Smart dedup
    console.log("--- Smart Dedup ---");
    const actions = index.smartDedup({
      threshold: aggressive ? 0.80 : 0.90,
      typeThresholds: aggressive ? AGGRESSIVE_THRESHOLDS : undefined,
      dryRun,
      minAgeDays: aggressive ? 1 : 3,
    });

    if (actions.length === 0) {
      console.log("No duplicates found.\n");
    } else {
      const subsetCount = actions.filter(a => a.reason === "subset").length;
      const similarityCount = actions.filter(a => a.reason === "similarity").length;
      const archivedTotal = actions.reduce((sum, a) => sum + a.archivedIds.length, 0);

      if (dryRun) {
        for (const action of actions) {
          const simStr = action.similarity ? ` (${(action.similarity * 100).toFixed(1)}%)` : "";
          console.log(`  [${action.reason}]${simStr}`);
          console.log(`    Survivor: ${action.survivorId} — "${action.survivorContent}..."`);
          console.log(`    Archive:  ${action.archivedIds.join(", ")}`);
        }
      }

      console.log(`Smart dedup: ${actions.length} groups (subset: ${subsetCount}, similarity: ${similarityCount})`);
      console.log(`Entries ${dryRun ? "would be " : ""}archived: ${archivedTotal}\n`);
    }

    // Step 4: Rebuild FTS5 if changes were made
    const totalChanges = pendingPurged + handoffPurged + actions.length;
    if (!dryRun && totalChanges > 0) {
      index.rebuildFts();
      console.log("FTS5 index rebuilt.");
    }

    // Summary
    console.log(`\n${"=".repeat(40)}`);
    console.log(`Total entries ${dryRun ? "would be " : ""}cleaned: ${pendingPurged + handoffPurged + actions.reduce((s, a) => s + a.archivedIds.length, 0)}`);
    if (dryRun) {
      console.log(`Run without --dry-run to apply changes.`);
    }
  } finally {
    index.close();
  }
}
