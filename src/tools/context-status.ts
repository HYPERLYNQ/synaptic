import { ContextIndex } from "../storage/sqlite.js";
import { readSyncState } from "../storage/sync.js";

export function contextStatus(index: ContextIndex): {
  totalEntries: number;
  dateRange: { earliest: string; latest: string } | null;
  dbSizeBytes: number;
  dbSizeHuman: string;
  tierDistribution: Record<string, number>;
  archivedCount: number;
  activePatterns: number;
  sync: {
    enabled: boolean;
    machineId: string | null;
    machineName: string | null;
    repo: string | null;
    lastPushAt: string | null;
    lastPullAt: string | null;
    knownMachines: number;
  };
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

  const syncState = readSyncState();
  const sync = {
    enabled: syncState?.config.enabled ?? false,
    machineId: syncState?.config.machineId ?? null,
    machineName: syncState?.config.machineName ?? null,
    repo: syncState ? `${syncState.config.repoOwner}/${syncState.config.repoName}` : null,
    lastPushAt: syncState?.lastPushAt ?? null,
    lastPullAt: syncState?.lastPullAt ?? null,
    knownMachines: syncState ? Object.keys(syncState.remoteCursors).length : 0,
  };

  return { ...stats, dbSizeHuman, sync };
}
