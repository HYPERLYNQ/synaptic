import { ContextIndex } from "../storage/sqlite.js";

export function contextListRules(
  index: ContextIndex
): { rules: Array<{ label: string; content: string; date: string }> } {
  const rules = index.listRules();
  return {
    rules: rules.map((r) => ({
      label: r.label,
      content: r.content,
      date: r.date,
    })),
  };
}
