import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import * as sqliteVec from "sqlite-vec";
import { DB_PATH, ensureDirs } from "./paths.js";
import type { ContextEntry } from "./markdown.js";
import { expandQuery, conceptToFts5 } from "./search-utils.js";
import type { ExpandedConcept } from "./search-utils.js";

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export class ContextIndex {
  private db: DatabaseSync;

  static assignTier(type: string, explicitTier?: string): "ephemeral" | "working" | "longterm" {
    if (explicitTier) {
      if (explicitTier !== "ephemeral" && explicitTier !== "working" && explicitTier !== "longterm") {
        throw new Error("Invalid tier: must be ephemeral, working, or longterm");
      }
      return explicitTier;
    }
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
    try {
      sqliteVec.load(this.db);
    } catch (err) {
      throw new Error(`sqlite-vec failed to load (native binding issue): ${err}`);
    }
    this.init();
  }

  private init(): void {
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA busy_timeout=15000");

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

    const hasLabel = columns.some((col) => col.name === "label");
    if (!hasLabel) {
      this.db.exec("ALTER TABLE entries ADD COLUMN label TEXT");
      this.db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_entries_rule_label ON entries(label) WHERE type = 'rule'"
      );
    }

    // v0.5.0 migration: project, session_id, agent_id columns
    const hasProject = columns.some((col) => col.name === "project");
    if (!hasProject) {
      this.db.exec("ALTER TABLE entries ADD COLUMN project TEXT DEFAULT NULL");
      this.db.exec("ALTER TABLE entries ADD COLUMN session_id TEXT DEFAULT NULL");
      this.db.exec("ALTER TABLE entries ADD COLUMN agent_id TEXT DEFAULT NULL");
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_entries_project ON entries(project)");
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_entries_session ON entries(session_id)");
    }

    // v0.5.0: file_pairs table for co-change tracking
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS file_pairs (
        project TEXT NOT NULL,
        file_a TEXT NOT NULL,
        file_b TEXT NOT NULL,
        co_change_count INTEGER DEFAULT 1,
        last_seen TEXT NOT NULL,
        PRIMARY KEY (project, file_a, file_b)
      )
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_file_pairs_lookup ON file_pairs(project, file_a)");

    // v1.5.0 migration: checkpoint fields
    const hasName = columns.some((col) => col.name === "name");
    if (!hasName) {
      this.db.exec("ALTER TABLE entries ADD COLUMN name TEXT");
      this.db.exec("ALTER TABLE entries ADD COLUMN summary TEXT");
      this.db.exec("ALTER TABLE entries ADD COLUMN project_root TEXT");
      this.db.exec("ALTER TABLE entries ADD COLUMN referenced_entry_ids TEXT");
      this.db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_entries_name ON entries(name) WHERE name IS NOT NULL"
      );
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS idx_entries_project_root ON entries(project_root)"
      );
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS idx_entries_pinned_filtered ON entries(pinned) WHERE pinned = 1"
      );
    }
  }

  insert(entry: ContextEntry): number {
    // Enforce name uniqueness: if a different entry already has this name, throw.
    if (entry.name != null) {
      const conflict = this.db.prepare(
        "SELECT id FROM entries WHERE name = ? AND id != ?"
      ).get(entry.name, entry.id) as { id: string } | undefined;
      if (conflict) {
        throw new Error(`UNIQUE constraint failed: entries.name (value: ${entry.name})`);
      }
    }
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO entries (id, date, time, type, tags, content, source_file, tier, access_count, last_accessed, pinned, archived, label, project, session_id, agent_id, name, summary, project_root, referenced_entry_ids)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      entry.archived ? 1 : 0,
      (entry as any).label ?? null,
      entry.project ?? null,
      entry.sessionId ?? null,
      entry.agentId ?? null,
      entry.name ?? null,
      entry.summary ?? null,
      entry.projectRoot ?? null,
      entry.referencedEntryIds ? JSON.stringify(entry.referencedEntryIds) : null
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

  /** Sanitize user input for FTS5 MATCH — strip operators, wrap terms in quotes. */
  private sanitizeFts5Query(query: string): string {
    // Remove FTS5 special characters: {} () * ^ " column-filter colons
    const cleaned = query.replace(/[{}()*^"\\:]/g, " ");
    // Split into terms and wrap each in double quotes to force literal matching
    const terms = cleaned.split(/\s+/).filter(Boolean);
    if (terms.length === 0) return '""'; // empty match
    return terms.map(t => `"${t}"`).join(" ");
  }

  search(
    query: string,
    opts: { type?: string; days?: number; limit?: number; includeArchived?: boolean } = {}
  ): ContextEntry[] {
    const limit = opts.limit ?? 20;
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    conditions.push("entries_fts MATCH ?");
    params.push(this.sanitizeFts5Query(query));

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
             e.project, e.session_id, e.agent_id,
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
      project: row.project as string | null,
      sessionId: row.session_id as string | null,
      agentId: row.agent_id as string | null,
    }));
  }

  /**
   * Multi-pass BM25 search: runs one FTS5 query per concept,
   * scores entries by how many concepts they match.
   * Returns entries sorted by concept-match count (descending).
   */
  multiPassSearch(
    concepts: ExpandedConcept[],
    opts: { type?: string; days?: number; limit?: number; includeArchived?: boolean } = {}
  ): Array<{ entry: ContextEntry; conceptHits: number }> {
    if (concepts.length === 0) return [];
    const limit = opts.limit ?? 20;
    const candidateLimit = limit * 3;

    // Track concept hit counts per entry ID
    const hitCounts = new Map<string, number>();
    const entryCache = new Map<string, ContextEntry>();

    for (const concept of concepts) {
      const fts5Expr = conceptToFts5(concept);

      const conditions: string[] = [];
      const params: (string | number)[] = [];

      conditions.push("entries_fts MATCH ?");
      params.push(fts5Expr);

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
      params.push(candidateLimit);

      try {
        const sql = `
          SELECT e.id, e.date, e.time, e.type, e.tags, e.content, e.source_file,
                 e.tier, e.access_count, e.last_accessed, e.pinned, e.archived,
                 e.project, e.session_id, e.agent_id
          FROM entries_fts
          JOIN entries e ON entries_fts.rowid = e.rowid
          WHERE ${conditions.join(" AND ")}
          LIMIT ?
        `;
        const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];

        for (const row of rows) {
          const id = row.id as string;
          hitCounts.set(id, (hitCounts.get(id) ?? 0) + 1);
          if (!entryCache.has(id)) {
            entryCache.set(id, {
              id,
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
              project: row.project as string | null,
              sessionId: row.session_id as string | null,
              agentId: row.agent_id as string | null,
            });
          }
        }
      } catch {
        // FTS5 query failed for this concept — skip it
        continue;
      }
    }

    // Sort by concept hit count descending, then by date descending
    const results = Array.from(entryCache.entries())
      .map(([id, entry]) => ({ entry, conceptHits: hitCounts.get(id) ?? 0 }))
      .sort((a, b) => {
        if (b.conceptHits !== a.conceptHits) return b.conceptHits - a.conceptHits;
        return b.entry.date.localeCompare(a.entry.date);
      });

    return results.slice(0, candidateLimit);
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
      SELECT rowid, id, date, time, type, tags, content, source_file, tier, access_count, last_accessed, pinned, archived, project, session_id, agent_id
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
      project: row.project as string | null,
      sessionId: row.session_id as string | null,
      agentId: row.agent_id as string | null,
    }));
  }

  hasEntry(id: string): boolean {
    const row = this.db.prepare("SELECT 1 FROM entries WHERE id = ?").get(id);
    return !!row;
  }

  getAllEntryIds(): Set<string> {
    const rows = this.db.prepare("SELECT id FROM entries").all() as Array<{ id: string }>;
    return new Set(rows.map(r => r.id));
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

    const maxRows = 1000;
    params.push(maxRows);

    const sql = `
      SELECT id, date, time, type, tags, content, source_file, tier, access_count, last_accessed, pinned, archived, project, session_id, agent_id, name, summary, project_root, referenced_entry_ids
      FROM entries
      ${where}
      ORDER BY date DESC, time DESC
      LIMIT ?
    `;

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as Record<string, unknown>[];

    return rows.map((row) => this.rowToEntry(row));
  }

  status(): {
    totalEntries: number;
    dateRange: { earliest: string; latest: string } | null;
    dbSizeBytes: number;
    tierDistribution: Record<string, number>;
    archivedCount: number;
    activePatterns: number;
  } {
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

    // Tier distribution (non-archived only)
    const tierRows = this.db.prepare(
      "SELECT tier, COUNT(*) as count FROM entries WHERE archived = 0 GROUP BY tier"
    ).all() as Array<{ tier: string; count: number }>;
    const tierDistribution: Record<string, number> = {};
    for (const row of tierRows) {
      tierDistribution[row.tier] = row.count;
    }

    // Archived count
    const archivedRow = this.db.prepare(
      "SELECT COUNT(*) as count FROM entries WHERE archived = 1"
    ).get() as { count: number };

    // Active patterns count
    const patternRow = this.db.prepare(
      "SELECT COUNT(*) as count FROM patterns WHERE resolved = 0"
    ).get() as { count: number };

    return {
      totalEntries: total,
      dateRange,
      dbSizeBytes,
      tierDistribution,
      archivedCount: archivedRow.count,
      activePatterns: patternRow.count,
    };
  }

  clearAll(): void {
    this.db.exec("DROP TRIGGER IF EXISTS entries_ai");
    this.db.exec("DROP TRIGGER IF EXISTS entries_ad");
    this.db.exec("DELETE FROM entries_fts");
    this.db.exec("DELETE FROM entries");
    this.db.exec("DELETE FROM vec_entries");
    this.db.exec("DELETE FROM patterns");
    this.db.exec("DELETE FROM file_pairs");
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
    const placeholders = ids.map(() => "?").join(", ");
    this.db.prepare(
      `UPDATE entries SET access_count = access_count + 1, last_accessed = ? WHERE id IN (${placeholders})`
    ).run(now, ...ids);
  }

  /** Increment access_count and set last_accessed for a given entry ID */
  touchEntry(id: string): boolean {
    const today = new Date().toISOString().slice(0, 10);
    const result = this.db.prepare(
      "UPDATE entries SET access_count = access_count + 1, last_accessed = ? WHERE id = ? AND archived = 0"
    ).run(today, id);
    return result.changes > 0;
  }

  /** Update an entry's date and time to now (for upsert-style dedup). */
  updateTimestamp(id: string): boolean {
    const now = new Date();
    const date = now.toISOString().split("T")[0];
    const time = now.toTimeString().slice(0, 5);
    const result = this.db.prepare(
      "UPDATE entries SET date = ?, time = ? WHERE id = ? AND archived = 0"
    ).run(date, time, id);
    return (result.changes ?? 0) > 0;
  }

  /** Drop and rebuild the FTS5 index from non-archived entries. */
  rebuildFts(): void {
    this.db.exec("DELETE FROM entries_fts");
    this.db.exec(`
      INSERT INTO entries_fts(rowid, content, tags, type)
      SELECT rowid, content, tags, type FROM entries WHERE archived = 0
    `);
  }

  hybridSearch(
    query: string,
    embedding: Float32Array,
    opts: { type?: string; days?: number; limit?: number; tier?: string; includeArchived?: boolean; project?: string | null } = {}
  ): ContextEntry[] {
    const limit = opts.limit ?? 20;
    const candidateLimit = limit * 3;

    // 1. Multi-pass concept BM25 search
    const concepts = expandQuery(query);

    const conceptResults = concepts.length > 0
      ? this.multiPassSearch(concepts, {
          type: opts.type,
          days: opts.days,
          limit: candidateLimit,
          includeArchived: opts.includeArchived,
        })
      : [];

    // Also run the original single-pass BM25 as fallback
    const bm25Results = this.search(query, {
      type: opts.type,
      days: opts.days,
      limit: candidateLimit,
      includeArchived: opts.includeArchived,
    });

    // 2. Vector search
    const vecResults = this.searchVec(embedding, candidateLimit);

    // 3. RRF merge with concept-count boost
    const K = 60;
    const scores = new Map<string, number>(); // entry ID -> rrf score
    const entryMap = new Map<string, ContextEntry>();

    // Score concept results — entries matching more concepts rank higher
    const totalConcepts = concepts.length || 1;
    for (const { entry, conceptHits } of conceptResults) {
      const conceptBoost = conceptHits / totalConcepts; // 0.0 to 1.0
      scores.set(entry.id, (scores.get(entry.id) ?? 0) + conceptBoost * 1.5);
      entryMap.set(entry.id, entry);
    }

    // Score original BM25 results via RRF
    bm25Results.forEach((entry, rank) => {
      scores.set(entry.id, (scores.get(entry.id) ?? 0) + 1 / (K + rank + 1));
      entryMap.set(entry.id, entry);
    });

    // Score vector results via RRF
    const vecRowids = vecResults.map(r => r.rowid);
    const vecEntries = this.getByRowids(vecRowids);
    vecEntries.forEach((entry, rank) => {
      scores.set(entry.id, (scores.get(entry.id) ?? 0) + 1 / (K + rank + 1));
      entryMap.set(entry.id, entry);
    });

    // 4. Apply temporal decay, tier weight, confidence boost, project boost
    const today = new Date();
    const currentProject = opts.project ?? null;

    const projectBoost = (entryProject: string | null | undefined, curProject: string | null): number => {
      if (!curProject || !entryProject) return 1.0;
      return entryProject === curProject ? 2.0 : 1.0;
    };

    const tierWeight = (tier: string | undefined): number => {
      switch (tier) {
        case "longterm": return 1.5;
        case "ephemeral": return 0.5;
        default: return 1.0;
      }
    };

    const confidenceBoost = (accessCount: number): number => {
      if (accessCount === 0) return 0.7;
      if (accessCount <= 2) return 1.0;
      if (accessCount <= 5) return 1.2;
      return 1.4;
    };

    const scored = Array.from(scores.entries()).map(([id, rawScore]) => {
      const entry = entryMap.get(id)!;
      const entryDate = new Date(entry.date);
      const ageDays = (today.getTime() - entryDate.getTime()) / (1000 * 60 * 60 * 24);
      const decay = Math.pow(0.5, ageDays / 30);
      return {
        entry,
        score: rawScore * decay * tierWeight(entry.tier) * confidenceBoost(entry.accessCount ?? 0) * projectBoost(entry.project, currentProject),
      };
    });

    // 5. Filter, sort, return top N
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

  /** Archive ephemeral entries based on access-aware windows */
  decayEphemeral(): number {
    // 0 accesses: 7 days, 1-2 accesses: 14 days, 3+ accesses: 21 days
    const stmt = this.db.prepare(`
      UPDATE entries SET archived = 1
      WHERE tier = 'ephemeral' AND pinned = 0 AND archived = 0
        AND (
          (access_count = 0 AND date < date('now', '-7 days'))
          OR (access_count BETWEEN 1 AND 2 AND date < date('now', '-14 days'))
          OR (access_count >= 3 AND date < date('now', '-21 days'))
        )
    `);
    return Number(stmt.run().changes);
  }

  /** Demote working entries based on access-aware idle windows */
  demoteIdle(): number {
    // 0 accesses: 21 days, 1-2 accesses: 45 days, 3+ accesses: 90 days
    const stmt = this.db.prepare(`
      UPDATE entries SET tier = 'ephemeral'
      WHERE tier = 'working' AND pinned = 0 AND archived = 0
        AND (
          (access_count = 0 AND COALESCE(last_accessed, date) < date('now', '-21 days'))
          OR (access_count BETWEEN 1 AND 2 AND COALESCE(last_accessed, date) < date('now', '-45 days'))
          OR (access_count >= 3 AND COALESCE(last_accessed, date) < date('now', '-90 days'))
        )
    `);
    return Number(stmt.run().changes);
  }

  /** Promote decisions/insights older than 7 days to longterm */
  promoteStable(): number {
    const stmt = this.db.prepare(`
      UPDATE entries SET tier = 'longterm'
      WHERE tier = 'working' AND archived = 0
        AND type IN ('decision', 'insight')
        AND date < date('now', '-7 days')
    `);
    return Number(stmt.run().changes);
  }

  /** Promote ephemeral entries accessed 3+ times to working */
  promoteFrequent(): number {
    const stmt = this.db.prepare(`
      UPDATE entries SET tier = 'working'
      WHERE tier = 'ephemeral' AND archived = 0
        AND access_count >= 3
    `);
    return Number(stmt.run().changes);
  }

  getEmbedding(entryId: string): Float32Array | null {
    const rowidRow = this.db.prepare(
      "SELECT rowid FROM entries WHERE id = ?"
    ).get(entryId) as { rowid: number } | undefined;
    if (!rowidRow) return null;

    try {
      const vecRow = this.db.prepare(
        "SELECT embedding FROM vec_entries WHERE rowid = CAST(? AS INTEGER)"
      ).get(rowidRow.rowid) as { embedding: ArrayBuffer | Uint8Array } | undefined;
      if (!vecRow) return null;
      if (vecRow.embedding instanceof Uint8Array) {
        return new Float32Array(vecRow.embedding.buffer, vecRow.embedding.byteOffset, vecRow.embedding.byteLength / 4);
      }
      return new Float32Array(vecRow.embedding);
    } catch {
      return null;
    }
  }

  findConsolidationCandidates(threshold: number = 0.75): Array<{ label: string; entries: ContextEntry[] }> {
    // Get all non-archived issue/decision entries from last 30 days
    const candidates = this.list({ days: 30, includeArchived: false })
      .filter(e => e.type === "issue" || e.type === "decision");

    if (candidates.length < 3) return [];

    // Simple greedy clustering by cosine similarity
    const used = new Set<string>();
    const groups: Array<{ label: string; entries: ContextEntry[] }> = [];

    for (let i = 0; i < candidates.length; i++) {
      if (used.has(candidates[i].id)) continue;
      const embA = this.getEmbedding(candidates[i].id);
      if (!embA) continue;

      const cluster: ContextEntry[] = [candidates[i]];

      for (let j = i + 1; j < candidates.length; j++) {
        if (used.has(candidates[j].id)) continue;
        const embB = this.getEmbedding(candidates[j].id);
        if (!embB) continue;

        if (cosineSimilarity(embA, embB) >= threshold) {
          cluster.push(candidates[j]);
        }
      }

      if (cluster.length >= 3) {
        cluster.forEach(e => used.add(e.id));
        groups.push({
          label: cluster[0].content.slice(0, 80),
          entries: cluster,
        });
      }
    }

    return groups;
  }

  /**
   * Smart dedup: find and merge duplicate entries using cosine similarity
   * and substring detection. Uses content-aware survivor selection.
   */
  smartDedup(opts: {
    threshold?: number;
    typeThresholds?: Record<string, number>;
    dryRun?: boolean;
    minAgeDays?: number;
  } = {}): Array<{
    survivorId: string;
    survivorContent: string;
    archivedIds: string[];
    reason: "similarity" | "subset";
    similarity?: number;
  }> {
    const defaultThreshold = opts.threshold ?? 0.90;
    const typeThresholds = opts.typeThresholds ?? {};
    const dryRun = opts.dryRun ?? false;
    const minAgeDays = opts.minAgeDays ?? 3;

    const now = Date.now();
    const minAgeMs = minAgeDays * 24 * 60 * 60 * 1000;

    // Get all non-archived, non-pinned, non-rule entries older than minAgeDays
    const candidates = this.list({ includeArchived: false })
      .filter(e => {
        if (e.pinned) return false;
        if (e.type === "rule") return false;
        const entryDate = new Date(e.date).getTime();
        if ((now - entryDate) < minAgeMs) return false;
        return true;
      });

    if (candidates.length < 2) return [];

    const actions: Array<{
      survivorId: string;
      survivorContent: string;
      archivedIds: string[];
      reason: "similarity" | "subset";
      similarity?: number;
    }> = [];
    const archived = new Set<string>();

    // Normalize content for substring comparison
    const normalize = (s: string): string =>
      s.toLowerCase().replace(/\s+/g, " ").replace(/\[consolidated from \d+ entries\]/gi, "").trim();

    // Phase 1: Subset detection — if entry A is contained within entry B, archive A
    for (let i = 0; i < candidates.length; i++) {
      if (archived.has(candidates[i].id)) continue;
      const normI = normalize(candidates[i].content);
      if (normI.length < 20) continue; // skip very short entries

      for (let j = 0; j < candidates.length; j++) {
        if (i === j) continue;
        if (archived.has(candidates[j].id)) continue;
        const normJ = normalize(candidates[j].content);

        // Check if i is a strict subset of j (i is shorter and contained in j)
        if (normI.length < normJ.length && normJ.includes(normI)) {
          archived.add(candidates[i].id);
          actions.push({
            survivorId: candidates[j].id,
            survivorContent: candidates[j].content.slice(0, 100),
            archivedIds: [candidates[i].id],
            reason: "subset",
          });

          if (!dryRun) {
            this.mergeTagsInto(candidates[j].id, [candidates[i].id]);
            this.archiveEntries([candidates[i].id]);
            // Preserve highest access count
            if ((candidates[i].accessCount ?? 0) > (candidates[j].accessCount ?? 0)) {
              this.db.prepare(
                "UPDATE entries SET access_count = ? WHERE id = ?"
              ).run(candidates[i].accessCount ?? 0, candidates[j].id);
            }
          }
          break; // entry i is archived, move to next
        }
      }
    }

    // Phase 2: Cosine similarity — pair-wise comparison for remaining entries
    const remaining = candidates.filter(e => !archived.has(e.id));

    for (let i = 0; i < remaining.length; i++) {
      if (archived.has(remaining[i].id)) continue;
      const embA = this.getEmbedding(remaining[i].id);
      if (!embA) continue;

      for (let j = i + 1; j < remaining.length; j++) {
        if (archived.has(remaining[j].id)) continue;
        const embB = this.getEmbedding(remaining[j].id);
        if (!embB) continue;

        const sim = cosineSimilarity(embA, embB);

        // Get threshold for this pair (use the stricter of the two types)
        const threshA = typeThresholds[remaining[i].type] ?? defaultThreshold;
        const threshB = typeThresholds[remaining[j].type] ?? defaultThreshold;
        const effectiveThreshold = Math.max(threshA, threshB);

        if (sim >= effectiveThreshold) {
          // Smart survivor selection: pick the longer/more complete entry
          let survivor: ContextEntry;
          let loser: ContextEntry;

          if (remaining[i].content.length >= remaining[j].content.length) {
            survivor = remaining[i];
            loser = remaining[j];
          } else {
            survivor = remaining[j];
            loser = remaining[i];
          }

          archived.add(loser.id);
          actions.push({
            survivorId: survivor.id,
            survivorContent: survivor.content.slice(0, 100),
            archivedIds: [loser.id],
            reason: "similarity",
            similarity: sim,
          });

          if (!dryRun) {
            this.mergeTagsInto(survivor.id, [loser.id]);
            this.archiveEntries([loser.id]);
            // Preserve highest access count
            if ((loser.accessCount ?? 0) > (survivor.accessCount ?? 0)) {
              this.db.prepare(
                "UPDATE entries SET access_count = ? WHERE id = ?"
              ).run(loser.accessCount ?? 0, survivor.id);
            }
            // Preserve earliest date
            if (loser.date < survivor.date) {
              this.db.prepare(
                "UPDATE entries SET date = ? WHERE id = ?"
              ).run(loser.date, survivor.id);
            }
          }
        }
      }
    }

    return actions;
  }

  /** Escape LIKE wildcards to prevent pattern injection. */
  private escapeLike(str: string): string {
    return str.replace(/[%_\\]/g, "\\$&");
  }

  hasEntryWithTag(tag: string): boolean {
    const row = this.db.prepare(
      "SELECT 1 FROM entries WHERE tags LIKE ? ESCAPE '\\' LIMIT 1"
    ).get(`%${this.escapeLike(tag)}%`);
    return !!row;
  }

  findByTag(tag: string): ContextEntry[] {
    const sql = `
      SELECT id, date, time, type, tags, content, source_file, tier, access_count, last_accessed, pinned, archived, project, session_id, agent_id
      FROM entries
      WHERE tags LIKE ? ESCAPE '\\' AND archived = 0
      ORDER BY date ASC, time ASC
      LIMIT 1000
    `;
    const rows = this.db.prepare(sql).all(`%${this.escapeLike(tag)}%`) as Record<string, unknown>[];
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
      project: row.project as string | null,
      sessionId: row.session_id as string | null,
      agentId: row.agent_id as string | null,
    }));
  }

  findSimilarIssues(embedding: Float32Array, days: number = 30, distanceThreshold: number = 0.5): ContextEntry[] {
    // sqlite-vec distance: lower = more similar. ~0.5 distance ≈ ~0.75 cosine similarity for normalized vectors
    const vecResults = this.searchVec(embedding, 20);
    const matchingRowids = vecResults
      .filter(r => r.distance <= distanceThreshold)
      .map(r => r.rowid);

    if (matchingRowids.length === 0) return [];

    const entries = this.getByRowids(matchingRowids);
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    return entries.filter(e =>
      e.type === "issue" && !e.archived && e.date >= cutoffStr
    );
  }

  createOrUpdatePattern(label: string, entryIds: string[]): string {
    // Check if any existing unresolved pattern overlaps with these entries
    const patterns = this.db.prepare(
      "SELECT id, entry_ids, occurrence_count, first_seen FROM patterns WHERE resolved = 0"
    ).all() as Array<{ id: string; entry_ids: string; occurrence_count: number; first_seen: string }>;

    const entryIdSet = new Set(entryIds);
    for (const pat of patterns) {
      let existing: string[];
      try {
        const parsed = JSON.parse(pat.entry_ids);
        existing = Array.isArray(parsed) ? parsed : [];
      } catch {
        existing = [];
      }
      const overlap = existing.some(id => entryIdSet.has(id));
      if (overlap) {
        // Merge into existing pattern
        const merged = Array.from(new Set([...existing, ...entryIds]));
        const now = new Date().toISOString().slice(0, 10);
        this.db.prepare(`
          UPDATE patterns SET entry_ids = ?, occurrence_count = ?, last_seen = ?, label = ?
          WHERE id = ?
        `).run(JSON.stringify(merged), merged.length, now, label.slice(0, 80), pat.id);
        return pat.id;
      }
    }

    // Create new pattern
    const id = Date.now().toString(36) + randomBytes(4).toString("hex").slice(0, 6);
    const now = new Date().toISOString().slice(0, 10);
    this.db.prepare(`
      INSERT INTO patterns (id, label, entry_ids, occurrence_count, first_seen, last_seen)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, label.slice(0, 80), JSON.stringify(entryIds), entryIds.length, now, now);
    return id;
  }

  getActivePatterns(): Array<{
    id: string;
    label: string;
    entryIds: string[];
    occurrenceCount: number;
    firstSeen: string;
    lastSeen: string;
  }> {
    const rows = this.db.prepare(
      "SELECT * FROM patterns WHERE resolved = 0 AND occurrence_count >= 3 ORDER BY last_seen DESC"
    ).all() as Array<Record<string, unknown>>;
    return rows.map(r => {
      let entryIds: string[];
      try {
        const parsed = JSON.parse(r.entry_ids as string);
        entryIds = Array.isArray(parsed) ? parsed : [];
      } catch {
        entryIds = [];
      }
      return {
        id: r.id as string,
        label: r.label as string,
        entryIds,
        occurrenceCount: r.occurrence_count as number,
        firstSeen: r.first_seen as string,
        lastSeen: r.last_seen as string,
      };
    });
  }

  getPatternForEntry(entryId: string): { id: string; occurrenceCount: number } | null {
    const rows = this.db.prepare(
      "SELECT id, occurrence_count, entry_ids FROM patterns WHERE resolved = 0"
    ).all() as Array<{ id: string; occurrence_count: number; entry_ids: string }>;
    for (const row of rows) {
      let ids: string[];
      try {
        const parsed = JSON.parse(row.entry_ids);
        ids = Array.isArray(parsed) ? parsed : [];
      } catch {
        ids = [];
      }
      if (ids.includes(entryId)) {
        return { id: row.id, occurrenceCount: row.occurrence_count };
      }
    }
    return null;
  }

  resolvePattern(patternId: string): boolean {
    const result = this.db.prepare(
      "UPDATE patterns SET resolved = 1 WHERE id = ?"
    ).run(patternId);
    return Number(result.changes) > 0;
  }

  saveRule(label: string, content: string): number {
    const now = new Date();
    const date = now.toISOString().slice(0, 10);
    const time = now.toTimeString().slice(0, 5);
    const id = Date.now().toString(36) + randomBytes(4).toString("hex").slice(0, 6);

    // Upsert: clean up old rule with same label (manually sync FTS to avoid trigger issue)
    const existing = this.db.prepare(
      "SELECT rowid FROM entries WHERE type = 'rule' AND label = ?"
    ).get(label) as { rowid: number } | undefined;
    if (existing) {
      this.db.prepare("DELETE FROM entries_fts WHERE rowid = ?").run(existing.rowid);
      this.db.exec("DROP TRIGGER IF EXISTS entries_ad");
      this.db.prepare("DELETE FROM entries WHERE rowid = ?").run(existing.rowid);
      this.db.exec(`
        CREATE TRIGGER entries_ad AFTER DELETE ON entries BEGIN
          INSERT INTO entries_fts(entries_fts, rowid, content, tags, type)
          VALUES ('delete', old.rowid, old.content, old.tags, old.type);
        END
      `);
    }

    const stmt = this.db.prepare(`
      INSERT INTO entries (id, date, time, type, tags, content, source_file, tier, access_count, last_accessed, pinned, archived, label)
      VALUES (?, ?, ?, 'rule', '', ?, 'rule', 'longterm', 0, NULL, 1, 0, ?)
    `);
    stmt.run(id, date, time, content, label);
    const row = this.db.prepare("SELECT last_insert_rowid() as rowid").get() as Record<string, unknown>;
    return row.rowid as number;
  }

  listRules(): Array<ContextEntry & { label: string }> {
    const rows = this.db.prepare(
      "SELECT id, date, time, type, tags, content, source_file, tier, access_count, last_accessed, pinned, archived, label FROM entries WHERE type = 'rule' AND archived = 0 ORDER BY date DESC"
    ).all() as Array<Record<string, unknown>>;
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
      label: row.label as string,
    }));
  }

  deleteRule(label: string): boolean {
    const existing = this.db.prepare(
      "SELECT rowid FROM entries WHERE type = 'rule' AND label = ?"
    ).get(label) as { rowid: number } | undefined;
    if (!existing) return false;

    this.db.prepare("DELETE FROM entries_fts WHERE rowid = ?").run(existing.rowid);
    this.db.exec("DROP TRIGGER IF EXISTS entries_ad");
    this.db.prepare("DELETE FROM entries WHERE rowid = ?").run(existing.rowid);
    this.db.exec(`
      CREATE TRIGGER entries_ad AFTER DELETE ON entries BEGIN
        INSERT INTO entries_fts(entries_fts, rowid, content, tags, type)
        VALUES ('delete', old.rowid, old.content, old.tags, old.type);
      END
    `);
    return true;
  }

  upsertFilePair(project: string, fileA: string, fileB: string, date: string): void {
    // Ensure consistent ordering (a < b) to avoid duplicates
    const [f1, f2] = fileA < fileB ? [fileA, fileB] : [fileB, fileA];
    this.db.prepare(`
      INSERT INTO file_pairs (project, file_a, file_b, co_change_count, last_seen)
      VALUES (?, ?, ?, 1, ?)
      ON CONFLICT(project, file_a, file_b) DO UPDATE SET
        co_change_count = co_change_count + 1,
        last_seen = ?
    `).run(project, f1, f2, date, date);
  }

  getCoChanges(
    project: string,
    file: string,
    limit: number = 10
  ): Array<{ file: string; count: number; lastSeen: string }> {
    const rows = this.db.prepare(`
      SELECT
        CASE WHEN file_a = ? THEN file_b ELSE file_a END as paired_file,
        co_change_count,
        last_seen
      FROM file_pairs
      WHERE project = ? AND (file_a = ? OR file_b = ?)
      ORDER BY co_change_count DESC
      LIMIT ?
    `).all(file, project, file, file, limit) as Array<Record<string, unknown>>;

    return rows.map(r => ({
      file: r.paired_file as string,
      count: r.co_change_count as number,
      lastSeen: r.last_seen as string,
    }));
  }

  listBySession(
    sessionId: string,
    opts: { type?: string } = {}
  ): ContextEntry[] {
    const conditions = ["session_id = ?"];
    const params: (string | number)[] = [sessionId];

    if (opts.type) {
      conditions.push("type = ?");
      params.push(opts.type);
    }

    const maxRows = 1000;
    params.push(maxRows);

    const sql = `
      SELECT id, date, time, type, tags, content, source_file, tier, access_count,
             last_accessed, pinned, archived, project, session_id, agent_id
      FROM entries
      WHERE ${conditions.join(" AND ")}
      ORDER BY date ASC, time ASC
      LIMIT ?
    `;

    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
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
      project: row.project as string | null,
      sessionId: row.session_id as string | null,
      agentId: row.agent_id as string | null,
    }));
  }

  /** Update an entry's content (for consolidation) */
  updateEntryContent(id: string, newContent: string): boolean {
    // Fetch current row data for FTS removal
    const row = this.db.prepare(
      "SELECT rowid, content, tags, type FROM entries WHERE id = ?"
    ).get(id) as { rowid: number; content: string; tags: string; type: string } | undefined;
    if (!row) return false;

    // Remove old FTS entry using the delete command, then update, then re-insert.
    // We temporarily drop and recreate triggers to avoid interference.
    this.db.exec("DROP TRIGGER IF EXISTS entries_ai");
    this.db.exec("DROP TRIGGER IF EXISTS entries_ad");

    // Delete the old FTS row by rowid
    this.db.prepare("DELETE FROM entries_fts WHERE rowid = ?").run(row.rowid);

    // Update the content in entries table
    const result = this.db.prepare(
      "UPDATE entries SET content = ? WHERE id = ?"
    ).run(newContent, id);

    // Re-insert FTS entry with updated content
    if (result.changes > 0) {
      this.db.prepare(
        "INSERT INTO entries_fts(rowid, content, tags, type) VALUES (?, ?, ?, ?)"
      ).run(row.rowid, newContent, row.tags, row.type);
    }

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

    return result.changes > 0;
  }

  /** Merge tags from source entries into a target entry */
  mergeTagsInto(targetId: string, sourceIds: string[]): void {
    const targetRow = this.db.prepare(
      "SELECT tags FROM entries WHERE id = ?"
    ).get(targetId) as { tags: string } | undefined;
    if (!targetRow) return;

    const allTags = new Set<string>(targetRow.tags.split(", ").filter(Boolean));
    for (const srcId of sourceIds) {
      const srcRow = this.db.prepare(
        "SELECT tags FROM entries WHERE id = ?"
      ).get(srcId) as { tags: string } | undefined;
      if (srcRow) {
        for (const tag of srcRow.tags.split(", ").filter(Boolean)) {
          allTags.add(tag);
        }
      }
    }

    this.db.prepare(
      "UPDATE entries SET tags = ? WHERE id = ?"
    ).run([...allTags].join(", "), targetId);
  }

  private rowToEntry(row: Record<string, unknown>): ContextEntry {
    const refs = row.referenced_entry_ids
      ? JSON.parse(String(row.referenced_entry_ids)) as string[]
      : undefined;
    return {
      id: String(row.id),
      date: String(row.date),
      time: String(row.time),
      type: String(row.type),
      tags: String(row.tags ?? "").split(",").map(s => s.trim()).filter(Boolean),
      content: String(row.content ?? ""),
      sourceFile: String(row.source_file ?? ""),
      tier: (row.tier as ContextEntry["tier"]) ?? undefined,
      pinned: Boolean(row.pinned),
      archived: Boolean(row.archived),
      project: (row.project as string | null) ?? null,
      sessionId: (row.session_id as string | null) ?? null,
      agentId: (row.agent_id as string | null) ?? null,
      name: (row.name as string | null) ?? undefined,
      summary: (row.summary as string | null) ?? undefined,
      projectRoot: (row.project_root as string | null) ?? undefined,
      referencedEntryIds: refs,
    };
  }

  findCheckpointByName(name: string): ContextEntry | null {
    const row = this.db.prepare(
      "SELECT * FROM entries WHERE name = ? AND archived = 0 LIMIT 1"
    ).get(name) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToEntry(row);
  }

  listCheckpoints(opts: { projectRoot?: string; limit?: number } = {}): ContextEntry[] {
    const limit = opts.limit ?? 20;
    const params: (string | number)[] = [];
    let sql = "SELECT * FROM entries WHERE type = 'checkpoint' AND archived = 0";
    if (opts.projectRoot) {
      sql += " AND project_root = ?";
      params.push(opts.projectRoot);
    }
    sql += " ORDER BY date DESC, time DESC LIMIT ?";
    params.push(limit);
    const rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    return rows.map(r => this.rowToEntry(r));
  }

  /** Change tier for an entry */
  changeTier(id: string, tier: "ephemeral" | "working" | "longterm"): boolean {
    if (tier !== "ephemeral" && tier !== "working" && tier !== "longterm") {
      throw new Error("Invalid tier: must be ephemeral, working, or longterm");
    }
    const result = this.db.prepare(
      "UPDATE entries SET tier = ? WHERE id = ?"
    ).run(tier, id);
    return result.changes > 0;
  }

  close(): void {
    this.db.close();
  }
}
