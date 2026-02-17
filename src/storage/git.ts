import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface GitCommit {
  sha: string;
  message: string;
  author: string;
  date: string;
  branch: string;
  files: Array<{ path: string; insertions: number; deletions: number }>;
}

export function isGitRepo(dir: string): boolean {
  return existsSync(join(dir, ".git"));
}

export function getCurrentBranch(repoPath: string): string {
  try {
    return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: repoPath,
      encoding: "utf-8",
    }).trim();
  } catch {
    return "unknown";
  }
}

export function getGitLog(
  repoPath: string,
  opts: { days?: number; branch?: string } = {}
): GitCommit[] {
  const days = Math.max(1, Math.floor(opts.days ?? 7));
  if (!Number.isInteger(days) || days < 1 || days > 3650) {
    throw new Error("Invalid days parameter: must be an integer between 1 and 3650");
  }

  const branch = opts.branch ?? getCurrentBranch(repoPath);
  if (!/^[a-zA-Z0-9._\-\/]+$/.test(branch) || branch.length > 200) {
    throw new Error("Invalid branch name");
  }

  try {
    const raw = execFileSync("git", [
      "log", branch, `--since=${days} days ago`,
      "--format=COMMIT_SEP%n%H%n%s%n%an%n%aI", "--numstat",
    ], { cwd: repoPath, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 });

    const commits: GitCommit[] = [];
    const blocks = raw.split("COMMIT_SEP\n").filter(Boolean);

    for (const block of blocks) {
      const lines = block.trim().split("\n");
      if (lines.length < 4) continue;

      const sha = lines[0];
      const message = lines[1];
      const author = lines[2];
      const dateStr = lines[3].slice(0, 10); // YYYY-MM-DD

      const files: GitCommit["files"] = [];
      for (let i = 4; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        const parts = line.split("\t");
        if (parts.length === 3) {
          files.push({
            insertions: parseInt(parts[0]) || 0,
            deletions: parseInt(parts[1]) || 0,
            path: parts[2],
          });
        }
      }

      commits.push({ sha, message, author, date: dateStr, branch, files });
    }

    return commits;
  } catch {
    return [];
  }
}

export function getRecentlyChangedFiles(repoPath: string): string[] {
  const files = new Set<string>();
  try {
    // Last 3 commits
    const committed = execFileSync("git", ["diff", "--name-only", "HEAD~3"], {
      cwd: repoPath,
      encoding: "utf-8",
      timeout: 3000,
    }).trim();
    if (committed) committed.split("\n").forEach(f => files.add(f));
  } catch {
    // May fail if fewer than 3 commits
  }
  try {
    // Uncommitted changes
    const uncommitted = execFileSync("git", ["diff", "--name-only"], {
      cwd: repoPath,
      encoding: "utf-8",
      timeout: 3000,
    }).trim();
    if (uncommitted) uncommitted.split("\n").forEach(f => files.add(f));
  } catch {
    // Ignore
  }
  return Array.from(files);
}

export function formatCommitAsContent(commit: GitCommit): string {
  const fileList = commit.files
    .map(f => {
      const stats = `+${f.insertions}/-${f.deletions}`;
      return `${f.path} (${stats})`;
    })
    .join(", ");
  return `[${commit.branch}] ${commit.message}\nFiles: ${fileList || "none"}`;
}
