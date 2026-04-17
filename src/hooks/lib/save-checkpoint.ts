import { appendEntry } from "../../storage/markdown.js";
import { ContextIndex } from "../../storage/sqlite.js";
import { Embedder } from "../../storage/embedder.js";

export interface SaveCheckpointArgs {
  name: string;
  summary?: string;
  content: string;
  tags: string[];
  projectRoot: string;
  referencedEntryIds?: string[];
}

export interface SaveCheckpointResult {
  id: string;
  deduped: boolean;
}

export async function saveCheckpoint(args: SaveCheckpointArgs): Promise<SaveCheckpointResult> {
  const index = new ContextIndex();
  try {
    const existing = index.findCheckpointByName(args.name);
    if (existing) {
      return { id: existing.id, deduped: true };
    }

    const tags = Array.from(new Set(["auto-save", "checkpoint", ...args.tags]));
    const entry = appendEntry(args.content, "checkpoint", tags, {
      name: args.name,
      summary: args.summary,
      projectRoot: args.projectRoot,
      referencedEntryIds: args.referencedEntryIds,
      pinned: true,
    });
    entry.tier = ContextIndex.assignTier("checkpoint");
    const rowid = index.insert(entry);

    try {
      const embedder = new Embedder();
      const embedding = await embedder.embed(args.content);
      index.insertVec(rowid, embedding);
    } catch (err) {
      console.error("[save-checkpoint] embedding failed (entry still saved):", err);
    }

    return { id: entry.id, deduped: false };
  } finally {
    index.close();
  }
}
