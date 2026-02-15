/**
 * SessionStart hook: Injects recent context entries into Claude's conversation.
 * Stdout from this hook is automatically added to Claude's context.
 *
 * Receives JSON on stdin: { source: "startup"|"resume"|"compact"|"clear", ... }
 */

import { ContextIndex } from "../storage/sqlite.js";
import { ensureDirs } from "../storage/paths.js";
import { runMaintenance } from "../storage/maintenance.js";

interface SessionStartInput {
  source: string;
}

async function main(): Promise<void> {
  ensureDirs();

  // Read stdin
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
    // Use defaults if stdin parsing fails
  }

  const index = new ContextIndex();

  // Run maintenance (decay, promotion) before listing
  const maintenance = runMaintenance(index);

  try {
    // Get recent entries (last 3 days), excluding ephemeral tier
    const recent = index.list({ days: 3 }).filter(e => e.tier !== "ephemeral");

    // Get handoff entries specifically (last 7 days), limit to 3
    const handoffs = index.list({ days: 7, type: "handoff" }).slice(0, 3);

    if (recent.length === 0 && handoffs.length === 0) {
      return; // No context to inject
    }

    const lines: string[] = [];
    lines.push("# Persistent Context (auto-injected)");
    lines.push("");

    if (handoffs.length > 0) {
      lines.push("## Recent Handoff Notes");
      for (const entry of handoffs) {
        lines.push(`- **${entry.date} ${entry.time}** [${entry.tags.join(", ")}]: ${entry.content}`);
      }
      lines.push("");
    }

    // Show recent entries grouped by date (exclude handoffs already shown)
    const handoffIds = new Set(handoffs.map((h) => h.id));
    const nonHandoff = recent.filter((e) => !handoffIds.has(e.id));

    if (nonHandoff.length > 0) {
      lines.push("## Recent Context (last 3 days)");
      let currentDate = "";
      for (const entry of nonHandoff.slice(0, 15)) {
        if (entry.date !== currentDate) {
          currentDate = entry.date;
          lines.push(`\n### ${currentDate}`);
        }
        const tagStr = entry.tags.length > 0 ? ` [${entry.tags.join(", ")}]` : "";
        lines.push(`- **${entry.time}** (${entry.type})${tagStr}: ${entry.content}`);
      }
      lines.push("");
    }

    // Consolidation candidates
    try {
      const groups = index.findConsolidationCandidates();
      if (groups.length > 0) {
        lines.push("## Consolidation Candidates");
        lines.push("The following entry groups are semantically similar and should be consolidated.");
        lines.push("For each group: summarize into one entry via `context_save` (type: the appropriate type, tier: longterm), then archive originals via `context_archive`.");
        lines.push("");
        for (const group of groups) {
          lines.push(`**Group** (${group.entries.length} entries, topic: ${group.label}):`);
          for (const e of group.entries) {
            const preview = e.content.length > 120 ? e.content.slice(0, 120) + "..." : e.content;
            lines.push(`- [${e.id}] ${e.date} (${e.type}): ${preview}`);
          }
          lines.push("");
        }
      }
    } catch {
      // Don't block session start if consolidation detection fails
    }

    // Maintenance summary
    const maintTotal = maintenance.decayed + maintenance.demoted + maintenance.promotedStable + maintenance.promotedFrequent;
    if (maintTotal > 0) {
      const parts: string[] = [];
      if (maintenance.decayed > 0) parts.push(`${maintenance.decayed} archived`);
      if (maintenance.demoted > 0) parts.push(`${maintenance.demoted} demoted`);
      if (maintenance.promotedStable > 0) parts.push(`${maintenance.promotedStable} promoted to longterm`);
      if (maintenance.promotedFrequent > 0) parts.push(`${maintenance.promotedFrequent} promoted to working`);
      lines.push(`_Maintenance: ${parts.join(", ")}._`);
    }

    const stats = index.status();
    lines.push(`_${stats.totalEntries} total entries in context store._`);

    // Output to stdout - this gets injected into Claude's context
    process.stdout.write(lines.join("\n"));
  } finally {
    index.close();
  }
}

main().catch((err) => {
  process.stderr.write(`session-start hook error: ${err}\n`);
  process.exit(0); // Don't block session start on errors
});
