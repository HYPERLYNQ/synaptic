#!/usr/bin/env node

/**
 * Synaptic pre-commit guardian.
 * Called by .git/hooks/pre-commit.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { ContextIndex } from "../storage/sqlite.js";
import { Embedder } from "../storage/embedder.js";
import { appendEntry } from "../storage/markdown.js";
import { ensureDirs } from "../storage/paths.js";
import { detectProject } from "../storage/project.js";
import { getSessionId } from "../storage/session.js";

interface CheckResult {
  command: string;
  label: string;
  success: boolean;
  output: string;
}

function detectScripts(cwd: string): Array<{ script: string; label: string }> {
  const pkgPath = join(cwd, "package.json");
  if (!existsSync(pkgPath)) return [];

  let scripts: Record<string, string>;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    scripts = pkg.scripts ?? {};
  } catch {
    return [];
  }

  const checks: Array<{ script: string; label: string }> = [];

  if (scripts.lint) checks.push({ script: "lint", label: "lint" });
  else if (scripts.eslint) checks.push({ script: "eslint", label: "lint" });

  if (scripts.typecheck) checks.push({ script: "typecheck", label: "typecheck" });
  else if (scripts.tsc) checks.push({ script: "tsc", label: "typecheck" });
  else if (scripts.check) checks.push({ script: "check", label: "typecheck" });

  if (scripts.test) checks.push({ script: "test", label: "test" });

  return checks;
}

function getStagedFiles(): string[] {
  try {
    const output = execSync("git diff --cached --name-only", {
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
    return output ? output.split("\n") : [];
  } catch {
    return [];
  }
}

function runCheck(script: string, label: string, cwd: string): CheckResult {
  try {
    const output = execSync(`npm run ${script} 2>&1`, {
      cwd,
      encoding: "utf-8",
      timeout: 120000,
      maxBuffer: 5 * 1024 * 1024,
    });
    return { command: `npm run ${script}`, label, success: true, output: output.slice(-2000) };
  } catch (err) {
    const error = err as { stdout?: string; stderr?: string };
    const output = (error.stdout ?? "") + (error.stderr ?? "");
    const lines = output.split("\n");
    const tail = lines.slice(-50).join("\n");
    return { command: `npm run ${script}`, label, success: false, output: tail };
  }
}

function enrichAndInsert(
  index: ContextIndex,
  entry: import("../storage/markdown.js").ContextEntry
): number {
  return index.insert({
    ...entry,
    project: detectProject() ?? undefined,
    sessionId: getSessionId(),
    agentId: "pre-commit",
  });
}

async function main(): Promise<void> {
  const cwd = process.cwd();
  const scripts = detectScripts(cwd);

  if (scripts.length === 0) {
    process.exit(0);
  }

  const stagedFiles = getStagedFiles();
  const fileTags = stagedFiles.slice(0, 10).map(f => `file:${f}`);

  for (const { script, label } of scripts) {
    const result = runCheck(script, label, cwd);

    if (!result.success) {
      ensureDirs();
      const index = new ContextIndex();
      const embedder = new Embedder();

      try {
        const chainId = randomBytes(4).toString("hex");
        const content = [
          `Pre-commit failure: \`${result.command}\` exited with error`,
          `Files: ${stagedFiles.slice(0, 5).join(", ") || "unknown"}`,
          `Error: ${result.output.slice(-500)}`,
        ].join("\n");

        const entry = appendEntry(content, "issue", [
          "failure", "pre-commit", `cmd:${label}`, `chain:${chainId}`, ...fileTags,
        ]);
        entry.tier = "working";

        const rowid = enrichAndInsert(index, entry);
        const embedding = await embedder.embed(content);
        index.insertVec(rowid, embedding);

        console.error(`\n[Synaptic] Failure captured (chain:${chainId})`);
      } finally {
        index.close();
      }

      process.exit(1);
    }
  }

  // All checks passed — look for recent failures to create resolution entries
  if (stagedFiles.length > 0) {
    try {
      ensureDirs();
      const index = new ContextIndex();
      const embedder = new Embedder();

      try {
        const recentEntries = index.list({ days: 7 });
        const recentFailures = recentEntries.filter(e =>
          e.tags.includes("failure") &&
          e.tags.includes("pre-commit") &&
          stagedFiles.some(f => e.tags.includes(`file:${f}`))
        );

        if (recentFailures.length > 0) {
          const lastFailure = recentFailures[0];
          const chainTag = lastFailure.tags.find(t => t.startsWith("chain:"));

          const resolvedFiles = stagedFiles.filter(f =>
            recentFailures.some(e => e.tags.includes(`file:${f}`))
          ).slice(0, 5);

          const content = `Resolved: ${resolvedFiles.join(", ")} now pass pre-commit checks`;
          const tags = [
            "failure-resolved", "pre-commit",
            ...(chainTag ? [chainTag] : []),
            ...resolvedFiles.map(f => `file:${f}`),
          ];

          const entry = appendEntry(content, "progress", tags);
          entry.tier = "ephemeral";
          const rowid = enrichAndInsert(index, entry);
          const embedding = await embedder.embed(content);
          index.insertVec(rowid, embedding);
        }
      } finally {
        index.close();
      }
    } catch {
      // Don't block commits
    }
  }

  process.exit(0);
}

main().catch((err) => {
  console.error(`[Synaptic] Pre-commit error: ${err.message ?? err}`);
  process.exit(0);
});
