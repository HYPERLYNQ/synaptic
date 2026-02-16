import { ContextIndex } from "./sqlite.js";

export interface MaintenanceReport {
  decayed: number;
  demoted: number;
  promotedStable: number;
  promotedFrequent: number;
  consolidated: number;
}

export function runMaintenance(index: ContextIndex): MaintenanceReport {
  const decayed = index.decayEphemeral();
  const demoted = index.demoteIdle();
  const promotedStable = index.promoteStable();
  const promotedFrequent = index.promoteFrequent();
  const consolidated = consolidate(index);
  return { decayed, demoted, promotedStable, promotedFrequent, consolidated };
}

function consolidate(index: ContextIndex): number {
  const groups = index.findConsolidationCandidates(0.75);
  if (groups.length === 0) return 0;

  let consolidated = 0;

  for (const group of groups) {
    // Filter to entries older than 3 days
    const now = Date.now();
    const threeDaysMs = 3 * 24 * 60 * 60 * 1000;
    const eligible = group.entries.filter(e => {
      const entryDate = new Date(e.date).getTime();
      return (now - entryDate) > threeDaysMs;
    });

    if (eligible.length < 3) continue; // Need 3+ to consolidate

    // Skip rule and reference types
    if (eligible.some(e => e.type === "rule" || e.type === "reference")) continue;

    // Find survivor: highest access count
    eligible.sort((a, b) => (b.accessCount ?? 0) - (a.accessCount ?? 0));
    const survivor = eligible[0];
    const others = eligible.slice(1);

    // Merge tags from others into survivor
    index.mergeTagsInto(survivor.id, others.map(e => e.id));

    // Update survivor content with consolidation note
    const updatedContent = `${survivor.content}\n[Consolidated from ${eligible.length} entries]`;
    index.updateEntryContent(survivor.id, updatedContent);

    // Promote survivor if ephemeral
    if (survivor.tier === "ephemeral") {
      index.changeTier(survivor.id, "working");
    }

    // Archive others
    index.archiveEntries(others.map(e => e.id));

    consolidated++;
  }

  return consolidated;
}
