/**
 * PreCompact hook: Saves a progress snapshot before context compaction.
 *
 * Receives JSON on stdin: { trigger: "manual"|"auto", custom_instructions?: string }
 */

import { appendEntry } from "../storage/markdown.js";
import { ContextIndex } from "../storage/sqlite.js";
import { Embedder } from "../storage/embedder.js";
import { ensureDirs } from "../storage/paths.js";

interface PreCompactInput {
  trigger: string;
  custom_instructions?: string;
}

async function main(): Promise<void> {
  ensureDirs();

  let input: PreCompactInput = { trigger: "auto" };
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
  const embedder = new Embedder();

  try {
    const content = [
      `Context compaction triggered (${input.trigger}).`,
      `Saving progress snapshot before compaction.`,
    ];

    if (input.custom_instructions) {
      content.push(`User instructions: ${input.custom_instructions}`);
    }

    // Get a summary of recent work to preserve
    const recent = index.list({ days: 1 });
    if (recent.length > 0) {
      content.push("");
      content.push(`Active session had ${recent.length} entries today.`);
      const types = new Map<string, number>();
      for (const entry of recent) {
        types.set(entry.type, (types.get(entry.type) ?? 0) + 1);
      }
      const typeSummary = Array.from(types.entries())
        .map(([t, c]) => `${t}:${c}`)
        .join(", ");
      content.push(`Entry types: ${typeSummary}`);
    }

    const entry = appendEntry(content.join("\n"), "progress", ["compaction-snapshot"]);
    entry.tier = ContextIndex.assignTier(entry.type);
    const rowid = index.insert(entry);
    const embedding = await embedder.embed(entry.content);
    index.insertVec(rowid, embedding);
  } finally {
    index.close();
  }
}

main().catch((err) => {
  process.stderr.write(`pre-compact hook error: ${err}\n`);
  process.exit(0);
});
