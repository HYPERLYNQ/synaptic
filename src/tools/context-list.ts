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
    // Checkpoint-oriented display fields — previously stripped before
    // returning to the agent, which forced /list-checkpoints to extract
    // human-readable names from content substrings.
    name?: string;
    summary?: string;
    projectRoot?: string;
    // ISO8601 UTC timestamp so the agent can compute accurate relative
    // time ("2h ago") without having to interpret date + local-tz time.
    createdAtUtc?: string;
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
      ...(entry.name ? { name: entry.name } : {}),
      ...(entry.summary ? { summary: entry.summary } : {}),
      ...(entry.projectRoot ? { projectRoot: entry.projectRoot } : {}),
      ...(createdAtUtcFor(entry.date, entry.time)
        ? { createdAtUtc: createdAtUtcFor(entry.date, entry.time) }
        : {}),
    });
  }

  return {
    groups: Array.from(grouped.values()),
    total: entries.length,
  };
}

/**
 * Best-effort ISO8601 UTC timestamp from the stored date + local-tz time.
 * Kept inline here (mirroring sync.ts' safeIsoTimestamp) so context-list
 * doesn't force a storage-layer dependency on the time-format helper.
 */
function createdAtUtcFor(date: string, time: string): string | undefined {
  const normalizedTime =
    time.length === 5 ? `${time}:00` : time.length === 8 ? time : null;
  if (!normalizedTime) return undefined;
  const d = new Date(`${date}T${normalizedTime}`);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}
