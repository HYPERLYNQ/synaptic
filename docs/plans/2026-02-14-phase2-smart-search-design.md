# Phase 2: Smart Search — Design Doc

## Summary

Upgrade Synaptic's search from BM25-only to hybrid semantic + keyword search with temporal weighting. All local, zero cloud.

## Dependencies

- `@huggingface/transformers` — local embedding via `Xenova/all-MiniLM-L6-v2` (q8 quantized, 384 dims)
- `sqlite-vec` — vector search SQLite extension, loaded into existing `node:sqlite` DatabaseSync

## Storage Changes

New virtual table alongside existing `entries` + `entries_fts`:

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS vec_entries USING vec0(
  rowid INTEGER PRIMARY KEY,
  embedding FLOAT[384]
);
```

Vectors stored as `Uint8Array(Float32Array.buffer)` per node:sqlite requirements.

Model files cached in `~/.claude-context/models/`.

## New File: `storage/embedder.ts`

Singleton class that lazy-loads the Transformers.js pipeline on first use:

```typescript
class Embedder {
  private extractor: Pipeline | null = null;

  async embed(text: string): Promise<Float32Array> {
    if (!this.extractor) {
      this.extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
        dtype: 'q8',
        // cache in ~/.claude-context/models/
      });
    }
    const result = await this.extractor(text, { pooling: 'mean', normalize: true });
    return result.data; // Float32Array, 384 dims
  }
}
```

## Modified: `storage/sqlite.ts`

- Constructor: `allowExtension: true`, `sqliteVec.load(db)`
- New `vec_entries` table creation in `init()`
- `insertVec(rowid: number, embedding: Float32Array): void`
- `searchVec(embedding: Float32Array, limit: number): { rowid: number; distance: number }[]`
- `hybridSearch(query: string, embedding: Float32Array, opts): ContextEntry[]` — runs BM25 + vector + RRF + temporal decay

## Modified: `tools/context-save.ts`

After markdown write + SQLite insert, also:
1. Embed the content via `embedder.embed(content)`
2. Store vector via `index.insertVec(rowid, embedding)`

~50-100ms overhead per save.

## Modified: `tools/context-search.ts`

1. Embed the search query
2. Call `index.hybridSearch()` instead of `index.search()`
3. Tool description updated to "hybrid semantic + keyword search"

## Modified: `server.ts`

- Create singleton `Embedder` instance
- Pass to tools that need it (`context_save`, `context_search`)

## Search Pipeline

```
context_search(query)
    |
    +---> BM25 via FTS5         -> ranked list A
    |
    +---> Vector via sqlite-vec -> ranked list B
    |
    +---> Reciprocal Rank Fusion (RRF)
            |
            +---> Temporal decay
                    |
                    +---> Final results
```

## RRF (Reciprocal Rank Fusion)

```
score(entry) = SUM( 1 / (k + rank) )  where k = 60
```

Each entry gets a score from each list based on its rank position. Scores are summed. No normalization needed.

## Temporal Decay

```
decay = 0.5 ^ (age_in_days / 30)
final_score = rrf_score * decay
```

- Today: decay = 1.0
- 30 days old: decay = 0.5
- 60 days old: decay = 0.25

## Backfill: `scripts/rebuild-index.ts`

Update existing rebuild-index script to also:
1. Load all existing entries from markdown files
2. Embed each entry's content
3. Insert vectors into `vec_entries`

One-time migration for Phase 1 data.

## Token Limits

`all-MiniLM-L6-v2` handles max 256 tokens (best under 128). Synaptic entries are short context notes — well within this limit. No truncation logic needed.
