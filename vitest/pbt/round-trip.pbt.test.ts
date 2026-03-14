import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DataWriter } from '../../src/data-writer.js';
import { DataFinder } from '../../src/data-finder.js';
import { SQLiteEngine } from '../../src/engines/sqlite-engine.js';
import { PolicyRegistry, PolicyConfig } from '../../src/policy-registry.js';
import type { Embedder } from '../../src/embedder.js';

const registry = new PolicyRegistry();
const RELATIONAL_POLICY: PolicyConfig = registry.resolve('relational/structured-logs');

/** Mock embedder — not needed for relational policy */
const mockEmbedder: Embedder = {
  async embed(_text: string): Promise<number[]> {
    throw new Error('Embedder should not be called for relational policy');
  },
  async embedBatch(_texts: string[]): Promise<number[][]> {
    throw new Error('Embedder should not be called for relational policy');
  },
} as Embedder;

// --- Generators ---

/** Alphanumeric id: 4-16 chars */
const arbId = fc.stringMatching(/^[a-z0-9]{4,16}$/);

/** Field name: simple alphanumeric, avoids reserved keys */
const arbFieldName = fc
  .stringMatching(/^[a-z][a-z0-9]{0,10}$/)
  .filter((s) => s !== 'id' && s !== '_score' && s !== '_engine');

/** Field value: string or number */
const arbFieldValue: fc.Arbitrary<string | number> = fc.oneof(
  fc.string({ minLength: 0, maxLength: 50 }),
  fc.integer({ min: -10000, max: 10000 }),
);

/** Random JSON object with explicit id and 1-5 additional fields */
const arbRecord: fc.Arbitrary<Record<string, unknown>> = fc
  .tuple(
    arbId,
    fc.array(fc.tuple(arbFieldName, arbFieldValue), { minLength: 1, maxLength: 5 }),
  )
  .map(([id, entries]) => {
    const obj: Record<string, unknown> = { id };
    for (const [key, value] of entries) {
      obj[key] = value;
    }
    return obj;
  });

// --- Helpers ---

function createSqliteEngine(collectionPath: string): SQLiteEngine {
  const engine = SQLiteEngine.open(collectionPath);
  engine.initSchema(RELATIONAL_POLICY);
  return engine;
}

// --- Property Tests ---

// Feature: xdb-core, Property 13: 数据 round-trip 一致性
// **Validates: Requirements 10.4**
describe('Property 13: 数据 round-trip 一致性', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'xdb-pbt-rt-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('data written via DataWriter and read back via DataFinder should be equivalent to the original input', async () => {
    await fc.assert(
      fc.asyncProperty(arbRecord, async (record) => {
        const colPath = await mkdtemp(join(tmpDir, 'p13-'));
        const engine = createSqliteEngine(colPath);
        const writer = new DataWriter(RELATIONAL_POLICY, mockEmbedder, undefined, engine);
        const finder = new DataFinder(RELATIONAL_POLICY, mockEmbedder, undefined, engine);

        // Write the record
        await writer.write(record);

        // Read back via DataFinder with --where using json_extract on id
        const id = record.id as string;
        const whereClause = `json_extract(data, '$.id') = '${id}'`;
        const results = await finder.find(undefined, { where: whereClause, limit: 1 });

        expect(results).toHaveLength(1);

        // Extract the returned data, excluding system metadata
        const returned = { ...results[0].data };
        delete returned._score;
        delete returned._engine;

        // The returned data should be equivalent to the original input
        expect(returned).toEqual(record);

        engine.close();
      }),
      { numRuns: 100 },
    );
  });
});
