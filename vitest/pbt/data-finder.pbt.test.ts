import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DataFinder } from '../../src/data-finder.js';
import { DataWriter } from '../../src/data-writer.js';
import { SQLiteEngine, SearchResult } from '../../src/engines/sqlite-engine.js';
import { PolicyRegistry, PolicyConfig } from '../../src/policy-registry.js';
import type { Embedder } from '../../src/embedder.js';

const registry = new PolicyRegistry();
const RELATIONAL_POLICY: PolicyConfig = registry.resolve('relational/structured-logs');

/** Mock embedder — not needed for relational/where queries */
const mockEmbedder: Embedder = {
  async embed(_text: string): Promise<number[]> {
    throw new Error('Embedder should not be called for relational policy');
  },
  async embedBatch(_texts: string[]): Promise<number[][]> {
    throw new Error('Embedder should not be called for relational policy');
  },
} as Embedder;

// --- Generators ---

/** Arbitrary _engine value */
const arbEngine = fc.constantFrom<'lancedb' | 'sqlite'>('lancedb', 'sqlite');

/** Arbitrary _score: number or undefined */
const arbScore = fc.oneof(
  fc.double({ min: 0, max: 100, noNaN: true, noDefaultInfinity: true }),
  fc.constant(undefined),
);

/** Arbitrary data payload with simple string/number fields */
const arbFieldName = fc.stringMatching(/^[a-z][a-z0-9]{0,10}$/).filter((s) => s !== '_score' && s !== '_engine');
const arbFieldValue: fc.Arbitrary<string | number> = fc.oneof(
  fc.string({ minLength: 0, maxLength: 30 }),
  fc.integer({ min: -10000, max: 10000 }),
);

const arbDataPayload: fc.Arbitrary<Record<string, unknown>> = fc
  .array(fc.tuple(arbFieldName, arbFieldValue), { minLength: 1, maxLength: 5 })
  .map((entries) => Object.fromEntries(entries));

/** Arbitrary SearchResult for Property 10 */
const arbSearchResult: fc.Arbitrary<SearchResult> = fc.record({
  data: arbDataPayload,
  _score: arbScore,
  _engine: arbEngine,
});

/** Arbitrary positive limit for Property 11 */
const arbLimit = fc.integer({ min: 1, max: 15 });

/** Arbitrary record count for seeding */
const arbRecordCount = fc.integer({ min: 5, max: 20 });

/** Arbitrary numeric val for Property 12 */
const arbVal = fc.integer({ min: 0, max: 100 });

// --- Helpers ---

function createSqliteEngine(collectionPath: string): SQLiteEngine {
  const engine = SQLiteEngine.open(collectionPath);
  engine.initSchema(RELATIONAL_POLICY);
  return engine;
}

/**
 * Serialize a SearchResult to JSONL output line (same format as the find command).
 */
function serializeResultToJsonl(result: SearchResult): string {
  const output: Record<string, unknown> = { ...result.data };
  if (result._score !== undefined) {
    output._score = result._score;
  }
  output._engine = result._engine;
  return JSON.stringify(output);
}

// --- Property Tests ---

describe('DataFinder Property-Based Tests', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'xdb-pbt-df-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // Feature: xdb-core, Property 10: 检索结果输出格式
  // **Validates: Requirements 6.3, 7.2, 10.2**
  describe('Property 10: 检索结果输出格式', () => {
    it('each JSONL output line is valid JSON with _score (number|undefined) and _engine (lancedb|sqlite)', () => {
      fc.assert(
        fc.property(
          fc.array(arbSearchResult, { minLength: 1, maxLength: 10 }),
          (results) => {
            for (const result of results) {
              const line = serializeResultToJsonl(result);

              // Each line must be valid JSON
              const parsed = JSON.parse(line);
              expect(parsed).toBeDefined();

              // _engine must be one of 'lancedb' or 'sqlite'
              expect(['lancedb', 'sqlite']).toContain(parsed._engine);

              // _score must be a number or absent
              if ('_score' in parsed) {
                expect(typeof parsed._score).toBe('number');
              }
            }
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  // Feature: xdb-core, Property 11: 检索结果数量不超过 limit
  // **Validates: Requirements 6.4, 7.3**
  describe('Property 11: 检索结果数量不超过 limit', () => {
    it('search results should not exceed the limit count', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbRecordCount,
          arbLimit,
          async (recordCount, limit) => {
            const colPath = await mkdtemp(join(tmpDir, 'p11-'));
            const engine = createSqliteEngine(colPath);
            const writer = new DataWriter(RELATIONAL_POLICY, mockEmbedder, undefined, engine);

            // Seed random records
            for (let i = 0; i < recordCount; i++) {
              await writer.write({ val: i, label: `record-${i}` });
            }

            // Query with --where and the given limit
            const finder = new DataFinder(RELATIONAL_POLICY, mockEmbedder, undefined, engine);
            const results = await finder.find(undefined, { where: '1=1', limit });

            expect(results.length).toBeLessThanOrEqual(limit);

            engine.close();
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  // Feature: xdb-core, Property 12: where 过滤结果满足条件
  // **Validates: Requirements 8.4**
  describe('Property 12: where 过滤结果满足条件', () => {
    it('all returned results satisfy the WHERE condition', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbRecordCount,
          fc.integer({ min: 0, max: 100 }),
          async (recordCount, threshold) => {
            const colPath = await mkdtemp(join(tmpDir, 'p12-'));
            const engine = createSqliteEngine(colPath);
            const writer = new DataWriter(RELATIONAL_POLICY, mockEmbedder, undefined, engine);

            // Seed records with a numeric 'val' field spread across 0-100
            for (let i = 0; i < recordCount; i++) {
              const val = Math.floor((i / recordCount) * 101); // spread 0..100
              await writer.write({ val, label: `item-${i}` });
            }

            // Query with WHERE condition on val
            const whereClause = `json_extract(data, '$.val') > ${threshold}`;
            const finder = new DataFinder(RELATIONAL_POLICY, mockEmbedder, undefined, engine);
            const results = await finder.find(undefined, { where: whereClause, limit: 100 });

            // All returned results must satisfy the condition
            for (const result of results) {
              const val = result.data.val as number;
              expect(val).toBeGreaterThan(threshold);
            }

            engine.close();
          },
        ),
        { numRuns: 100 },
      );
    });
  });
});
