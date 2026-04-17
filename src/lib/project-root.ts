import { spawnSync } from "node:child_process";
import { basename } from "node:path";

export function detectProjectRoot(cwd: string): string {
  try {
    const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (result.status !== 0) return cwd;
    const out = (result.stdout?.toString() ?? "").trim();
    return out || cwd;
  } catch {
    return cwd;
  }
}

export function knownProjectTags(projectRoot: string): string[] {
  if (!projectRoot) return [];
  const name = basename(projectRoot);
  if (!name) return [];
  const stripped = name.replace(/-/g, "");
  const segments = name.split("-").filter(s => s.length >= 3);
  return Array.from(new Set([name, stripped, ...segments]));
}
