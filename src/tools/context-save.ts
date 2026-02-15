import { z } from "zod";
import { appendEntry } from "../storage/markdown.js";
import { ContextIndex } from "../storage/sqlite.js";
import { Embedder } from "../storage/embedder.js";

export const contextSaveSchema = {
  content: z.string().describe("The context content to save"),
  type: z
    .enum(["decision", "progress", "issue", "handoff", "insight", "reference", "git_commit"])
    .describe("Type of context entry"),
  tags: z
    .array(z.string())
    .default([])
    .describe("Tags for categorization (e.g. project names, topics)"),
  tier: z
    .enum(["ephemeral", "working", "longterm"])
    .optional()
    .describe("Memory tier override. Auto-assigned by type if omitted."),
  pinned: z
    .boolean()
    .optional()
    .default(false)
    .describe("Pin entry to prevent auto-decay"),
};

export async function contextSave(
  args: { content: string; type: string; tags: string[]; tier?: string; pinned?: boolean },
  index: ContextIndex,
  embedder: Embedder
): Promise<{ success: boolean; id: string; date: string; time: string; tier: string; pattern_detected?: string }> {
  const tier = ContextIndex.assignTier(args.type, args.tier);
  const entry = appendEntry(args.content, args.type, args.tags);
  entry.tier = tier;
  entry.pinned = args.pinned ?? false;
  const rowid = index.insert(entry);

  const embedding = await embedder.embed(args.content);
  index.insertVec(rowid, embedding);

  // Pattern detection for issues
  let patternId: string | undefined;
  if (args.type === "issue") {
    try {
      const similar = index.findSimilarIssues(embedding);
      if (similar.length >= 2) {
        const allIds = [entry.id, ...similar.map(e => e.id)];
        patternId = index.createOrUpdatePattern(args.content, allIds);
      }
    } catch {
      // Don't fail the save if pattern detection errors
    }
  }

  return {
    success: true,
    id: entry.id,
    date: entry.date,
    time: entry.time,
    tier,
    ...(patternId ? { pattern_detected: patternId } : {}),
  };
}
