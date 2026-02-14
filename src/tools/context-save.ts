import { z } from "zod";
import { appendEntry } from "../storage/markdown.js";
import { ContextIndex } from "../storage/sqlite.js";

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

export function contextSave(
  args: { content: string; type: string; tags: string[] },
  index: ContextIndex
): { success: boolean; id: string; date: string; time: string } {
  const entry = appendEntry(args.content, args.type, args.tags);
  index.insert(entry);
  return {
    success: true,
    id: entry.id,
    date: entry.date,
    time: entry.time,
  };
}
