import { execFileSync, execSync } from "node:child_process";
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
    return execSync("git rev-parse --abbrev-ref HEAD", {
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
  const days = opts.days ?? 7;
  const branch = opts.branch ?? getCurrentBranch(repoPath);
  try {
    // Get commits with stats (execFileSync to avoid shell injection via branch name)
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

export function formatCommitAsContent(commit: GitCommit): string {
  const fileList = commit.files
    .map(f => {
      const stats = `+${f.insertions}/-${f.deletions}`;
      return `${f.path} (${stats})`;
    })
    .join(", ");
  return `[${commit.branch}] ${commit.message}\nFiles: ${fileList || "none"}`;
}
