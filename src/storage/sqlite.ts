import { DatabaseSync } from "node:sqlite";
import { DB_PATH, ensureDirs } from "./paths.js";
import type { ContextEntry } from "./markdown.js";

export class ContextIndex {
  private db: DatabaseSync;

  constructor(dbPath: string = DB_PATH) {
    ensureDirs();
    this.db = new DatabaseSync(dbPath);
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
  }

  insert(entry: ContextEntry): void {
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
  }

  search(
    query: string,
    opts: { type?: string; days?: number; limit?: number } = {}
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

    params.push(limit);

    const sql = `
      SELECT e.id, e.date, e.time, e.type, e.tags, e.content, e.source_file,
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
    }));
  }

  list(opts: { days?: number; type?: string } = {}): ContextEntry[] {
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

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const sql = `
      SELECT id, date, time, type, tags, content, source_file
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

  close(): void {
    this.db.close();
  }
}
