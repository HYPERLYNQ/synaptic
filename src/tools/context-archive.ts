import { z } from "zod";
import { ContextIndex } from "../storage/sqlite.js";

export const contextArchiveSchema = {
  ids: z
    .array(z.string())
    .min(1)
    .describe("Entry IDs to archive"),
};

export function contextArchive(
  args: { ids: string[] },
  index: ContextIndex
): { archived: number; skipped_pinned: number } {
  const total = args.ids.length;
  const archived = index.archiveEntries(args.ids);
  return { archived, skipped_pinned: total - archived };
}
