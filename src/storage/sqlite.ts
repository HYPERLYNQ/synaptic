import { DatabaseSync } from "node:sqlite";
import * as sqliteVec from "sqlite-vec";
import { DB_PATH, ensureDirs } from "./paths.js";
import type { ContextEntry } from "./markdown.js";

export class ContextIndex {
  private db: DatabaseSync;

  static assignTier(type: string, explicitTier?: string): "ephemeral" | "working" | "longterm" {
    if (explicitTier) return explicitTier as "ephemeral" | "working" | "longterm";
    switch (type) {
      case "handoff":
      case "progress":
        return "ephemeral";
      case "reference":
        return "longterm";
      default:
        return "working";
    }
  }

  constructor(dbPath: string = DB_PATH) {
    ensureDirs();
    this.db = new DatabaseSync(dbPath, { allowExtension: true });
    sqliteVec.load(this.db);
    this.init();
  }

  private init(): void {
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA busy_timeout=5000");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entries (
        id TEXT PRIMARY KEY,
        date TEXT NOT NULL,
        time TEXT NOT NULL,
        type TEXT NOT NULL,
        tags TEXT NOT NULL,
        content TEXT NOT NULL,
        source_file TEXT NOT NULL
      )
    `);

    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
        content,
        tags,
        type,
        content_rowid='rowid',
        tokenize='porter unicode61'
      )
    `);

    // Triggers to keep FTS in sync
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS entries_ai AFTER INSERT ON entries BEGIN
        INSERT INTO entries_fts(rowid, content, tags, type)
        VALUES (new.rowid, new.content, new.tags, new.type);
      END
    `);

    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS entries_ad AFTER DELETE ON entries BEGIN
        INSERT INTO entries_fts(entries_fts, rowid, content, tags, type)
        VALUES ('delete', old.rowid, old.content, old.tags, old.type);
      END
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_entries_date ON entries(date)
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_entries_type ON entries(type)
    `);

    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS vec_entries USING vec0(
        embedding FLOAT[384]
      )
    `);

    this.migrate();
  }

  private migrate(): void {
    // Check if tier column already exists
    const columns = this.db.prepare("PRAGMA table_info(entries)").all() as Array<Record<string, unknown>>;
    const hasTier = columns.some((col) => col.name === "tier");

    if (!hasTier) {
      this.db.exec("ALTER TABLE entries ADD COLUMN tier TEXT DEFAULT 'working'");
      this.db.exec("ALTER TABLE entries ADD COLUMN access_count INTEGER DEFAULT 0");
      this.db.exec("ALTER TABLE entries ADD COLUMN last_accessed TEXT");
      this.db.exec("ALTER TABLE entries ADD COLUMN pinned INTEGER DEFAULT 0");
      this.db.exec("ALTER TABLE entries ADD COLUMN archived INTEGER DEFAULT 0");

      // Backfill tiers based on entry type
      this.db.exec("UPDATE entries SET tier = 'ephemeral' WHERE type IN ('handoff', 'progress')");
      this.db.exec("UPDATE entries SET tier = 'longterm' WHERE type = 'reference'");
    }

    // Create patterns table for Phase 3c
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS patterns (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        entry_ids TEXT NOT NULL,
        occurrence_count INTEGER NOT NULL DEFAULT 0,
        first_seen TEXT NOT NULL,
        last_seen TEXT NOT NULL,
        resolved INTEGER DEFAULT 0
      )
    `);

    // Create indexes for new columns
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_entries_tier ON entries(tier)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_entries_archived ON entries(archived)");
  }

  insert(entry: ContextEntry): number {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO entries (id, date, time, type, tags, content, source_file, tier, access_count, last_accessed, pinned, archived)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      entry.id,
      entry.date,
      entry.time,
      entry.type,
      entry.tags.join(", "),
      entry.content,
      entry.sourceFile,
      entry.tier ?? "working",
      entry.accessCount ?? 0,
      entry.lastAccessed ?? null,
      entry.pinned ? 1 : 0,
      entry.archived ? 1 : 0
    );
    const row = this.db.prepare("SELECT last_insert_rowid() as rowid").get() as Record<string, unknown>;
    return row.rowid as number;
  }

  insertVec(entryRowid: number, embedding: Float32Array): void {
    const stmt = this.db.prepare(`
      INSERT INTO vec_entries(rowid, embedding)
      VALUES (CAST(? AS INTEGER), ?)
    `);
    stmt.run(entryRowid, new Uint8Array(embedding.buffer));
  }

  search(
    query: string,
    opts: { type?: string; days?: number; limit?: number; includeArchived?: boolean } = {}
  ): ContextEntry[] {
    const limit = opts.limit ?? 20;
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    conditions.push("entries_fts MATCH ?");
    params.push(query);

    if (opts.type) {
      conditions.push("e.type = ?");
      params.push(opts.type);
    }

    if (opts.days) {
      conditions.push("e.date >= date('now', '-' || ? || ' days')");
      params.push(opts.days);
    }

    if (!opts.includeArchived) {
      conditions.push("e.archived = 0");
    }

    params.push(limit);

    const sql = `
      SELECT e.id, e.date, e.time, e.type, e.tags, e.content, e.source_file,
             e.tier, e.access_count, e.last_accessed, e.pinned, e.archived,
             rank
      FROM entries_fts
      JOIN entries e ON entries_fts.rowid = e.rowid
      WHERE ${conditions.join(" AND ")}
      ORDER BY rank
      LIMIT ?
    `;

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as Record<string, unknown>[];

    return rows.map((row) => ({
      id: row.id as string,
      date: row.date as string,
      time: row.time as string,
      type: row.type as string,
      tags: (row.tags as string).split(", ").filter(Boolean),
      content: row.content as string,
      sourceFile: row.source_file as string,
      tier: row.tier as ContextEntry["tier"],
      accessCount: row.access_count as number,
      lastAccessed: row.last_accessed as string | null,
      pinned: !!(row.pinned as number),
      archived: !!(row.archived as number),
    }));
  }

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

  getByRowids(rowids: number[]): ContextEntry[] {
    if (rowids.length === 0) return [];
    const placeholders = rowids.map(() => "?").join(", ");
    const stmt = this.db.prepare(`
      SELECT rowid, id, date, time, type, tags, content, source_file, tier, access_count, last_accessed, pinned, archived
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
      tier: row.tier as ContextEntry["tier"],
      accessCount: row.access_count as number,
      lastAccessed: row.last_accessed as string | null,
      pinned: !!(row.pinned as number),
      archived: !!(row.archived as number),
    }));
  }

  list(opts: { days?: number; type?: string; includeArchived?: boolean } = {}): ContextEntry[] {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (opts.type) {
      conditions.push("type = ?");
      params.push(opts.type);
    }

    if (opts.days) {
      conditions.push("date >= date('now', '-' || ? || ' days')");
      params.push(opts.days);
    }

    if (!opts.includeArchived) {
      conditions.push("archived = 0");
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const sql = `
      SELECT id, date, time, type, tags, content, source_file, tier, access_count, last_accessed, pinned, archived
      FROM entries
      ${where}
      ORDER BY date DESC, time DESC
    `;

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as Record<string, unknown>[];

    return rows.map((row) => ({
      id: row.id as string,
      date: row.date as string,
      time: row.time as string,
      type: row.type as string,
      tags: (row.tags as string).split(", ").filter(Boolean),
      content: row.content as string,
      sourceFile: row.source_file as string,
      tier: row.tier as ContextEntry["tier"],
      accessCount: row.access_count as number,
      lastAccessed: row.last_accessed as string | null,
      pinned: !!(row.pinned as number),
      archived: !!(row.archived as number),
    }));
  }

  status(): { totalEntries: number; dateRange: { earliest: string; latest: string } | null; dbSizeBytes: number } {
    const countRow = this.db.prepare("SELECT COUNT(*) as count FROM entries").get() as Record<string, unknown>;
    const total = countRow.count as number;

    let dateRange: { earliest: string; latest: string } | null = null;
    if (total > 0) {
      const rangeRow = this.db.prepare(
        "SELECT MIN(date) as earliest, MAX(date) as latest FROM entries"
      ).get() as Record<string, unknown>;
      dateRange = {
        earliest: rangeRow.earliest as string,
        latest: rangeRow.latest as string,
      };
    }

    let dbSizeBytes = 0;
    try {
      const sizeRow = this.db.prepare(
        "SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()"
      ).get() as Record<string, unknown>;
      dbSizeBytes = sizeRow.size as number;
    } catch {
      // Ignore if pragma fails
    }

    return { totalEntries: total, dateRange, dbSizeBytes };
  }

  clearAll(): void {
    this.db.exec("DROP TRIGGER IF EXISTS entries_ai");
    this.db.exec("DROP TRIGGER IF EXISTS entries_ad");
    this.db.exec("DELETE FROM entries_fts");
    this.db.exec("DELETE FROM entries");
    this.db.exec("DELETE FROM vec_entries");
    // Recreate triggers
    this.db.exec(`
      CREATE TRIGGER entries_ai AFTER INSERT ON entries BEGIN
        INSERT INTO entries_fts(rowid, content, tags, type)
        VALUES (new.rowid, new.content, new.tags, new.type);
      END
    `);
    this.db.exec(`
      CREATE TRIGGER entries_ad AFTER DELETE ON entries BEGIN
        INSERT INTO entries_fts(entries_fts, rowid, content, tags, type)
        VALUES ('delete', old.rowid, old.content, old.tags, old.type);
      END
    `);
  }

  getRowidsByIds(ids: string[]): number[] {
    if (ids.length === 0) return [];
    return ids.map((id) => {
      const row = this.db.prepare(
        "SELECT rowid FROM entries WHERE id = ?"
      ).get(id) as Record<string, unknown> | undefined;
      return (row?.rowid as number) ?? -1;
    });
  }

  archiveEntries(ids: string[]): number {
    if (ids.length === 0) return 0;
    const placeholders = ids.map(() => "?").join(", ");
    const stmt = this.db.prepare(
      `UPDATE entries SET archived = 1 WHERE id IN (${placeholders}) AND pinned = 0`
    );
    const result = stmt.run(...ids);
    return Number(result.changes);
  }

  bumpAccess(ids: string[]): void {
    if (ids.length === 0) return;
    const now = new Date().toISOString().slice(0, 10);
    const stmt = this.db.prepare(
      "UPDATE entries SET access_count = access_count + 1, last_accessed = ? WHERE id = ?"
    );
    for (const id of ids) {
      stmt.run(now, id);
    }
  }

  hybridSearch(
    query: string,
    embedding: Float32Array,
    opts: { type?: string; days?: number; limit?: number; tier?: string; includeArchived?: boolean } = {}
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
    const tierWeight = (tier: string | undefined): number => {
      switch (tier) {
        case "longterm": return 1.5;
        case "ephemeral": return 0.5;
        default: return 1.0;
      }
    };

    const scored = allRowids.map((rowid) => {
      const entry = entryMap.get(rowid)!;
      const entryDate = new Date(entry.date);
      const ageDays = (today.getTime() - entryDate.getTime()) / (1000 * 60 * 60 * 24);
      const decay = Math.pow(0.5, ageDays / 30);
      return { entry, score: (scores.get(rowid) ?? 0) * decay * tierWeight(entry.tier) };
    });

    // 5. Filter, sort by score descending, return top N
    const filtered = scored.filter((s) => {
      if (!opts.includeArchived && s.entry.archived) return false;
      if (opts.tier && s.entry.tier !== opts.tier) return false;
      return true;
    });
    filtered.sort((a, b) => b.score - a.score);
    const result = filtered.slice(0, limit).map((s) => s.entry);
    this.bumpAccess(result.map((e) => e.id));
    return result;
  }

  close(): void {
    this.db.close();
  }
}
