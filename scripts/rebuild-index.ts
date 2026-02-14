/**
 * CLI script to rebuild the SQLite FTS index from markdown source files.
 * Usage: node build/scripts/rebuild-index.js
 */

import { ContextIndex } from "../src/storage/sqlite.js";
import { listMarkdownFiles, parseMarkdownFile } from "../src/storage/markdown.js";
import { ensureDirs } from "../src/storage/paths.js";

function main(): void {
  ensureDirs();
  const index = new ContextIndex();

  console.log("Rebuilding SQLite index from markdown files...");

  // Clear existing index
  index.clearAll();

  const files = listMarkdownFiles();
  console.log(`Found ${files.length} markdown files.`);

  let totalEntries = 0;
  for (const file of files) {
    const entries = parseMarkdownFile(file);
    for (const entry of entries) {
      index.insert(entry);
    }
    totalEntries += entries.length;
    console.log(`  ${file}: ${entries.length} entries`);
  }

  console.log(`Done. Indexed ${totalEntries} entries total.`);
  index.close();
}

main();
