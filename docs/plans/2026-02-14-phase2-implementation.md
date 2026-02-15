# Phase 2: Smart Search — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add hybrid BM25 + vector search with temporal decay to Synaptic's context_search tool.

**Architecture:** Transformers.js embeds text at save time into 384-dim vectors stored via sqlite-vec. Search runs both BM25 (FTS5) and vector (cosine distance) queries, merges with RRF, applies temporal decay.

**Tech Stack:** @huggingface/transformers, sqlite-vec, node:sqlite DatabaseSync, existing TypeScript MCP server.

---

### Task 1: Install Dependencies

**Files:**
- Modify: `package.json`

**Step 1: Install @huggingface/transformers and sqlite-vec**

Run:
```bash
cd /home/hyperlynq/projects/Coding/claude-context-tool
npm install @huggingface/transformers sqlite-vec
```

**Step 2: Verify installation**

Run:
```bash
node -e "import('sqlite-vec').then(m => console.log('sqlite-vec OK')); import('@huggingface/transformers').then(m => console.log('transformers OK'))"
```
Expected: Both print OK (no native build errors).

**Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "feat: add transformers.js and sqlite-vec dependencies for Phase 2"
```

---

### Task 2: Add Models Directory to Paths

**Files:**
- Modify: `src/storage/paths.ts`

**Step 1: Add MODELS_DIR export**

Add `MODELS_DIR` to `src/storage/paths.ts` and ensure it's created in `ensureDirs()`:

```typescript
// After existing exports:
export const MODELS_DIR = join(BASE_DIR, "models");

// In ensureDirs(), add:
mkdirSync(MODELS_DIR, { recursive: true });
```

Final file should have: `CONTEXT_DIR`, `DB_DIR`, `DB_PATH`, `MODELS_DIR` exports, and `ensureDirs()` creating all three directories.

**Step 2: Build and verify**

Run:
```bash
npm run build
```
Expected: Clean compile, no errors.

**Step 3: Commit**

```bash
git add src/storage/paths.ts
git commit -m "feat: add MODELS_DIR path for embedding model cache"
```

---

### Task 3: Create Embedder Singleton

**Files:**
- Create: `src/storage/embedder.ts`

**Step 1: Write the embedder**

Create `src/storage/embedder.ts`:

```typescript
import { pipeline, env, type FeatureExtractionPipeline } from "@huggingface/transformers";
import { MODELS_DIR } from "./paths.js";

export class Embedder {
  private extractor: FeatureExtractionPipeline | null = null;

  async embed(text: string): Promise<Float32Array> {
    if (!this.extractor) {
      env.cacheDir = MODELS_DIR;
      this.extractor = await pipeline(
        "feature-extraction",
        "Xenova/all-MiniLM-L6-v2",
        { dtype: "q8" }
      );
    }
    const result = await this.extractor(text, {
      pooling: "mean",
      normalize: true,
    });
    return result.data as Float32Array;
  }
}
```

**Step 2: Build and verify**

Run:
```bash
npm run build
```
Expected: Clean compile. If there are type issues with `FeatureExtractionPipeline`, check the actual export name from @huggingface/transformers and adjust the import.

**Step 3: Smoke test the embedder**

Run:
```bash
node -e "
import { Embedder } from './build/src/storage/embedder.js';
const e = new Embedder();
const v = await e.embed('test sentence');
console.log('dims:', v.length, 'type:', v.constructor.name);
console.log('first 5:', Array.from(v.slice(0, 5)).map(n => n.toFixed(4)));
"
```
Expected: `dims: 384 type: Float32Array` and 5 float values. First run will download the model (~25MB) to `~/.claude-context/models/`.

**Step 4: Commit**

```bash
git add src/storage/embedder.ts
git commit -m "feat: add Embedder singleton wrapping Transformers.js pipeline"
```

---

### Task 4: Add Vector Storage to ContextIndex

**Files:**
- Modify: `src/storage/sqlite.ts`

**Step 1: Add sqlite-vec import and load extension**

At the top of `src/storage/sqlite.ts`, add:
```typescript
import * as sqliteVec from "sqlite-vec";
```

In the constructor, change:
```typescript
this.db = new DatabaseSync(dbPath);
```
to:
```typescript
this.db = new DatabaseSync(dbPath, { allowExtension: true });
sqliteVec.load(this.db);
```

**Step 2: Add vec_entries table to init()**

In the `init()` method, after the existing index creation statements, add:

```typescript
this.db.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS vec_entries USING vec0(
    embedding FLOAT[384]
  )
`);
```

Note: vec0 virtual tables auto-create a rowid. We'll match rowids between `entries` and `vec_entries`.

**Step 3: Add insertVec method**

Add after the existing `insert()` method:

```typescript
insertVec(entryRowid: number, embedding: Float32Array): void {
  const stmt = this.db.prepare(`
    INSERT INTO vec_entries(rowid, embedding)
    VALUES (?, ?)
  `);
  stmt.run(entryRowid, new Uint8Array(embedding.buffer));
}
```

**Step 4: Modify insert() to return rowid**

Change `insert()` return type from `void` to `number`:

```typescript
insert(entry: ContextEntry): number {
  const stmt = this.db.prepare(`
    INSERT OR REPLACE INTO entries (id, date, time, type, tags, content, source_file)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    entry.id,
    entry.date,
    entry.time,
    entry.type,
    entry.tags.join(", "),
    entry.content,
    entry.sourceFile
  );
  const row = this.db.prepare("SELECT last_insert_rowid() as rowid").get() as Record<string, unknown>;
  return row.rowid as number;
}
```

**Step 5: Add searchVec method**

```typescript
searchVec(
  embedding: Float32Array,
  limit: number
): Array<{ rowid: number; distance: number }> {
  const stmt = this.db.prepare(`
    SELECT rowid, distance
    FROM vec_entries
    WHERE embedding MATCH ?
    ORDER BY distance
    LIMIT ?
  `);
  const rows = stmt.all(
    new Uint8Array(embedding.buffer),
    limit
  ) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    rowid: r.rowid as number,
    distance: r.distance as number,
  }));
}
```

**Step 6: Add getByRowids helper**

```typescript
getByRowids(rowids: number[]): ContextEntry[] {
  if (rowids.length === 0) return [];
  const placeholders = rowids.map(() => "?").join(", ");
  const stmt = this.db.prepare(`
    SELECT rowid, id, date, time, type, tags, content, source_file
    FROM entries
    WHERE rowid IN (${placeholders})
  `);
  const rows = stmt.all(...rowids) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: row.id as string,
    date: row.date as string,
    time: row.time as string,
    type: row.type as string,
    tags: (row.tags as string).split(", ").filter(Boolean),
    content: row.content as string,
    sourceFile: row.source_file as string,
  }));
}
```

**Step 7: Build and verify**

Run:
```bash
npm run build
```
Expected: Clean compile.

**Step 8: Commit**

```bash
git add src/storage/sqlite.ts
git commit -m "feat: integrate sqlite-vec for vector storage and KNN search"
```

---

### Task 5: Add Hybrid Search with RRF and Temporal Decay

**Files:**
- Modify: `src/storage/sqlite.ts`

**Step 1: Add hybridSearch method to ContextIndex**

Add this method to the `ContextIndex` class:

```typescript
hybridSearch(
  query: string,
  embedding: Float32Array,
  opts: { type?: string; days?: number; limit?: number } = {}
): ContextEntry[] {
  const limit = opts.limit ?? 20;
  // Fetch more candidates than needed for RRF merging
  const candidateLimit = limit * 3;

  // 1. BM25 search
  const bm25Results = this.search(query, {
    type: opts.type,
    days: opts.days,
    limit: candidateLimit,
  });

  // 2. Vector search
  const vecResults = this.searchVec(embedding, candidateLimit);

  // 3. RRF merge
  const K = 60;
  const scores = new Map<number, number>(); // rowid -> rrf score

  // Get rowids for BM25 results
  const bm25Ids = bm25Results.map((e) => e.id);
  const bm25Rowids = this.getRowidsByIds(bm25Ids);

  bm25Rowids.forEach((rowid, rank) => {
    scores.set(rowid, (scores.get(rowid) ?? 0) + 1 / (K + rank + 1));
  });

  vecResults.forEach(({ rowid }, rank) => {
    scores.set(rowid, (scores.get(rowid) ?? 0) + 1 / (K + rank + 1));
  });

  // 4. Temporal decay
  const allRowids = Array.from(scores.keys());
  const entries = this.getByRowids(allRowids);
  const entryMap = new Map<number, ContextEntry>();

  // Build rowid -> entry map
  const rowidLookup = this.getRowidsByIds(entries.map((e) => e.id));
  entries.forEach((entry, i) => {
    entryMap.set(rowidLookup[i], entry);
  });

  const today = new Date();
  const scored = allRowids.map((rowid) => {
    const entry = entryMap.get(rowid)!;
    const entryDate = new Date(entry.date);
    const ageDays = (today.getTime() - entryDate.getTime()) / (1000 * 60 * 60 * 24);
    const decay = Math.pow(0.5, ageDays / 30);
    return { entry, score: (scores.get(rowid) ?? 0) * decay };
  });

  // 5. Sort by score descending, return top N
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.entry);
}
```

**Step 2: Add getRowidsByIds helper**

```typescript
getRowidsByIds(ids: string[]): number[] {
  if (ids.length === 0) return [];
  return ids.map((id) => {
    const row = this.db.prepare(
      "SELECT rowid FROM entries WHERE id = ?"
    ).get(id) as Record<string, unknown> | undefined;
    return (row?.rowid as number) ?? -1;
  });
}
```

**Step 3: Build and verify**

Run:
```bash
npm run build
```
Expected: Clean compile.

**Step 4: Commit**

```bash
git add src/storage/sqlite.ts
git commit -m "feat: add hybrid search with RRF merging and temporal decay"
```

---

### Task 6: Wire Embedder Into context_save

**Files:**
- Modify: `src/tools/context-save.ts`
- Modify: `src/server.ts`

**Step 1: Update contextSave to accept embedder and be async**

Modify `src/tools/context-save.ts`:

```typescript
import { z } from "zod";
import { appendEntry } from "../storage/markdown.js";
import { ContextIndex } from "../storage/sqlite.js";
import { Embedder } from "../storage/embedder.js";

export const contextSaveSchema = {
  content: z.string().describe("The context content to save"),
  type: z
    .enum(["decision", "progress", "issue", "handoff", "insight", "reference"])
    .describe("Type of context entry"),
  tags: z
    .array(z.string())
    .default([])
    .describe("Tags for categorization (e.g. project names, topics)"),
};

export async function contextSave(
  args: { content: string; type: string; tags: string[] },
  index: ContextIndex,
  embedder: Embedder
): Promise<{ success: boolean; id: string; date: string; time: string }> {
  const entry = appendEntry(args.content, args.type, args.tags);
  const rowid = index.insert(entry);

  const embedding = await embedder.embed(args.content);
  index.insertVec(rowid, embedding);

  return {
    success: true,
    id: entry.id,
    date: entry.date,
    time: entry.time,
  };
}
```

**Step 2: Update server.ts to create embedder and pass it**

Modify `src/server.ts` — add embedder import and creation:

```typescript
import { Embedder } from "./storage/embedder.js";
```

In `createServer()`, after `const index = new ContextIndex();`:

```typescript
const embedder = new Embedder();
```

Update the context_save tool handler to pass embedder:

```typescript
server.tool(
  "context_save",
  "Save a context entry (decision, progress, issue, etc.) to persistent local storage",
  contextSaveSchema,
  async (args) => {
    const result = await contextSave(args, index, embedder);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);
```

**Step 3: Build and verify**

Run:
```bash
npm run build
```
Expected: Clean compile.

**Step 4: Commit**

```bash
git add src/tools/context-save.ts src/server.ts
git commit -m "feat: embed content at save time via Transformers.js"
```

---

### Task 7: Wire Embedder Into context_search

**Files:**
- Modify: `src/tools/context-search.ts`
- Modify: `src/server.ts`

**Step 1: Update contextSearch to use hybrid search**

Modify `src/tools/context-search.ts`:

```typescript
import { z } from "zod";
import { ContextIndex } from "../storage/sqlite.js";
import { Embedder } from "../storage/embedder.js";

export const contextSearchSchema = {
  query: z.string().describe("Search query (hybrid semantic + keyword search)"),
  type: z
    .enum(["decision", "progress", "issue", "handoff", "insight", "reference"])
    .optional()
    .describe("Filter by entry type"),
  days: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Only search entries from last N days"),
  limit: z
    .number()
    .int()
    .positive()
    .max(100)
    .default(20)
    .describe("Maximum results to return"),
};

export async function contextSearch(
  args: { query: string; type?: string; days?: number; limit?: number },
  index: ContextIndex,
  embedder: Embedder
): Promise<{
  results: Array<{
    id: string;
    date: string;
    time: string;
    type: string;
    tags: string[];
    content: string;
  }>;
  total: number;
}> {
  const embedding = await embedder.embed(args.query);
  const results = index.hybridSearch(args.query, embedding, {
    type: args.type,
    days: args.days,
    limit: args.limit,
  });

  return {
    results: results.map((r) => ({
      id: r.id,
      date: r.date,
      time: r.time,
      type: r.type,
      tags: r.tags,
      content: r.content,
    })),
    total: results.length,
  };
}
```

**Step 2: Update server.ts search tool registration**

Update the context_search tool in `src/server.ts`:

```typescript
server.tool(
  "context_search",
  "Search saved context entries using hybrid semantic + keyword search",
  contextSearchSchema,
  async (args) => {
    const result = await contextSearch(args, index, embedder);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);
```

**Step 3: Build and verify**

Run:
```bash
npm run build
```
Expected: Clean compile.

**Step 4: Commit**

```bash
git add src/tools/context-search.ts src/server.ts
git commit -m "feat: upgrade context_search to hybrid semantic + keyword search"
```

---

### Task 8: Update rebuild-index Script for Vector Backfill

**Files:**
- Modify: `scripts/rebuild-index.ts`

**Step 1: Update rebuild-index to embed all entries**

Replace `scripts/rebuild-index.ts` with:

```typescript
/**
 * CLI script to rebuild the SQLite FTS + vector index from markdown source files.
 * Usage: node build/scripts/rebuild-index.js
 */

import { ContextIndex } from "../src/storage/sqlite.js";
import {
  listMarkdownFiles,
  parseMarkdownFile,
} from "../src/storage/markdown.js";
import { ensureDirs } from "../src/storage/paths.js";
import { Embedder } from "../src/storage/embedder.js";

async function main(): Promise<void> {
  ensureDirs();
  const index = new ContextIndex();
  const embedder = new Embedder();

  console.log("Rebuilding SQLite index from markdown files...");

  // Clear existing index
  index.clearAll();

  const files = listMarkdownFiles();
  console.log(`Found ${files.length} markdown files.`);

  let totalEntries = 0;
  for (const file of files) {
    const entries = parseMarkdownFile(file);
    for (const entry of entries) {
      const rowid = index.insert(entry);
      const embedding = await embedder.embed(entry.content);
      index.insertVec(rowid, embedding);
    }
    totalEntries += entries.length;
    console.log(`  ${file}: ${entries.length} entries`);
  }

  console.log(`Done. Indexed ${totalEntries} entries with vectors.`);
  index.close();
}

main();
```

Note: `clearAll()` will also need to clear vec_entries. See Step 2.

**Step 2: Update clearAll() in sqlite.ts**

In `src/storage/sqlite.ts`, update the `clearAll()` method to also clear vector data:

After `this.db.exec("DELETE FROM entries");`, add:

```typescript
this.db.exec("DELETE FROM vec_entries");
```

**Step 3: Build and verify**

Run:
```bash
npm run build
```
Expected: Clean compile.

**Step 4: Run the rebuild script**

Run:
```bash
node build/scripts/rebuild-index.js
```
Expected: Finds existing markdown files, indexes all entries with embeddings. First run downloads the model if not cached yet.

**Step 5: Commit**

```bash
git add scripts/rebuild-index.ts src/storage/sqlite.ts
git commit -m "feat: update rebuild-index to backfill vector embeddings"
```

---

### Task 9: End-to-End Smoke Test

**Files:** None (manual testing)

**Step 1: Rebuild the MCP server**

Run:
```bash
cd /home/hyperlynq/projects/Coding/claude-context-tool
npm run build
```

**Step 2: Run rebuild-index to backfill existing entries**

Run:
```bash
node build/scripts/rebuild-index.js
```
Expected: All existing entries get vectors.

**Step 3: Test via Claude Code**

Restart Claude Code (or start a new session) so the MCP server reloads. Then test:

1. Save a test entry:
   - Use `context_save` to save: "Fixed authentication JWT token refresh bug in the login flow"
2. Search semantically:
   - Use `context_search` with query: "login issues" (different words, same meaning)
   - Should find the JWT entry via vector similarity even though "login issues" != "authentication JWT token refresh"
3. Search with keywords:
   - Use `context_search` with query: "JWT token"
   - Should find via BM25 exact match

**Step 4: Verify temporal decay**

Save two entries about similar topics — the more recent one should rank higher in search results.

**Step 5: Bump version and commit**

Update `package.json` version from `0.1.0` to `0.2.0`. Update `server.ts` version string.

```bash
git add package.json src/server.ts
git commit -m "feat: bump to v0.2.0 — Phase 2 smart search complete"
```

---

## Task Dependency Order

```
Task 1 (deps)
  → Task 2 (paths)
    → Task 3 (embedder)
    → Task 4 (sqlite-vec)
      → Task 5 (hybrid search)
        → Task 6 (wire save)
        → Task 7 (wire search)
          → Task 8 (rebuild script)
            → Task 9 (smoke test)
```

All tasks are sequential — each builds on the previous.
