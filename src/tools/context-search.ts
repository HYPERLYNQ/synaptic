import { z } from "zod";
import { ContextIndex } from "../storage/sqlite.js";
import { Embedder } from "../storage/embedder.js";

export const contextSearchSchema = {
  query: z.string().describe("Search query (hybrid semantic + keyword search)"),
  type: z
    .enum(["decision", "progress", "issue", "handoff", "insight", "reference"])
    .optional()
    .describe("Filter by entry type"),
  days: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Only search entries from last N days"),
  limit: z
    .number()
    .int()
    .positive()
    .max(100)
    .default(20)
    .describe("Maximum results to return"),
};

export async function contextSearch(
  args: { query: string; type?: string; days?: number; limit?: number },
  index: ContextIndex,
  embedder: Embedder
): Promise<{
  results: Array<{
    id: string;
    date: string;
    time: string;
    type: string;
    tags: string[];
    content: string;
  }>;
  total: number;
}> {
  const embedding = await embedder.embed(args.query);
  const results = index.hybridSearch(args.query, embedding, {
    type: args.type,
    days: args.days,
    limit: args.limit,
  });

  return {
    results: results.map((r) => ({
      id: r.id,
      date: r.date,
      time: r.time,
      type: r.type,
      tags: r.tags,
      content: r.content,
    })),
    total: results.length,
  };
}
