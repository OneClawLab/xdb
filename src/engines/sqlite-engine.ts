import Database from 'better-sqlite3';
import { join } from 'node:path';
import { RUNTIME_ERROR, XDBError } from '../errors.js';
import type { PolicyConfig } from '../policy-registry.js';

export interface SearchResultScores {
  vector?: number;
  fts?: number;
  final?: number;
  sources?: Array<'vector' | 'fts'>;
  rank?: { vector?: number; fts?: number };
}

export interface SearchResult {
  data: Record<string, unknown>;
  _score?: number;
  _engine: 'lancedb' | 'sqlite' | 'hybrid';
  _scores?: SearchResultScores;
}

export class SQLiteEngine {
  private db: Database.Database;
  private hasFts = false;
  private ftsFields: string[] = [];

  private constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Open or create a SQLite database at `<collectionPath>/relational.db`.
   */
  static open(collectionPath: string): SQLiteEngine {
    try {
      const dbPath = join(collectionPath, 'relational.db');
      const db = new Database(dbPath);
      db.pragma('journal_mode = WAL');
      return new SQLiteEngine(db);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new XDBError(RUNTIME_ERROR, `Failed to open SQLite database: ${msg}`);
    }
  }

  /**
   * Initialize table schema based on Policy configuration.
   * Creates the records table and, if the policy has fields with 'match' findCaps,
   * creates a standalone FTS5 virtual table for full-text search.
   */
  initSchema(policy: PolicyConfig): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS records (
        id TEXT PRIMARY KEY,
        data JSON NOT NULL
      );
    `);

    // Determine which fields have 'match' findCaps
    this.ftsFields = Object.entries(policy.fields)
      .filter(([, cfg]) => cfg.findCaps.includes('match'))
      .map(([name]) => name);

    if (this.ftsFields.length > 0) {
      const columnDefs = this.ftsFields.join(', ');
      // Standalone FTS5 table (no content= sync) — we manage inserts/deletes manually
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS records_fts USING fts5(
          id UNINDEXED,
          ${columnDefs}
        );
      `);
      this.hasFts = true;
    }
  }

  /**
   * Sync FTS index for a single record: delete old entry then insert new one.
   */
  private syncFts(record: Record<string, unknown>): void {
    if (!this.hasFts) return;
    const id = String(record.id);

    // Delete existing FTS entry
    this.db.prepare('DELETE FROM records_fts WHERE id = ?').run(id);

    // Insert new FTS entry
    const cols = ['id', ...this.ftsFields];
    const placeholders = cols.map(() => '?').join(', ');
    const values = [id, ...this.ftsFields.map((f) => String(record[f] ?? ''))];
    this.db.prepare(`INSERT INTO records_fts (${cols.join(', ')}) VALUES (${placeholders})`).run(...values);
  }

  /**
   * Upsert records into the database. Each record must have an `id` field.
   * Uses INSERT OR REPLACE for upsert semantics.
   */
  upsert(records: Record<string, unknown>[]): { inserted: number; updated: number } {
    let inserted = 0;
    let updated = 0;

    const checkStmt = this.db.prepare('SELECT 1 FROM records WHERE id = ?');
    const upsertStmt = this.db.prepare(
      'INSERT OR REPLACE INTO records (id, data) VALUES (?, ?)',
    );

    const txn = this.db.transaction(() => {
      for (const record of records) {
        const id = String(record.id);
        const exists = checkStmt.get(id);
        upsertStmt.run(id, JSON.stringify(record));
        this.syncFts(record);
        if (exists) {
          updated++;
        } else {
          inserted++;
        }
      }
    });

    txn();
    return { inserted, updated };
  }

  /**
   * Batch upsert with error tolerance. Wraps in a transaction.
   * Individual record failures are counted but don't abort the batch.
   */
  batchUpsert(records: Record<string, unknown>[]): { inserted: number; updated: number; errors: number } {
    let inserted = 0;
    let updated = 0;
    let errors = 0;

    const checkStmt = this.db.prepare('SELECT 1 FROM records WHERE id = ?');
    const upsertStmt = this.db.prepare(
      'INSERT OR REPLACE INTO records (id, data) VALUES (?, ?)',
    );

    const txn = this.db.transaction(() => {
      for (const record of records) {
        try {
          const id = String(record.id);
          const exists = checkStmt.get(id);
          upsertStmt.run(id, JSON.stringify(record));
          this.syncFts(record);
          if (exists) {
            updated++;
          } else {
            inserted++;
          }
        } catch {
          errors++;
        }
      }
    });

    txn();
    return { inserted, updated, errors };
  }

  /**
   * Full-text search using FTS5.
   */
  ftsSearch(query: string, limit: number): SearchResult[] {
    if (!this.hasFts) {
      return [];
    }

    const stmt = this.db.prepare(`
      SELECT r.data, fts.rank
      FROM records_fts fts
      JOIN records r ON r.id = fts.id
      WHERE records_fts MATCH ?
      ORDER BY fts.rank
      LIMIT ?
    `);

    const rows = stmt.all(query, limit) as Array<{ data: string; rank: number }>;
    return rows.map((row) => ({
      data: JSON.parse(row.data) as Record<string, unknown>,
      _score: -row.rank, // FTS5 rank is negative; negate for positive score
      _engine: 'sqlite' as const,
    }));
  }

  /**
   * Condition-based filtering using a WHERE clause applied to JSON data.
   */
  whereSearch(filter: string, limit: number): SearchResult[] {
    try {
      const stmt = this.db.prepare(`
        SELECT data FROM records WHERE ${filter} LIMIT ?
      `);
      const rows = stmt.all(limit) as Array<{ data: string }>;
      return rows.map((row) => ({
        data: JSON.parse(row.data) as Record<string, unknown>,
        _engine: 'sqlite' as const,
      }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new XDBError(RUNTIME_ERROR, `WHERE filter error: ${msg}`);
    }
  }

  /**
   * Combined FTS + WHERE search.
   */
  ftsWhereSearch(query: string, filter: string, limit: number): SearchResult[] {
    if (!this.hasFts) {
      return [];
    }

    try {
      const stmt = this.db.prepare(`
        SELECT r.data, fts.rank
        FROM records_fts fts
        JOIN records r ON r.id = fts.id
        WHERE records_fts MATCH ? AND ${filter}
        ORDER BY fts.rank
        LIMIT ?
      `);
      const rows = stmt.all(query, limit) as Array<{ data: string; rank: number }>;
      return rows.map((row) => ({
        data: JSON.parse(row.data) as Record<string, unknown>,
        _score: -row.rank,
        _engine: 'sqlite' as const,
      }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new XDBError(RUNTIME_ERROR, `FTS+WHERE filter error: ${msg}`);
    }
  }

  /**
   * Count total rows in the records table.
   */
  countRows(): number {
    const row = this.db.prepare('SELECT COUNT(*) as cnt FROM records').get() as { cnt: number };
    return row.cnt;
  }

  /**
   * Close the database connection.
   */
  close(): void {
    this.db.close();
  }
}
