import { z } from "zod";
import { appendEntry } from "../storage/markdown.js";
import { ContextIndex } from "../storage/sqlite.js";
import { Embedder } from "../storage/embedder.js";
import { getCurrentProject } from "../server.js";
import { getSessionId } from "../storage/session.js";

export const contextSaveSchema = {
  content: z.string().max(100_000).describe("The context content to save"),
  type: z
    .enum(["decision", "progress", "issue", "handoff", "insight", "reference", "git_commit", "rule"])
    .describe("Type of context entry"),
  tags: z
    .array(z.string().max(100))
    .max(20)
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
  agent_id: z
    .string()
    .max(100)
    .regex(/^[a-zA-Z0-9_\-]+$/, "Invalid agent_id format")
    .optional()
    .describe("Optional agent identifier (defaults to 'main')"),
};

export async function contextSave(
  args: { content: string; type: string; tags: string[]; tier?: string; pinned?: boolean; agent_id?: string },
  index: ContextIndex,
  embedder: Embedder
): Promise<{ success: boolean; id: string; date: string; time: string; tier: string; pattern_detected?: string }> {
  const tier = ContextIndex.assignTier(args.type, args.tier);
  const entry = appendEntry(args.content, args.type, args.tags);
  entry.tier = tier;
  entry.pinned = args.pinned ?? false;

  // Enrich with project, session, and agent metadata
  const enrichedEntry = {
    ...entry,
    project: getCurrentProject() ?? undefined,
    sessionId: getSessionId(),
    agentId: args.agent_id ?? "main",
  };
  const rowid = index.insert(enrichedEntry);

  const embedding = await embedder.embed(args.content);
  index.insertVec(rowid, embedding);

  // Pattern detection for issues
  let patternId: string | undefined;
  if (args.type === "issue") {
    try {
      const similar = index.findSimilarIssues(embedding)
        .filter(e => e.id !== entry.id);
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
