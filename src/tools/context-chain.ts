import { z } from "zod";
import { ContextIndex } from "../storage/sqlite.js";

export const contextChainSchema = {
  chain_id: z
    .string()
    .describe("The chain ID to retrieve (e.g., 'a1b2c3d4' — without the 'chain:' prefix)"),
};

export function contextChain(
  args: { chain_id: string },
  index: ContextIndex
): { chain_id: string; entries: Array<Record<string, unknown>>; total: number } {
  const chainTag = args.chain_id.startsWith("chain:")
    ? args.chain_id
    : `chain:${args.chain_id}`;

  const allRecent = index.list({ days: 365 });
  const chainEntries = allRecent
    .filter(e => e.tags.includes(chainTag))
    .sort((a, b) => {
      const dateCompare = a.date.localeCompare(b.date);
      if (dateCompare !== 0) return dateCompare;
      return a.time.localeCompare(b.time);
    });

  return {
    chain_id: args.chain_id,
    entries: chainEntries.map(e => ({
      id: e.id,
      date: e.date,
      time: e.time,
      type: e.type,
      tags: e.tags,
      content: e.content,
    })),
    total: chainEntries.length,
  };
}
