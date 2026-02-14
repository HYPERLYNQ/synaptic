import { z } from "zod";
import { ContextIndex } from "../storage/sqlite.js";

export const contextSearchSchema = {
  query: z.string().describe("Search query (BM25 keyword search)"),
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

export function contextSearch(
  args: { query: string; type?: string; days?: number; limit?: number },
  index: ContextIndex
): { results: Array<{ id: string; date: string; time: string; type: string; tags: string[]; content: string }>; total: number } {
  const results = index.search(args.query, {
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
