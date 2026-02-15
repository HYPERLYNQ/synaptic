import { ContextIndex } from "./sqlite.js";

export interface MaintenanceReport {
  decayed: number;
  demoted: number;
  promotedStable: number;
  promotedFrequent: number;
}

export function runMaintenance(index: ContextIndex): MaintenanceReport {
  const decayed = index.decayEphemeral();
  const demoted = index.demoteIdle();
  const promotedStable = index.promoteStable();
  const promotedFrequent = index.promoteFrequent();
  return { decayed, demoted, promotedStable, promotedFrequent };
}
