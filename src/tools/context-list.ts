import { z } from "zod";
import { ContextIndex } from "../storage/sqlite.js";

export const contextListSchema = {
  days: z
    .number()
    .int()
    .positive()
    .default(7)
    .describe("List entries from last N days"),
  type: z
    .enum(["decision", "progress", "issue", "handoff", "insight", "reference", "git_commit", "rule", "checkpoint"])
    .optional()
    .describe("Filter by entry type"),
  include_archived: z
    .boolean()
    .optional()
    .default(false)
    .describe("Include archived entries in results"),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Maximum number of entries to return (applies to checkpoint listings; other types use the default window)"),
  projectRoot: z
    .string()
    .optional()
    .describe("Filter to a specific project root path (currently only used when type='checkpoint')"),
};

interface GroupedEntries {
  date: string;
  entries: Array<{
    id: string;
    time: string;
    type: string;
    tags: string[];
    content: string;
  }>;
}

export function contextList(
  args: {
    days?: number;
    type?: string;
    include_archived?: boolean;
    limit?: number;
    projectRoot?: string;
  },
  index: ContextIndex
): { groups: GroupedEntries[]; total: number } {
  const entries = args.type === "checkpoint"
    ? index.listCheckpoints({ projectRoot: args.projectRoot, limit: args.limit })
    : index.list({ days: args.days, type: args.type, includeArchived: args.include_archived });

  // Group by date
  const grouped = new Map<string, GroupedEntries>();
  for (const entry of entries) {
    let group = grouped.get(entry.date);
    if (!group) {
      group = { date: entry.date, entries: [] };
      grouped.set(entry.date, group);
    }
    group.entries.push({
      id: entry.id,
      time: entry.time,
      type: entry.type,
      tags: entry.tags,
      content: entry.content,
    });
  }

  return {
    groups: Array.from(grouped.values()),
    total: entries.length,
  };
}
