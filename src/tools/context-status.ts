import { ContextIndex } from "../storage/sqlite.js";

export function contextStatus(index: ContextIndex): {
  totalEntries: number;
  dateRange: { earliest: string; latest: string } | null;
  dbSizeBytes: number;
  dbSizeHuman: string;
  tierDistribution: Record<string, number>;
  archivedCount: number;
  activePatterns: number;
} {
  const stats = index.status();

  let dbSizeHuman: string;
  if (stats.dbSizeBytes < 1024) {
    dbSizeHuman = `${stats.dbSizeBytes} B`;
  } else if (stats.dbSizeBytes < 1024 * 1024) {
    dbSizeHuman = `${(stats.dbSizeBytes / 1024).toFixed(1)} KB`;
  } else {
    dbSizeHuman = `${(stats.dbSizeBytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  return { ...stats, dbSizeHuman };
}
