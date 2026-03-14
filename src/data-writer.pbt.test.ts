import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DataWriter } from './data-writer.js';
import { SQLiteEngine } from './engines/sqlite-engine.js';
import { PolicyRegistry, PolicyConfig } from './policy-registry.js';
import type { Embedder } from './embedder.js';

const registry = new PolicyRegistry();

/** Use relational/structured-logs policy: autoIndex true, no similar fields, no embedder calls */
const RELATIONAL_POLICY: PolicyConfig = registry.resolve('relational/structured-logs');

/** UUID v4 regex */
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Mock embedder — should never be called for relational policy */
const mockEmbedder: Embedder = {
  async embed(_text: string): Promise<number[]> {
    throw new Error('Embedder should not be called for relational policy');
  },
  async embedBatch(_texts: string[]): Promise<number[][]> {
    throw new Error('Embedder should not be called for relational policy');
  },
} as Embedder;

// --- Generators ---

/** Arbitrary field name (simple alphanumeric, avoids 'id' key) */
const arbFieldName = fc.stringMatching(/^[a-z][a-z0-9]{0,10}$/).filter((s) => s !== 'id');

/** Arbitrary field value: string or number */
const arbFieldValue: fc.Arbitrary<string | number> = fc.oneof(
  fc.string({ minLength: 0, maxLength: 50 }),
  fc.integer({ min: -10000, max: 10000 }),
);

/**
 * Property 7 generator: random JSON objects without 'id' field, 1-5 fields.
 */
const arbRecordWithoutId: fc.Arbitrary<Record<string, unknown>> = fc
  .array(fc.tuple(arbFieldName, arbFieldValue), { minLength: 1, maxLength: 5 })
  .map((entries) => Object.fromEntries(entries));

/**
 * Property 8 generator: a random id string and two different data payloads.
 */
const arbUpsertData = fc.record({
  id: fc.stringMatching(/^[a-z0-9]{4,16}$/),
  payload1: fc.dictionary(arbFieldName, arbFieldValue, { minKeys: 1, maxKeys: 3 }),
  payload2: fc.dictionary(arbFieldName, arbFieldValue, { minKeys: 1, maxKeys: 3 }),
});

/**
 * Property 9 generator: arrays of 1-10 items mixing valid objects with invalid values.
 */
const arbBatchInput: fc.Arbitrary<unknown[]> = fc.array(
  fc.oneof(
    // Valid object (weight 3)
    { weight: 3, arbitrary: arbRecordWithoutId },
    // Invalid: null
    { weight: 1, arbitrary: fc.constant(null) },
    // Invalid: number
    { weight: 1, arbitrary: fc.integer() },
    // Invalid: string
    { weight: 1, arbitrary: fc.string() },
    // Invalid: array
    { weight: 1, arbitrary: fc.array(fc.integer(), { minLength: 0, maxLength: 3 }) },
  ),
  { minLength: 1, maxLength: 10 },
);

// --- Helpers ---

/** Create a fresh SQLiteEngine in a temp directory with relational policy schema */
function createSqliteEngine(collectionPath: string): SQLiteEngine {
  const engine = SQLiteEngine.open(collectionPath);
  engine.initSchema(RELATIONAL_POLICY);
  return engine;
}

// --- Property Tests ---

describe('DataWriter Property-Based Tests', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'xdb-pbt-dw-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // Feature: xdb-core, Property 7: 自动生成 UUID
  // **Validates: Requirements 4.4**
  describe('Property 7: 自动生成 UUID', () => {
    it('records without id get a valid UUID v4, and different records get different ids', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(arbRecordWithoutId, { minLength: 2, maxLength: 5 }),
          async (records) => {
            const colPath = await mkdtemp(join(tmpDir, 'p7-'));
            const engine = createSqliteEngine(colPath);
            const writer = new DataWriter(RELATIONAL_POLICY, mockEmbedder, undefined, engine);

            const assignedIds: string[] = [];

            for (const rec of records) {
              // Ensure no id field
              expect(rec).not.toHaveProperty('id');

              await writer.write(rec);

              // Read back the last inserted record to get its id
              const count = engine.countRows();
              expect(count).toBeGreaterThan(0);
            }

            // Read all records from SQLite to collect assigned ids
            const allRows = engine.whereSearch('1=1', 1000);
            for (const row of allRows) {
              const id = row.data.id as string;
              // Each id must be a valid UUID v4
              expect(id).toMatch(UUID_V4_RE);
              assignedIds.push(id);
            }

            // All ids must be unique
            const uniqueIds = new Set(assignedIds);
            expect(uniqueIds.size).toBe(assignedIds.length);

            engine.close();
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  // Feature: xdb-core, Property 8: Upsert 语义正确性
  // **Validates: Requirements 4.3**
  describe('Property 8: Upsert 语义正确性', () => {
    it('writing with the same id results in only one record with the latest data', async () => {
      await fc.assert(
        fc.asyncProperty(arbUpsertData, async ({ id, payload1, payload2 }) => {
          const colPath = await mkdtemp(join(tmpDir, 'p8-'));
          const engine = createSqliteEngine(colPath);
          const writer = new DataWriter(RELATIONAL_POLICY, mockEmbedder, undefined, engine);

          // Write first version
          const record1 = { id, ...payload1 };
          await writer.write(record1);

          // Verify one record exists
          expect(engine.countRows()).toBe(1);

          // Write second version with same id
          const record2 = { id, ...payload2 };
          await writer.write(record2);

          // Still only one record
          expect(engine.countRows()).toBe(1);

          // The record should have the latest data
          const results = engine.whereSearch(`id = '${id}'`, 10);
          expect(results).toHaveLength(1);

          const storedData = results[0].data;
          expect(storedData.id).toBe(id);

          // Verify the stored data contains the latest payload fields
          for (const [key, value] of Object.entries(payload2)) {
            expect(storedData[key]).toEqual(value);
          }

          engine.close();
        }),
        { numRuns: 100 },
      );
    });
  });

  // Feature: xdb-core, Property 9: 批量写入统计不变量
  // **Validates: Requirements 5.2, 5.3**
  describe('Property 9: 批量写入统计不变量', () => {
    it('inserted + updated + errors = total input count', async () => {
      await fc.assert(
        fc.asyncProperty(arbBatchInput, async (inputs) => {
          const colPath = await mkdtemp(join(tmpDir, 'p9-'));
          const engine = createSqliteEngine(colPath);
          const writer = new DataWriter(RELATIONAL_POLICY, mockEmbedder, undefined, engine);

          // Suppress stderr warnings during batch write
          const originalWrite = process.stderr.write;
          process.stderr.write = (() => true) as typeof process.stderr.write;

          try {
            const result = await writer.writeBatch(inputs as Record<string, unknown>[]);

            // The invariant: inserted + updated + errors = total input count
            const total = result.inserted + result.updated + result.errors;
            expect(total).toBe(inputs.length);
          } finally {
            process.stderr.write = originalWrite;
          }

          engine.close();
        }),
        { numRuns: 100 },
      );
    });
  });
});
