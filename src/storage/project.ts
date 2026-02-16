import { execSync } from "node:child_process";
import { basename } from "node:path";
import { isGitRepo } from "./git.js";

let cachedProject: string | null = null;

export function detectProject(cwd?: string): string | null {
  if (cachedProject !== null) return cachedProject;
  const dir = cwd ?? process.cwd();

  // Try git remote name first
  if (isGitRepo(dir)) {
    try {
      const remote = execSync("git remote get-url origin", {
        cwd: dir,
        encoding: "utf-8",
        timeout: 3000,
      }).trim();
      // Parse repo name from URL: git@github.com:user/repo.git or https://github.com/user/repo.git
      const match = remote.match(/\/([^/]+?)(?:\.git)?$/) ?? remote.match(/:([^/]+?)(?:\.git)?$/);
      if (match) {
        cachedProject = match[1];
        return cachedProject;
      }
    } catch {
      // Fall through to folder name
    }
  }

  // Fall back to folder name
  cachedProject = basename(dir) || null;
  return cachedProject;
}

export function resetProjectCache(): void {
  cachedProject = null;
}
