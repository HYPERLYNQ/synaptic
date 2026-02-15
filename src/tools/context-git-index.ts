import { z } from "zod";
import { ContextIndex } from "../storage/sqlite.js";
import { Embedder } from "../storage/embedder.js";
import { appendEntry } from "../storage/markdown.js";
import { getGitLog, formatCommitAsContent, isGitRepo } from "../storage/git.js";

export const contextGitIndexSchema = {
  repo_path: z
    .string()
    .optional()
    .describe("Path to git repository (defaults to cwd)"),
  days: z
    .number()
    .int()
    .positive()
    .default(7)
    .describe("Index commits from last N days"),
  branch: z
    .string()
    .optional()
    .describe("Branch to index (defaults to current branch)"),
};

export async function contextGitIndex(
  args: { repo_path?: string; days?: number; branch?: string },
  index: ContextIndex,
  embedder: Embedder
): Promise<{ indexed: number; skipped: number; repo: string }> {
  const repoPath = args.repo_path ?? process.cwd();

  if (!isGitRepo(repoPath)) {
    return { indexed: 0, skipped: 0, repo: repoPath };
  }

  const commits = getGitLog(repoPath, { days: args.days, branch: args.branch });
  let indexed = 0;
  let skipped = 0;

  for (const commit of commits) {
    const shaTag = `sha:${commit.sha.slice(0, 12)}`;

    // Dedup: skip if already indexed
    if (index.hasEntryWithTag(shaTag)) {
      skipped++;
      continue;
    }

    const content = formatCommitAsContent(commit);
    const entry = appendEntry(content, "git_commit", [shaTag, commit.branch]);

    // Auto-tier: recent = working, older = ephemeral
    const commitDate = new Date(commit.date);
    const ageDays = (Date.now() - commitDate.getTime()) / (1000 * 60 * 60 * 24);
    entry.tier = ageDays < 7 ? "working" : "ephemeral";

    const rowid = index.insert(entry);
    const embedding = await embedder.embed(content);
    index.insertVec(rowid, embedding);
    indexed++;
  }

  return { indexed, skipped, repo: repoPath };
}
