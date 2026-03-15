import * as lancedb from '@lancedb/lancedb';
import { join } from 'node:path';
import { RUNTIME_ERROR, XDBError } from '../errors.js';
import type { SearchResult } from './sqlite-engine.js';

export type { SearchResult };

const DEFAULT_TABLE_NAME = 'data';

export class LanceDBEngine {
  private db: lancedb.Connection;
  private table: lancedb.Table;

  protected constructor(db: lancedb.Connection, table: lancedb.Table) {
    this.db = db;
    this.table = table;
  }

  /**
   * Open or create a LanceDB connection at `<collectionPath>/vector.lance/`.
   * If the table does not exist, it will be created on first upsert.
   */
  static async open(collectionPath: string, tableName?: string): Promise<LanceDBEngine> {
    const name = tableName ?? DEFAULT_TABLE_NAME;
    try {
      const dbPath = join(collectionPath, 'vector.lance');
      const db = await lancedb.connect(dbPath);

      // Try to open existing table, or leave table as null until first write
      let table: lancedb.Table;
      const tableNames = await db.tableNames();
      if (tableNames.includes(name)) {
        table = await db.openTable(name);
      } else {
        // Return an engine with a deferred table — will be created on first upsert
        return new LanceDBEngineDeferred(db, name);
      }

      return new LanceDBEngine(db, table);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new XDBError(RUNTIME_ERROR, `Failed to open LanceDB: ${msg}`);
    }
  }

  /**
   * Write records containing vector fields, executing upsert (merge insert on "id").
   * Records should contain an `id` field and at least one vector field (array of numbers).
   */
  async upsert(records: Record<string, unknown>[]): Promise<{ inserted: number; updated: number }> {
    if (records.length === 0) {
      return { inserted: 0, updated: 0 };
    }

    try {
      const countBefore = await this.table.countRows();

      // Build a proper Arrow Table with FixedSizeList for vector columns.
      // LanceDB's mergeInsert path calls makeArrowTable without vectorColumns,
      // which would flatten Float32Array into individual numeric columns.
      const arrowTable = LanceDBEngine.toArrowTable(records);

      await this.table
        .mergeInsert('id')
        .whenMatchedUpdateAll()
        .whenNotMatchedInsertAll()
        .execute(arrowTable);

      const countAfter = await this.table.countRows();
      const netNew = countAfter - countBefore;
      const updated = records.length - netNew;

      return { inserted: netNew, updated };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new XDBError(RUNTIME_ERROR, `LanceDB upsert failed: ${msg}`);
    }
  }

  /**
   * Convert records with Float32Array fields into a proper Arrow Table.
   * Detects Float32Array fields, registers them as vectorColumns, and
   * uses makeArrowTable to create FixedSizeList<Float32> columns.
   * If no Float32Array fields are found, returns records as-is for default handling.
   */
  protected static toArrowTable(records: Record<string, unknown>[]): Record<string, unknown>[] | ReturnType<typeof lancedb.makeArrowTable> {
    // Detect Float32Array fields
    const vectorColumnNames = new Set<string>();
    for (const rec of records) {
      for (const [key, value] of Object.entries(rec)) {
        if (value instanceof Float32Array) {
          vectorColumnNames.add(key);
        }
      }
      if (vectorColumnNames.size > 0) break; // Only need to check first record
    }

    if (vectorColumnNames.size === 0) {
      return records; // No vector fields, let LanceDB handle normally
    }

    // Build vectorColumns config and convert Float32Array to plain Array
    const vectorColumns: Record<string, lancedb.VectorColumnOptions> = {};
    for (const name of vectorColumnNames) {
      vectorColumns[name] = new lancedb.VectorColumnOptions();
    }

    const converted = records.map((rec) => {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(rec)) {
        out[key] = value instanceof Float32Array ? Array.from(value) : value;
      }
      return out;
    });

    return lancedb.makeArrowTable(converted, { vectorColumns });
  }

  /**
   * Nearest neighbor vector search with optional pre-filter.
   */
  async vectorSearch(
    queryVector: number[],
    options: { limit: number; filter?: string; column?: string },
  ): Promise<SearchResult[]> {
    try {
      let query = this.table
        .vectorSearch(queryVector)
        .column(options.column ?? 'vector')
        .limit(options.limit);

      if (options.filter) {
        query = query.where(options.filter);
      }

      const results = await query.toArray();

      return results.map((row) => {
        const data: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(row)) {
          // Skip internal distance field and vector fields (Float32Array / large number arrays)
          if (key === '_distance') continue;
          if (key.endsWith('_vector')) continue;
          data[key] = value;
        }
        return {
          data,
          // Convert cosine distance [0,2] → cosine similarity [0,1]: 1 - distance/2
          _score: row._distance != null ? 1 - row._distance / 2 : undefined,
          _engine: 'lancedb' as const,
        };
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new XDBError(RUNTIME_ERROR, `LanceDB vector search failed: ${msg}`);
    }
  }

  /**
   * Scalar filter query (no vector search).
   */
  async filterSearch(filter: string, limit: number): Promise<SearchResult[]> {
    try {
      const results = await this.table.query().where(filter).limit(limit).toArray();

      return results.map((row) => {
        const data: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(row)) {
          if (key.endsWith('_vector')) continue;
          data[key] = value;
        }
        return {
          data,
          _engine: 'lancedb' as const,
        };
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new XDBError(RUNTIME_ERROR, `LanceDB filter search failed: ${msg}`);
    }
  }

  /**
   * Count total rows in the table.
   */
  async countRows(): Promise<number> {
    return this.table.countRows();
  }

  /**
   * Close the database connection.
   */
  async close(): Promise<void> {
    this.table.close();
    this.db.close();
  }
}


/**
 * A deferred variant of LanceDBEngine that creates the table on first upsert.
 * This is needed because LanceDB requires data to infer schema when creating a table.
 */
class LanceDBEngineDeferred extends LanceDBEngine {
  private deferredDb: lancedb.Connection;
  private tableName: string;
  private initialized = false;

  constructor(db: lancedb.Connection, tableName: string) {
    // Call parent with db and a placeholder — we override all methods
    super(db, undefined as unknown as lancedb.Table);
    this.deferredDb = db;
    this.tableName = tableName;
  }

  private async ensureTable(records?: Record<string, unknown>[]): Promise<lancedb.Table> {
    if (this.initialized) {
      return (this as any).table;
    }

    if (!records || records.length === 0) {
      throw new XDBError(RUNTIME_ERROR, 'LanceDB table does not exist yet. Write data first.');
    }

    // Use toArrowTable to properly handle Float32Array → FixedSizeList<Float32>
    const data = LanceDBEngine.toArrowTable(records);
    const table = await this.deferredDb.createTable(this.tableName, data);
    // Patch the parent's private fields
    (this as any).table = table;
    this.initialized = true;
    return table;
  }

  override async upsert(records: Record<string, unknown>[]): Promise<{ inserted: number; updated: number }> {
    if (records.length === 0) {
      return { inserted: 0, updated: 0 };
    }

    if (!this.initialized) {
      try {
        await this.ensureTable(records);
        return { inserted: records.length, updated: 0 };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new XDBError(RUNTIME_ERROR, `LanceDB upsert failed: ${msg}`);
      }
    }

    return super.upsert(records);
  }

  override async vectorSearch(
    queryVector: number[],
    options: { limit: number; filter?: string; column?: string },
  ): Promise<SearchResult[]> {
    if (!this.initialized) {
      return [];
    }
    return super.vectorSearch(queryVector, options);
  }

  override async filterSearch(filter: string, limit: number): Promise<SearchResult[]> {
    if (!this.initialized) {
      return [];
    }
    return super.filterSearch(filter, limit);
  }

  override async countRows(): Promise<number> {
    if (!this.initialized) {
      return 0;
    }
    return super.countRows();
  }

  override async close(): Promise<void> {
    if (this.initialized) {
      (this as any).table.close();
    }
    this.deferredDb.close();
  }
}
