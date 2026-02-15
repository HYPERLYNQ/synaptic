import { z } from "zod";
import { ContextIndex } from "../storage/sqlite.js";

export const contextDeleteRuleSchema = {
  label: z.string().describe("Label of the rule to delete"),
};

export function contextDeleteRule(
  args: { label: string },
  index: ContextIndex
): { success: boolean; label: string } {
  const deleted = index.deleteRule(args.label);
  return {
    success: deleted,
    label: args.label,
  };
}
