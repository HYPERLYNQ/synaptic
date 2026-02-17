import { z } from "zod";
import { ContextIndex } from "../storage/sqlite.js";

export const contextResolvePatternSchema = {
  pattern_id: z.string().max(200).describe("Pattern ID to mark as resolved"),
};

export function contextResolvePattern(
  args: { pattern_id: string },
  index: ContextIndex
): { resolved: boolean; pattern_id: string } {
  const resolved = index.resolvePattern(args.pattern_id);
  return { resolved, pattern_id: args.pattern_id };
}
