import { z } from "zod";
import { ContextIndex } from "../storage/sqlite.js";
import { Embedder } from "../storage/embedder.js";
import { getCurrentProject } from "../server.js";

export const contextSearchSchema = {
  query: z.string().max(10_000).describe("Search query (hybrid semantic + keyword search)"),
  type: z
    .enum(["decision", "progress", "issue", "handoff", "insight", "reference", "git_commit", "rule"])
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
  tier: z
    .enum(["ephemeral", "working", "longterm"])
    .optional()
    .describe("Filter results to specific memory tier"),
  include_archived: z
    .boolean()
    .optional()
    .default(false)
    .describe("Include archived entries in results"),
  mode: z
    .enum(["fast", "semantic", "hybrid"])
    .optional()
    .describe("Search mode: fast (BM25 keyword only), semantic (vector only), hybrid (both). Auto-detects if omitted."),
};

function autoDetectMode(query: string): "fast" | "hybrid" {
  // Only single-word ID-like queries (labels, exact keys) use BM25-only
  const words = query.trim().split(/\s+/);
  if (words.length === 1 && /^[a-z0-9_-]+$/i.test(words[0])) return "fast";
  return "hybrid";
}

export async function contextSearch(
  args: { query: string; type?: string; days?: number; limit?: number; tier?: string; include_archived?: boolean; mode?: string },
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
  const mode = (args.mode as "fast" | "semantic" | "hybrid") ?? autoDetectMode(args.query);

  let results: import("../storage/markdown.js").ContextEntry[];

  if (mode === "fast") {
    results = index.search(args.query, {
      type: args.type,
      days: args.days,
      limit: args.limit,
      includeArchived: args.include_archived,
    });
    index.bumpAccess(results.map((e) => e.id));
  } else if (mode === "semantic") {
    const embedding = await embedder.embed(args.query);
    const limit = args.limit ?? 20;
    const vecResults = index.searchVec(embedding, limit * 3);
    const entries = index.getByRowids(vecResults.map((r) => r.rowid));
    results = entries.filter((e) => {
      if (!args.include_archived && e.archived) return false;
      if (args.tier && e.tier !== args.tier) return false;
      if (args.type && e.type !== args.type) return false;
      return true;
    }).slice(0, limit);
    index.bumpAccess(results.map((e) => e.id));
  } else {
    const embedding = await embedder.embed(args.query);
    results = index.hybridSearch(args.query, embedding, {
      type: args.type,
      days: args.days,
      limit: args.limit,
      tier: args.tier,
      includeArchived: args.include_archived,
      project: getCurrentProject(),
    });
  }

  const enriched = results.map((r) => {
    const pattern = index.getPatternForEntry(r.id);
    return {
      id: r.id,
      date: r.date,
      time: r.time,
      type: r.type,
      tags: r.tags,
      content: r.content,
      ...(r.tier ? { tier: r.tier } : {}),
      ...(pattern ? { pattern: `Recurring pattern: seen ${pattern.occurrenceCount} times (pattern: ${pattern.id})` } : {}),
    };
  });

  return {
    results: enriched,
    total: enriched.length,
  };
}
