#!/usr/bin/env node
/**
 * Synaptic v1.5.0 one-shot data migration.
 * - Backfills project_root on existing entries via tag heuristics
 * - Archives legacy empty-count handoffs (length(content) < 100)
 * - Converts v1.4.0 slash-command auto-saves (handoff with trigger:checkpoint-cmd)
 *   into type='checkpoint'
 *
 * Safe to re-run. Prints a report. --dry-run shows intended changes without writing.
 */
const { DatabaseSync } = require("node:sqlite");
const { homedir } = require("node:os");
const { join } = require("node:path");

const DB_PATH = join(homedir(), ".synaptic", "context.db");
const DRY_RUN = process.argv.includes("--dry-run");

// Known project name -> absolute path heuristics. Extend as needed.
const KNOWN_PROJECTS = {
  "rtx-5090-tracker": join(homedir(), "rtx-5090-tracker"),
  "synaptic":         join(homedir(), "synaptic"),
};

function main() {
  const db = new DatabaseSync(DB_PATH);
  const report = { backfilledRoots: 0, archivedEmpties: 0, convertedCheckpoints: 0 };

  try {
    // Check if entries table exists
    const tableExists = db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='entries'"
    ).get();

    if (!tableExists) {
      console.log(JSON.stringify({ dryRun: DRY_RUN, ...report }, null, 2));
      return;
    }

    // 1. Backfill project_root via known-project tags.
    for (const [tagName, absPath] of Object.entries(KNOWN_PROJECTS)) {
      const rows = db.prepare(
        "SELECT id, tags FROM entries WHERE (project_root IS NULL OR project_root = '') AND tags LIKE ?"
      ).all(`%${tagName}%`);

      for (const row of rows) {
        const tagList = String(row.tags).split(",").map(t => t.trim());
        if (!tagList.includes(tagName)) continue;
        if (!DRY_RUN) {
          db.prepare("UPDATE entries SET project_root = ? WHERE id = ?").run(absPath, row.id);
        }
        report.backfilledRoots++;
      }
    }

    // 2. Archive legacy empty-count handoffs.
    const empties = db.prepare(
      "SELECT id FROM entries WHERE type = 'handoff' AND archived = 0 AND length(content) < 100"
    ).all();
    for (const row of empties) {
      if (!DRY_RUN) {
        db.prepare("UPDATE entries SET archived = 1 WHERE id = ?").run(row.id);
      }
      report.archivedEmpties++;
    }

    // 3. Convert v1.4.0 slash-command auto-saves to type='checkpoint'.
    const candidates = db.prepare(
      "SELECT id, content FROM entries WHERE type = 'handoff' AND tags LIKE '%trigger:checkpoint-cmd%' AND archived = 0"
    ).all();
    for (const row of candidates) {
      const nameMatch = /\*\*Name:\*\*\s+(.+)/.exec(String(row.content));
      const name = nameMatch
        ? nameMatch[1].trim().toLowerCase().replace(/[^a-z0-9]+/g, "-")
        : null;
      if (!DRY_RUN) {
        db.prepare(
          "UPDATE entries SET type = 'checkpoint', name = ?, pinned = 1 WHERE id = ?"
        ).run(name, row.id);
      }
      report.convertedCheckpoints++;
    }

    console.log(JSON.stringify({ dryRun: DRY_RUN, ...report }, null, 2));
  } finally {
    db.close();
  }
}

main();
