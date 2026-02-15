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
    .enum(["decision", "progress", "issue", "handoff", "insight", "reference", "git_commit"])
    .optional()
    .describe("Filter by entry type"),
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
  args: { days?: number; type?: string },
  index: ContextIndex
): { groups: GroupedEntries[]; total: number } {
  const entries = index.list({ days: args.days, type: args.type });

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
