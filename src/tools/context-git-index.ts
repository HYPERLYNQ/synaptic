import { z } from "zod";
import { resolve } from "node:path";
import { realpathSync } from "node:fs";
import { ContextIndex } from "../storage/sqlite.js";
import { Embedder } from "../storage/embedder.js";
import { appendEntry } from "../storage/markdown.js";
import { getGitLog, formatCommitAsContent, isGitRepo } from "../storage/git.js";
import { getCurrentProject } from "../server.js";

export const contextGitIndexSchema = {
  repo_path: z
    .string()
    .optional()
    .describe("Path to git repository (defaults to cwd)"),
  days: z
    .number()
    .int()
    .positive()
    .max(365)
    .default(7)
    .describe("Index commits from last N days"),
  branch: z
    .string()
    .regex(/^[a-zA-Z0-9._\-\/]+$/, "Invalid branch name characters")
    .max(200)
    .optional()
    .describe("Branch to index (defaults to current branch)"),
};

export async function contextGitIndex(
  args: { repo_path?: string; days?: number; branch?: string },
  index: ContextIndex,
  embedder: Embedder
): Promise<{ indexed: number; skipped: number; repo: string }> {
  const repoPath = args.repo_path ? resolve(args.repo_path) : process.cwd();

  // Prevent path traversal — repo_path must be within cwd (resolve symlinks)
  if (args.repo_path) {
    try {
      const cwdReal = realpathSync(process.cwd());
      const repoReal = realpathSync(repoPath);
      if (!repoReal.startsWith(cwdReal + "/") && repoReal !== cwdReal) {
        throw new Error("repo_path must be within the current working directory");
      }
    } catch (e) {
      if (e instanceof Error && e.message.includes("repo_path")) throw e;
      throw new Error("repo_path must be a valid, accessible directory");
    }
  }

  if (!isGitRepo(repoPath)) {
    return { indexed: 0, skipped: 0, repo: "." };
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

    // Generate co-change pairs (skip commits with 20+ files — too noisy)
    const project = getCurrentProject();
    if (project && commit.files.length >= 2 && commit.files.length < 20) {
      const filePaths = commit.files.map(f => f.path);
      for (let i = 0; i < filePaths.length; i++) {
        for (let j = i + 1; j < filePaths.length; j++) {
          index.upsertFilePair(project, filePaths[i], filePaths[j], commit.date);
        }
      }
    }
  }

  return { indexed, skipped, repo: repoPath };
}
