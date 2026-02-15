/**
 * SessionStart hook: Injects rules + recent context into Claude's conversation.
 * Stdout from this hook is automatically added to Claude's context.
 *
 * Injection priority (token budget ~3200 chars):
 * 1. Rules (always full, never truncated)
 * 2. Recent context (last 3 days, compact format)
 * 3. Most recent handoff note (1 only)
 * 4. Recurring patterns
 * 5. Maintenance summary (only if something changed)
 */

import { ContextIndex } from "../storage/sqlite.js";
import { ensureDirs } from "../storage/paths.js";
import { runMaintenance } from "../storage/maintenance.js";
import { Embedder } from "../storage/embedder.js";
import { contextGitIndex } from "../tools/context-git-index.js";

const TOKEN_BUDGET_CHARS = 3200; // ~800 tokens

interface SessionStartInput {
  source: string;
}

async function main(): Promise<void> {
  ensureDirs();

  let input: SessionStartInput = { source: "startup" };
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

  const index = new ContextIndex();

  // Run maintenance (decay, promotion) before listing
  const maintenance = runMaintenance(index);

  try {
    // Auto-index recent git commits (silent)
    const embedder = new Embedder();
    try {
      await contextGitIndex({ days: 1 }, index, embedder);
    } catch {
      // Don't block session start
    }

    const lines: string[] = [];
    let charCount = 0;

    // --- SECTION 1: Rules (always full, never truncated) ---
    const rules = index.listRules();
    if (rules.length > 0) {
      lines.push("# Rules (ALWAYS follow, NO exceptions)");
      for (const rule of rules) {
        lines.push(`- ${rule.content}`);
      }
      lines.push("");
    }
    charCount = lines.join("\n").length;

    // --- SECTION 2: Recent context (last 3 days, compact) ---
    const budgetForContext: string[] = [];
    const recent = index.list({ days: 3 })
      .filter(e => e.tier !== "ephemeral" && e.type !== "handoff" && e.type !== "rule");
    if (recent.length > 0) {
      budgetForContext.push("## Recent Context (last 3 days)");
      let currentDate = "";
      for (const entry of recent.slice(0, 15)) {
        if (entry.date !== currentDate) {
          currentDate = entry.date;
          budgetForContext.push(`\n### ${currentDate.slice(5)}`);
        }
        budgetForContext.push(`- ${entry.time} [${entry.type}] ${entry.content}`);
      }
      budgetForContext.push("");
    }

    // --- SECTION 3: Recent handoff (1 only) ---
    const budgetForHandoff: string[] = [];
    const handoffs = index.list({ days: 7, type: "handoff" }).slice(0, 1);
    if (handoffs.length > 0) {
      const h = handoffs[0];
      budgetForHandoff.push("## Recent Handoff");
      budgetForHandoff.push(`- ${h.date.slice(5)} ${h.time}: ${h.content}`);
      budgetForHandoff.push("");
    }

    // --- SECTION 4: Recurring patterns ---
    const budgetForPatterns: string[] = [];
    const patterns = index.getActivePatterns();
    if (patterns.length > 0) {
      budgetForPatterns.push("## Recurring Issues");
      for (const p of patterns) {
        budgetForPatterns.push(`- "${p.label}" — ${p.occurrenceCount}x (last: ${p.lastSeen.slice(5)})`);
      }
      budgetForPatterns.push("");
    }

    // --- SECTION 5: Maintenance (only if something happened) ---
    const budgetForMaint: string[] = [];
    const maintTotal = maintenance.decayed + maintenance.demoted + maintenance.promotedStable + maintenance.promotedFrequent;
    if (maintTotal > 0) {
      const parts: string[] = [];
      if (maintenance.decayed > 0) parts.push(`${maintenance.decayed} archived`);
      if (maintenance.demoted > 0) parts.push(`${maintenance.demoted} demoted`);
      if (maintenance.promotedStable > 0) parts.push(`${maintenance.promotedStable} promoted`);
      if (maintenance.promotedFrequent > 0) parts.push(`${maintenance.promotedFrequent} promoted`);
      budgetForMaint.push(`_Maintenance: ${parts.join(", ")}._`);
    }

    // --- Assemble within budget ---
    const sections = [budgetForContext, budgetForHandoff, budgetForPatterns, budgetForMaint];
    for (const section of sections) {
      const sectionText = section.join("\n");
      if (charCount + sectionText.length <= TOKEN_BUDGET_CHARS) {
        lines.push(...section);
        charCount += sectionText.length;
      }
    }

    // Always append entry count (tiny)
    const stats = index.status();
    lines.push(`\n_${stats.totalEntries} total entries in context store._`);

    if (lines.length <= 1) return; // Nothing to inject

    process.stdout.write(lines.join("\n"));
  } finally {
    index.close();
  }
}

main().catch((err) => {
  process.stderr.write(`session-start hook error: ${err}\n`);
  process.exit(0);
});
