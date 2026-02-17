import { z } from "zod";
import { ContextIndex } from "../storage/sqlite.js";
import { getSessionId } from "../storage/session.js";

export const contextSessionSchema = {
  session_id: z
    .string()
    .max(200)
    .optional()
    .describe("Session ID to query. Defaults to current session."),
  type: z
    .enum(["decision", "progress", "issue", "handoff", "insight", "reference", "git_commit", "rule"])
    .optional()
    .describe("Filter by entry type"),
};

export function contextSession(
  args: { session_id?: string; type?: string },
  index: ContextIndex
): { entries: Array<Record<string, unknown>>; total: number } {
  const sessionId = args.session_id ?? getSessionId();
  const results = index.listBySession(sessionId, { type: args.type });

  return {
    entries: results.map(r => ({
      id: r.id,
      date: r.date,
      time: r.time,
      type: r.type,
      tags: r.tags,
      content: r.content,
      agent_id: r.agentId ?? null,
    })),
    total: results.length,
  };
}
