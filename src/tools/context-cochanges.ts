import { z } from "zod";
import { ContextIndex } from "../storage/sqlite.js";
import { getCurrentProject } from "../server.js";

export const contextCochangesSchema = {
  file: z.string().max(500).describe("File path to look up co-changes for"),
  project: z
    .string()
    .optional()
    .describe("Project name. Defaults to current project."),
  limit: z
    .number()
    .int()
    .positive()
    .max(50)
    .default(10)
    .describe("Maximum results to return"),
};

export function contextCochanges(
  args: { file: string; project?: string; limit?: number },
  index: ContextIndex
): { file: string; project: string | null; cochanges: Array<{ file: string; count: number; lastSeen: string }> } {
  const project = args.project ?? getCurrentProject();
  if (!project) {
    return { file: args.file, project: null, cochanges: [] };
  }

  const cochanges = index.getCoChanges(project, args.file, args.limit ?? 10);
  return { file: args.file, project, cochanges };
}
