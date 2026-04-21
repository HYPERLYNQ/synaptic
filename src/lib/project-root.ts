import { spawnSync } from "node:child_process";
import { basename } from "node:path";

/**
 * Canonicalize a project-root path for storage and comparison.
 *
 * Windows can produce the same path with mixed separators: `git rev-parse
 * --show-toplevel` emits forward slashes ("D:/Coding/hotship"), while
 * `%USERPROFILE%\...` expansions and most native OS APIs emit backslashes
 * ("D:\\Coding\\hotship"). String-exact comparison fails across these
 * equivalent spellings. We normalize to forward slashes on every platform
 * (Linux/macOS paths never contain backslashes anyway) so all stored and
 * queried values share a single canonical form.
 *
 * We do NOT lowercase the path — Windows filesystems are case-insensitive
 * for lookups but case-preserving for display, and silently rewriting the
 * stored case would surprise users inspecting their DB.
 */
export function normalizeProjectRoot(path: string | null | undefined): string {
  if (!path) return "";
  return path.replace(/\\/g, "/");
}

export function detectProjectRoot(cwd: string): string {
  try {
    const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (result.status !== 0) return normalizeProjectRoot(cwd);
    const out = (result.stdout?.toString() ?? "").trim();
    return normalizeProjectRoot(out || cwd);
  } catch {
    return normalizeProjectRoot(cwd);
  }
}

export function knownProjectTags(projectRoot: string): string[] {
  if (!projectRoot) return [];
  const name = basename(normalizeProjectRoot(projectRoot));
  if (!name) return [];
  const stripped = name.replace(/-/g, "");
  const segments = name.split("-").filter(s => s.length >= 3);
  return Array.from(new Set([name, stripped, ...segments]));
}
