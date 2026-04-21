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
    // Pre-computed human-friendly relative-time label (e.g. "1h ago",
    // "yesterday"). Populated server-side so rendering doesn't depend on
    // the agent's own notion of "now", which has proven unreliable.
    timeAgo?: string;
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
    const createdAtUtc = createdAtUtcFor(entry.date, entry.time);
    group.entries.push({
      id: entry.id,
      time: entry.time,
      type: entry.type,
      tags: entry.tags,
      content: entry.content,
      ...(entry.name ? { name: entry.name } : {}),
      ...(entry.summary ? { summary: entry.summary } : {}),
      ...(entry.projectRoot ? { projectRoot: entry.projectRoot } : {}),
      ...(createdAtUtc ? { createdAtUtc } : {}),
      ...(createdAtUtc ? { timeAgo: timeAgoLabel(createdAtUtc) } : {}),
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

/**
 * Turn an ISO8601 timestamp into a short human label relative to `now`.
 * Computed server-side because agent-side arithmetic against raw
 * timestamps was producing "yesterday" for entries ~1 hour old —
 * presumably due to the agent's cached notion of "now" drifting or its
 * rendering heuristic binning short durations into coarse buckets.
 * Pre-computing sidesteps that entirely.
 *
 * Thresholds:
 *   < 60s                        → "just now"
 *   < 1h                         → "Nmin ago"
 *   < 24h                        → "Nh ago"
 *   < 48h AND previous local day → "yesterday"
 *   < 7d                         → "Nd ago"
 *   otherwise                    → ISO date (YYYY-MM-DD)
 *
 * Future timestamps (badly-stored entries, clock skew) return "in the
 * future" rather than silently going negative.
 */
export function timeAgoLabel(iso: string, now: Date = new Date()): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "unknown";
  const diffMs = now.getTime() - t;
  if (diffMs < 0) return "in the future";
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return "just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}min ago`;

  // For anything >= 1h, consult LOCAL calendar dates first. This keeps
  // "yesterday" meaningful when an entry fell on the previous local day
  // even if the raw duration is only 14-16h, and keeps short today-ago
  // durations as "Nh ago" instead of "yesterday".
  const then = new Date(t);
  const sameLocalDate = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
  if (sameLocalDate(then, now)) {
    const diffHr = Math.floor(diffMin / 60);
    return `${diffHr}h ago`;
  }
  const yesterday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() - 1
  );
  if (sameLocalDate(then, yesterday)) return "yesterday";

  const diffDay = Math.floor(diffMin / 60 / 24);
  if (diffDay < 7) return `${diffDay}d ago`;
  return iso.slice(0, 10); // fall back to YYYY-MM-DD
}
