export interface RankInput {
  id: string;
  content: string;
  projectRoot: string | null;
  tags: string[];
  pinned: boolean;
  createdAtMs: number;
}

export interface ScoreBreakdown {
  length:  number;
  project: number;
  pinned:  number;
  recency: number;
}

export interface ScoredEntry<T extends RankInput = RankInput> {
  entry: T;
  total: number;
  breakdown: ScoreBreakdown;
}

const W_LENGTH = 0.35;
const W_PROJECT = 0.35;
const W_PINNED = 0.15;
const W_RECENCY = 0.15;

const HALF_LIFE_HOURS = 72;
const LENGTH_NORM_CHARS = 500;

function projectMatch(entry: RankInput, currentRoot: string | null): number {
  if (!currentRoot) return 0;
  // Normalize both sides to handle Windows mixed-separator spellings
  // (e.g. "D:/foo" vs "D:\\foo") which otherwise fail exact equality.
  const normRoot = currentRoot.replace(/\\/g, "/");
  const normEntry = entry.projectRoot ? entry.projectRoot.replace(/\\/g, "/") : "";
  if (normEntry && normEntry === normRoot) return 1.0;
  const basename = normRoot.split("/").filter(Boolean).pop() ?? "";
  if (!basename) return 0;
  if (entry.tags.includes(basename)) return 0.3;
  return 0;
}

export function scoreEntry<T extends RankInput>(
  entry: T,
  currentRoot: string | null,
  nowMs: number = Date.now()
): ScoredEntry<T> {
  const lengthRaw  = Math.min(entry.content.length / LENGTH_NORM_CHARS, 1.0);
  const projectRaw = projectMatch(entry, currentRoot);
  const pinnedRaw  = entry.pinned ? 1 : 0;
  const hoursOld   = Math.max(0, (nowMs - entry.createdAtMs) / (3600 * 1000));
  const recencyRaw = Math.exp(-hoursOld / HALF_LIFE_HOURS);

  const breakdown: ScoreBreakdown = {
    length:  W_LENGTH  * lengthRaw,
    project: W_PROJECT * projectRaw,
    pinned:  W_PINNED  * pinnedRaw,
    recency: W_RECENCY * recencyRaw,
  };
  const total = breakdown.length + breakdown.project + breakdown.pinned + breakdown.recency;
  return { entry, total, breakdown };
}

export function rankEntries<T extends RankInput>(
  entries: T[],
  currentRoot: string | null,
  nowMs: number = Date.now()
): T[] {
  return entries
    .map((e, i) => ({ scored: scoreEntry(e, currentRoot, nowMs), i }))
    .sort((a, b) => {
      if (b.scored.total !== a.scored.total) return b.scored.total - a.scored.total;
      return a.i - b.i;
    })
    .map(x => x.scored.entry);
}
