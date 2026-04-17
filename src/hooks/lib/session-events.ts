import type { ContextIndex } from "../../storage/sqlite.js";

const MEANINGFUL_TYPES = new Set(["git_commit", "checkpoint", "decision"]);
const MEANINGFUL_TAG_PREFIXES = ["trigger:plan-write", "trigger:spec-write"];

export function countMeaningfulSessionEvents(
  index: ContextIndex,
  sessionId: string
): number {
  if (!sessionId) return 0;
  const entries = index.list({ days: 1 });
  let count = 0;
  for (const e of entries) {
    if ((e as unknown as { sessionId?: string }).sessionId !== sessionId) continue;
    if (MEANINGFUL_TYPES.has(e.type)) { count++; continue; }
    if (e.tags?.some(t => MEANINGFUL_TAG_PREFIXES.some(p => t.startsWith(p)))) {
      count++;
    }
  }
  return count;
}
