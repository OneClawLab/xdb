import { v4 as uuidv4 } from 'uuid';
import { PARAMETER_ERROR, XDBError } from './errors.js';
import type { Embedder } from './embedder.js';
import type { LanceDBEngine } from './engines/lancedb-engine.js';
import type { SQLiteEngine } from './engines/sqlite-engine.js';
import type { PolicyConfig } from './policy-registry.js';

export interface WriteResult {
  inserted: number;
  updated: number;
  errors: number;
}

export class DataWriter {
  constructor(
    private policy: PolicyConfig,
    private embedder: Embedder,
    private lanceEngine?: LanceDBEngine,
    private sqliteEngine?: SQLiteEngine,
  ) {}

  /**
   * Write a single record. Auto-generates UUID if no `id` field present.
   * Routes data to engines based on Policy findCaps configuration.
   */
  async write(record: Record<string, unknown>): Promise<WriteResult> {
    this.validateRecord(record);

    // Auto-generate UUID if missing
    if (record.id === undefined || record.id === null) {
      record = { ...record, id: uuidv4() };
    }

    const result: WriteResult = { inserted: 0, updated: 0, errors: 0 };

    // Determine which engines need data
    const hasSimilarFields = this.getSimilarFields().length > 0;
    const needsSqlite = this.needsSqliteWrite();

    // Write to LanceDB if there are similar fields
    if (hasSimilarFields && this.lanceEngine) {
      const vectorRecord = await this.buildVectorRecord(record);
      const lanceResult = await this.lanceEngine.upsert([vectorRecord]);
      result.inserted += lanceResult.inserted;
      result.updated += lanceResult.updated;
    }

    // Write to SQLite if needed
    if (needsSqlite && this.sqliteEngine) {
      const sqliteResult = this.sqliteEngine.upsert([record]);
      // Only count SQLite stats if LanceDB didn't already count
      if (!hasSimilarFields || !this.lanceEngine) {
        result.inserted += sqliteResult.inserted;
        result.updated += sqliteResult.updated;
      }
    }

    // If neither engine was written to, still count as inserted
    if ((!hasSimilarFields || !this.lanceEngine) && (!needsSqlite || !this.sqliteEngine)) {
      result.inserted = 1;
    }

    return result;
  }

  /**
   * Batch write with transaction optimization and error tolerance.
   * Failed records are skipped with a warning to stderr.
   */
  async writeBatch(records: Record<string, unknown>[]): Promise<WriteResult> {
    const result: WriteResult = { inserted: 0, updated: 0, errors: 0 };

    // Validate and prepare records, assigning UUIDs where needed
    const prepared: Record<string, unknown>[] = [];
    const validIndices: number[] = [];

    for (let i = 0; i < records.length; i++) {
      try {
        this.validateRecord(records[i]);
        let rec = records[i];
        if (rec.id === undefined || rec.id === null) {
          rec = { ...rec, id: uuidv4() };
        }
        prepared.push(rec);
        validIndices.push(i);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Warning: Line ${i + 1}: ${msg}\n`);
        result.errors++;
      }
    }

    if (prepared.length === 0) {
      return result;
    }

    const hasSimilarFields = this.getSimilarFields().length > 0;
    const needsSqlite = this.needsSqliteWrite();

    // Write to LanceDB with batch embedding
    if (hasSimilarFields && this.lanceEngine) {
      const vectorRecords: Record<string, unknown>[] = [];
      const similarFields = this.getSimilarFields();

      // Collect all texts for batch embedding
      const textsPerField: Map<string, string[]> = new Map();
      for (const field of similarFields) {
        textsPerField.set(field, prepared.map((r) => String(r[field] ?? '')));
      }

      // Batch embed each similar field
      const vectorsPerField: Map<string, number[][]> = new Map();
      for (const [field, texts] of textsPerField) {
        const vectors = await this.embedder.embedBatch(texts);
        vectorsPerField.set(field, vectors);
      }

      // Build vector records
      for (let i = 0; i < prepared.length; i++) {
        const rec: Record<string, unknown> = { ...prepared[i] };
        for (const [field, vectors] of vectorsPerField) {
          rec[`${field}_vector`] = new Float32Array(vectors[i]);
        }
        vectorRecords.push(rec);
      }

      try {
        const lanceResult = await this.lanceEngine.upsert(vectorRecords);
        result.inserted += lanceResult.inserted;
        result.updated += lanceResult.updated;
      } catch (err) {
        // In batch mode, lance failures count as errors for all records
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Warning: LanceDB batch write failed: ${msg}\n`);
        result.errors += prepared.length;
        // If SQLite also needs writing, still attempt it
        if (needsSqlite && this.sqliteEngine) {
          const sqliteResult = this.sqliteEngine.batchUpsert(prepared);
          // Don't double-count — these were already counted as errors from lance
          // Just do the sqlite write for data consistency
          void sqliteResult;
        }
        return result;
      }
    }

    // Write to SQLite with batch transaction
    if (needsSqlite && this.sqliteEngine) {
      const sqliteResult = this.sqliteEngine.batchUpsert(prepared);
      // Only count SQLite stats if LanceDB didn't already count
      if (!hasSimilarFields || !this.lanceEngine) {
        result.inserted += sqliteResult.inserted;
        result.updated += sqliteResult.updated;
      }
      result.errors += sqliteResult.errors;
    }

    return result;
  }

  /** Get field names that have 'similar' findCaps */
  private getSimilarFields(): string[] {
    return Object.entries(this.policy.fields)
      .filter(([, cfg]) => cfg.findCaps.includes('similar'))
      .map(([name]) => name);
  }

  /** Check if SQLite write is needed based on policy */
  private needsSqliteWrite(): boolean {
    // Has match fields
    const hasMatchFields = Object.values(this.policy.fields)
      .some((cfg) => cfg.findCaps.includes('match'));
    // autoIndex is enabled
    return hasMatchFields || !!this.policy.autoIndex;
  }

  /** Validate that a record is a valid object */
  private validateRecord(record: unknown): void {
    if (record === null || record === undefined || typeof record !== 'object' || Array.isArray(record)) {
      throw new XDBError(PARAMETER_ERROR, 'Invalid input: expected a JSON object');
    }
  }

  /** Build a record with vector fields for LanceDB */
  private async buildVectorRecord(record: Record<string, unknown>): Promise<Record<string, unknown>> {
    const similarFields = this.getSimilarFields();
    const vectorRecord: Record<string, unknown> = { ...record };

    for (const field of similarFields) {
      const text = String(record[field] ?? '');
      const vector = await this.embedder.embed(text);
      vectorRecord[`${field}_vector`] = new Float32Array(vector);
    }

    return vectorRecord;
  }
}
