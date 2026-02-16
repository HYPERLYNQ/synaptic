/**
 * SessionStart hook: Injects rules + recent context into Claude's conversation.
 * Stdout from this hook is automatically added to Claude's context.
 *
 * Injection priority (token budget ~4000 chars):
 * 1. Rules (always full, never truncated)
 * 2. Recent context (last 3 days, compact format, same-project boosted)
 * 3. Most recent handoff note (1 only)
 * 4. Recurring patterns
 * 5. Related context (from recently changed git files)
 * 6. Maintenance summary (only if something changed)
 */

import { ContextIndex } from "../storage/sqlite.js";
import { ensureDirs } from "../storage/paths.js";
import { runMaintenance } from "../storage/maintenance.js";
import { Embedder } from "../storage/embedder.js";
import { contextGitIndex } from "../tools/context-git-index.js";
import { detectProject } from "../storage/project.js";
import { getRecentlyChangedFiles, isGitRepo } from "../storage/git.js";

const TOKEN_BUDGET_CHARS = 4000; // ~1000 tokens

interface SessionStartInput {
  source: string;
}

async function main(): Promise<void> {
  ensureDirs();

  const currentProject = detectProject();

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

  // Auto-install the auto-distill rule if not present
  const rules = index.listRules();
  const hasAutoDistill = rules.some(r => r.label === "auto-distill");
  if (!hasAutoDistill) {
    index.saveRule(
      "auto-distill",
      "When a significant decision is made, a problem is solved, a correction is given, or something surprising is discovered, save it as an insight to Synaptic immediately using context_save. Tag corrections with 'correction'. Don't wait for session end."
    );
  }

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

    // --- SECTION 1b: Pending rules for approval (high priority, right after rules) ---
    const budgetForPending: string[] = [];
    const pendingRules = index.list({ days: 7 })
      .filter(e => e.tags.includes("pending_rule") && !e.archived);

    if (pendingRules.length > 0) {
      budgetForPending.push("## Pending rules (approve or dismiss)");
      for (const pr of pendingRules.slice(0, 3)) {
        const labelTag = pr.tags.find(t => t.startsWith("proposed-label:"));
        const label = labelTag ? labelTag.replace("proposed-label:", "") : "unnamed";
        budgetForPending.push(`- "${label}": ${pr.content.slice(0, 100)}`);
      }
      budgetForPending.push("_Ask user to accept (context_save_rule) or dismiss (context_archive)._");
      budgetForPending.push("");
    }

    // Rule conflicts
    const conflicts = index.list({ days: 7 })
      .filter(e => e.tags.includes("rule_conflict") && !e.archived);

    if (conflicts.length > 0) {
      if (budgetForPending.length === 0) {
        budgetForPending.push("## Pending rules (approve or dismiss)");
      }
      for (const c of conflicts.slice(0, 2)) {
        budgetForPending.push(`- CONFLICT: ${c.content.slice(0, 120)}`);
      }
      if (budgetForPending[budgetForPending.length - 1] !== "") {
        budgetForPending.push("");
      }
    }

    // --- SECTION 2: Recent context (last 3 days, compact, project-boosted) ---
    const budgetForContext: string[] = [];
    const recent = index.list({ days: 3 })
      .filter(e => e.tier !== "ephemeral" && e.type !== "handoff" && e.type !== "rule")
      .sort((a, b) => {
        // Same project first
        const aMatch = a.project === currentProject ? 1 : 0;
        const bMatch = b.project === currentProject ? 1 : 0;
        if (aMatch !== bMatch) return bMatch - aMatch;
        // Then by date/time desc
        return 0; // already sorted by date desc from list()
      });
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
        const isFailure = p.label.startsWith("Pre-commit failure");
        if (isFailure) {
          const allEntries = index.list({ days: 30 });
          const fileTags = p.entryIds
            .flatMap(id => {
              const entry = allEntries.find(e => e.id === id);
              return entry ? entry.tags.filter(t => t.startsWith("file:")) : [];
            })
            .map(t => t.replace("file:", ""));
          const uniqueFiles = [...new Set(fileTags)].slice(0, 3);
          const fileStr = uniqueFiles.length > 0 ? ` (${uniqueFiles.join(", ")})` : "";
          budgetForPatterns.push(`- pre-commit failure${fileStr} — ${p.occurrenceCount}x (last: ${p.lastSeen.slice(5)})`);
        } else {
          budgetForPatterns.push(`- "${p.label}" — ${p.occurrenceCount}x (last: ${p.lastSeen.slice(5)})`);
        }
      }
      budgetForPatterns.push("");
    }

    // --- SECTION 5: Related context from git activity ---
    const budgetForRelated: string[] = [];
    const budgetForCochanges: string[] = [];
    const cwd = process.cwd();
    if (isGitRepo(cwd)) {
      const recentFiles = getRecentlyChangedFiles(cwd);
      if (recentFiles.length > 0) {
        // Search for entries related to recently changed files
        const fileQuery = recentFiles.slice(0, 5).join(" ");
        try {
          const related = index.search(fileQuery, { limit: 3 })
            .filter(e => e.type !== "handoff" && e.type !== "git_commit");
          if (related.length > 0) {
            budgetForRelated.push("## Related context");
            for (const r of related) {
              const ago = Math.floor((Date.now() - new Date(r.date).getTime()) / (1000 * 60 * 60 * 24));
              budgetForRelated.push(`- [${ago}d ago] ${r.content.slice(0, 120)}`);
            }
            budgetForRelated.push("");
          }
        } catch {
          // Don't block session start
        }

        // Co-change suggestions
        if (currentProject) {
          const suggestions: string[] = [];
          for (const file of recentFiles.slice(0, 5)) {
            const cochanges = index.getCoChanges(currentProject, file, 3)
              .filter(c => c.count >= 3 && !recentFiles.includes(c.file));
            if (cochanges.length > 0) {
              const pairs = cochanges.map(c => `${c.file} (${c.count}x)`).join(", ");
              suggestions.push(`- ${file} → usually also changes: ${pairs}`);
            }
          }
          if (suggestions.length > 0) {
            budgetForCochanges.push("## Predictive context");
            budgetForCochanges.push(...suggestions);
            budgetForCochanges.push("");
          }
        }
      }
    }

    // --- SECTION 6: Cross-project insights ---
    const budgetForCrossProject: string[] = [];
    if (currentProject) {
      const crossProject = index.list({ days: 7 })
        .filter(e =>
          e.project !== null &&
          e.project !== currentProject &&
          e.type !== "handoff" &&
          e.type !== "git_commit" &&
          e.tier !== "ephemeral"
        )
        .slice(0, 3);

      if (crossProject.length > 0) {
        budgetForCrossProject.push("## From other projects");
        for (const entry of crossProject) {
          budgetForCrossProject.push(`- [${entry.project}] ${entry.content.slice(0, 120)}`);
        }
        budgetForCrossProject.push("");
      }
    }

    // --- SECTION 7: Maintenance (only if something happened) ---
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
    const sections = [budgetForPending, budgetForContext, budgetForHandoff, budgetForPatterns, budgetForRelated, budgetForCochanges, budgetForCrossProject, budgetForMaint];
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
