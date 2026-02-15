import { z } from "zod";
import { ContextIndex } from "../storage/sqlite.js";

export const contextSaveRuleSchema = {
  label: z.string().describe("Unique short key for the rule (e.g. 'no-emoji', 'commit-style')"),
  content: z.string().describe("The rule text — what Claude must always follow"),
};

export function contextSaveRule(
  args: { label: string; content: string },
  index: ContextIndex
): { success: boolean; label: string; action: string } {
  const existing = index.listRules().find((r) => r.label === args.label);
  index.saveRule(args.label, args.content);
  return {
    success: true,
    label: args.label,
    action: existing ? "updated" : "created",
  };
}
