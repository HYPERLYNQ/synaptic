#!/usr/bin/env node

/**
 * Synaptic commit-msg hook.
 * Called by .git/hooks/commit-msg with the commit message file path as $1.
 *
 * Reads the commit message, loads rules, extracts forbidden patterns from
 * negative rules, and blocks commits that contain violations.
 */

import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { ContextIndex } from "../storage/sqlite.js";
import { ensureDirs } from "../storage/paths.js";
import { extractCheckPatterns, checkMessageAgainstPatterns } from "./rule-patterns.js";

async function main(): Promise<void> {
  const commitMsgFile = process.argv[2];
  if (!commitMsgFile) {
    // No file argument — don't block
    process.exit(0);
  }

  // Validate the file path is within .git/ to prevent arbitrary file reads
  const resolvedPath = resolve(commitMsgFile);
  const gitDir = join(process.cwd(), ".git");
  if (resolvedPath !== gitDir && !resolvedPath.startsWith(gitDir + "/")) {
    process.exit(0);
  }

  let message: string;
  try {
    message = readFileSync(resolvedPath, "utf-8");
  } catch {
    // Can't read message file — don't block
    process.exit(0);
  }

  let rules: Array<{ label: string; content: string }>;
  try {
    ensureDirs();
    const index = new ContextIndex();
    try {
      rules = index.listRules();
    } finally {
      index.close();
    }
  } catch {
    // DB error — don't block
    process.exit(0);
  }

  if (rules.length === 0) {
    process.exit(0);
  }

  // Check each rule's patterns against the commit message
  for (const rule of rules) {
    const patterns = extractCheckPatterns(rule.content);
    const violation = checkMessageAgainstPatterns(message, patterns);
    if (violation) {
      console.error(`\n[Synaptic] Commit blocked by rule "${rule.label}":`);
      console.error(`  Rule: ${rule.content}`);
      console.error(`  Found: "${violation}" in commit message`);
      console.error("");
      process.exit(1);
    }
  }

  process.exit(0);
}

main().catch(() => {
  // Unexpected error — don't block
  process.exit(0);
});
