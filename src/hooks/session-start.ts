/**
 * SessionStart hook: Injects recent context entries into Claude's conversation.
 * Stdout from this hook is automatically added to Claude's context.
 *
 * Receives JSON on stdin: { source: "startup"|"resume"|"compact"|"clear", ... }
 */

import { ContextIndex } from "../storage/sqlite.js";
import { ensureDirs } from "../storage/paths.js";

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

  try {
    // Get recent entries (last 3 days)
    const recent = index.list({ days: 3 });

    // Get handoff entries specifically (last 7 days)
    const handoffs = index.list({ days: 7, type: "handoff" });

    if (recent.length === 0 && handoffs.length === 0) {
      return; // No context to inject
    }

    const lines: string[] = [];
    lines.push("# Persistent Context (auto-injected)");
    lines.push("");

    if (handoffs.length > 0) {
      lines.push("## Recent Handoff Notes");
      for (const entry of handoffs.slice(0, 5)) {
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
