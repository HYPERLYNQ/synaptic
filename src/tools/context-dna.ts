import { z } from "zod";
import { ContextIndex } from "../storage/sqlite.js";
import { Embedder } from "../storage/embedder.js";
import { appendEntry } from "../storage/markdown.js";
import { getGitLog, isGitRepo } from "../storage/git.js";
import { getCurrentProject } from "../server.js";
import { getSessionId } from "../storage/session.js";

export const contextDnaSchema = {
  commits: z
    .number()
    .int()
    .positive()
    .max(500)
    .optional()
    .default(100)
    .describe("Maximum number of commits to analyze (default 100, max 500)"),
  repo_path: z
    .string()
    .optional()
    .describe("Path to git repository (defaults to cwd)"),
};

interface DnaResult {
  success: boolean;
  report?: string;
  commitsAnalyzed?: number;
  message?: string;
}

export async function contextDna(
  args: { commits?: number; repo_path?: string },
  index: ContextIndex,
  embedder: Embedder
): Promise<DnaResult> {
  const repoPath = args.repo_path ?? process.cwd();
  const maxCommits = args.commits ?? 100;

  if (!isGitRepo(repoPath)) {
    return { success: false, message: "Not a git repository: " + repoPath };
  }

  // 1. Fetch git commits
  const daysToFetch = Math.ceil(maxCommits / 3) + 30;
  const allCommits = getGitLog(repoPath, { days: daysToFetch });
  const commits = allCommits.slice(0, maxCommits);

  if (commits.length === 0) {
    return { success: false, message: "No commits found in repository" };
  }

  const project = getCurrentProject() ?? repoPath.split("/").pop() ?? "unknown";

  // 2. Hotspot detection
  const fileCounts = new Map<string, number>();
  for (const commit of commits) {
    for (const file of commit.files) {
      fileCounts.set(file.path, (fileCounts.get(file.path) ?? 0) + 1);
    }
  }

  const hotspots = Array.from(fileCounts.entries())
    .filter(([, count]) => count / commits.length > 0.2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([path, count]) => ({
      path,
      percentage: Math.round((count / commits.length) * 100),
    }));

  // 3. Layer analysis
  const layerCounts = new Map<string, number>();
  let totalFileChanges = 0;

  for (const commit of commits) {
    for (const file of commit.files) {
      totalFileChanges++;
      const parts = file.path.split("/");
      let layer: string;
      if (parts[0] === "src" && parts.length > 1) {
        layer = parts[1] + "/";
      } else {
        layer = parts[0] + (parts.length > 1 ? "/" : "");
      }
      layerCounts.set(layer, (layerCounts.get(layer) ?? 0) + 1);
    }
  }

  const layers = Array.from(layerCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([name, count]) => ({
      name,
      percentage: Math.round((count / totalFileChanges) * 100),
    }));

  // 4. Commit pattern analysis
  const prefixCounts = new Map<string, number>();
  let totalFilesInCommits = 0;
  let testFileCount = 0;

  for (const commit of commits) {
    const prefixMatch = commit.message.match(/^(\w+)[\s(:]/);
    if (prefixMatch) {
      const prefix = prefixMatch[1].toLowerCase();
      prefixCounts.set(prefix, (prefixCounts.get(prefix) ?? 0) + 1);
    }

    totalFilesInCommits += commit.files.length;
    for (const file of commit.files) {
      if (/test|spec|__tests__/.test(file.path)) {
        testFileCount++;
      }
    }
  }

  const avgFilesPerCommit = commits.length > 0
    ? (totalFilesInCommits / commits.length).toFixed(1)
    : "0";

  const testRatio = totalFileChanges > 0
    ? (testFileCount / totalFileChanges).toFixed(1)
    : "0";

  const topPrefixes = Array.from(prefixCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  const totalPrefixed = topPrefixes.reduce((sum, [, c]) => sum + c, 0);
  const patternStr = topPrefixes
    .map(([prefix, count]) => {
      const pct = totalPrefixed > 0
        ? Math.round((count / totalPrefixed) * 100)
        : 0;
      return `${pct}% ${prefix}`;
    })
    .join(", ");

  // 5. Co-change clusters (reuse already-fetched commits, filter to last 30 days)
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const thirtyDaysCutoff = thirtyDaysAgo.toISOString().slice(0, 10);
  const recentCommits = allCommits.filter(c => c.date >= thirtyDaysCutoff);
  const recentFiles = new Set<string>();
  for (const commit of recentCommits) {
    for (const file of commit.files) {
      recentFiles.add(file.path);
    }
  }

  const adjacency = new Map<string, Set<string>>();
  for (const file of recentFiles) {
    const coChanges = index.getCoChanges(project, file, 5)
      .filter(c => c.count >= 3);
    for (const co of coChanges) {
      if (!adjacency.has(file)) adjacency.set(file, new Set());
      if (!adjacency.has(co.file)) adjacency.set(co.file, new Set());
      adjacency.get(file)!.add(co.file);
      adjacency.get(co.file)!.add(file);
    }
  }

  // BFS to find connected components
  const visited = new Set<string>();
  const clusters: string[][] = [];

  for (const node of adjacency.keys()) {
    if (visited.has(node)) continue;
    const component: string[] = [];
    const queue = [node];
    visited.add(node);

    while (queue.length > 0) {
      const current = queue.shift()!;
      component.push(current);
      const neighbors = adjacency.get(current) ?? new Set();
      for (const neighbor of neighbors) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }

    if (component.length >= 2) {
      clusters.push(component);
    }
  }

  // Take top 5 clusters, use just filenames
  const topClusters = clusters
    .sort((a, b) => b.length - a.length)
    .slice(0, 5)
    .map(c => c.map(f => f.split("/").pop() ?? f));

  // 6. Format report
  const hotspotStr = hotspots.length > 0
    ? hotspots.map(h => `${h.path.split("/").pop()} (${h.percentage}%)`).join(", ")
    : "none detected";

  const layerStr = layers.length > 0
    ? layers.map(l => `${l.name} (${l.percentage}%)`).join(", ")
    : "flat structure";

  const clusterStr = topClusters.length > 0
    ? topClusters.map(c => `[${c.join(" + ")}]`).join(", ")
    : "none detected";

  const reportText = [
    `Codebase DNA (${project}, ${commits.length} commits analyzed):`,
    `Hotspots: ${hotspotStr}`,
    `Layers: ${layerStr}`,
    `Patterns: ${patternStr || "no prefixes detected"}. Avg ${avgFilesPerCommit} files/commit. Test ratio: ${testRatio}`,
    `Clusters: ${clusterStr}`,
  ].join("\n");

  // 7. Save as reference entry
  const entry = appendEntry(reportText, "reference", ["codebase-dna", `project:${project}`]);
  entry.tier = "longterm";

  const enrichedEntry = {
    ...entry,
    project,
    sessionId: getSessionId(),
    agentId: "dna",
  };
  const rowid = index.insert(enrichedEntry);
  const embedding = await embedder.embed(reportText);
  index.insertVec(rowid, embedding);

  // 8. Return result
  return {
    success: true,
    report: reportText,
    commitsAnalyzed: commits.length,
  };
}
