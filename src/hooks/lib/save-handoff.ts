import { appendEntry } from "../../storage/markdown.js";
import { ContextIndex } from "../../storage/sqlite.js";
import { Embedder } from "../../storage/embedder.js";

export interface SaveHandoffArgs {
  content: string;
  tags: string[];
  pinned?: boolean;
}

export async function saveHandoff(args: SaveHandoffArgs): Promise<{ id: string }> {
  const tags = Array.from(new Set(["auto-save", ...args.tags]));
  const entry = appendEntry(args.content, "handoff", tags);
  entry.tier = ContextIndex.assignTier("handoff");
  entry.pinned = args.pinned ?? false;

  const index = new ContextIndex();
  const rowid = index.insert(entry);

  try {
    const embedder = new Embedder();
    const embedding = await embedder.embed(args.content);
    index.insertVec(rowid, embedding);
  } catch (err) {
    console.error("[save-handoff] embedding failed (entry still saved):", err);
  }

  return { id: entry.id };
}
