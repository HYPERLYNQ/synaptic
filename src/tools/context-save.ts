import { z } from "zod";
import { appendEntry } from "../storage/markdown.js";
import { ContextIndex } from "../storage/sqlite.js";
import { Embedder } from "../storage/embedder.js";

export const contextSaveSchema = {
  content: z.string().describe("The context content to save"),
  type: z
    .enum(["decision", "progress", "issue", "handoff", "insight", "reference"])
    .describe("Type of context entry"),
  tags: z
    .array(z.string())
    .default([])
    .describe("Tags for categorization (e.g. project names, topics)"),
};

export async function contextSave(
  args: { content: string; type: string; tags: string[] },
  index: ContextIndex,
  embedder: Embedder
): Promise<{ success: boolean; id: string; date: string; time: string }> {
  const entry = appendEntry(args.content, args.type, args.tags);
  const rowid = index.insert(entry);

  const embedding = await embedder.embed(args.content);
  index.insertVec(rowid, embedding);

  return {
    success: true,
    id: entry.id,
    date: entry.date,
    time: entry.time,
  };
}
