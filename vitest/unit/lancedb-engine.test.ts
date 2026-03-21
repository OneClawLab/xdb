import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LanceDBEngine } from '../../src/engines/lancedb-engine.js';

/**
 * Helper: generate a simple float vector of given dimension.
 */
function makeVector(dim: number, seed: number): number[] {
  const vec: number[] = [];
  for (let i = 0; i < dim; i++) {
    vec.push(Math.sin(seed + i));
  }
  return vec;
}

describe('LanceDBEngine', () => {
  let tmpDir: string;
  let engine: LanceDBEngine;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'xdb-lance-test-'));
  });

  afterEach(async () => {
    if (engine) {
      await engine.close();
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe('open', () => {
    it('opens a new LanceDB connection without error', async () => {
      engine = await LanceDBEngine.open(tmpDir);
      expect(await engine.countRows()).toBe(0);
    });

    it('reopens an existing LanceDB after data has been written', async () => {
      engine = await LanceDBEngine.open(tmpDir);
      await engine.upsert([
        { id: 'a', vector: makeVector(4, 1), label: 'first' },
      ]);
      await engine.close();

      engine = await LanceDBEngine.open(tmpDir);
      expect(await engine.countRows()).toBe(1);
    });
  });

  describe('upsert (Req 4.5)', () => {
    it('inserts new records', async () => {
      engine = await LanceDBEngine.open(tmpDir);
      const result = await engine.upsert([
        { id: 'r1', vector: makeVector(4, 1), tag: 'a' },
        { id: 'r2', vector: makeVector(4, 2), tag: 'b' },
      ]);

      expect(result.inserted).toBe(2);
      expect(result.updated).toBe(0);
      expect(await engine.countRows()).toBe(2);
    });

    it('updates existing records (upsert semantics)', async () => {
      engine = await LanceDBEngine.open(tmpDir);
      await engine.upsert([
        { id: 'r1', vector: makeVector(4, 1), tag: 'old' },
      ]);

      const result = await engine.upsert([
        { id: 'r1', vector: makeVector(4, 1), tag: 'new' },
      ]);

      expect(result.updated).toBe(1);
      expect(result.inserted).toBe(0);
      expect(await engine.countRows()).toBe(1);

      const rows = await engine.filterSearch("id = 'r1'", 10);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.data.tag).toBe('new');
    });

    it('handles mixed insert and update', async () => {
      engine = await LanceDBEngine.open(tmpDir);
      await engine.upsert([
        { id: 'r1', vector: makeVector(4, 1), tag: 'a' },
      ]);

      const result = await engine.upsert([
        { id: 'r1', vector: makeVector(4, 1), tag: 'updated' },
        { id: 'r2', vector: makeVector(4, 2), tag: 'new' },
      ]);

      expect(result.inserted).toBe(1);
      expect(result.updated).toBe(1);
      expect(await engine.countRows()).toBe(2);
    });

    it('returns zeros for empty records array', async () => {
      engine = await LanceDBEngine.open(tmpDir);
      const result = await engine.upsert([]);
      expect(result.inserted).toBe(0);
      expect(result.updated).toBe(0);
    });
  });

  describe('vectorSearch (Req 6.1, 8.2)', () => {
    it('returns nearest neighbors', async () => {
      engine = await LanceDBEngine.open(tmpDir);
      await engine.upsert([
        { id: 'v1', vector: [1, 0, 0, 0], label: 'x-axis' },
        { id: 'v2', vector: [0, 1, 0, 0], label: 'y-axis' },
        { id: 'v3', vector: [0, 0, 1, 0], label: 'z-axis' },
      ]);

      const results = await engine.vectorSearch([0.9, 0.1, 0, 0], { limit: 2 });
      expect(results.length).toBeLessThanOrEqual(2);
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0]!._engine).toBe('lancedb');
      expect(typeof results[0]!._score).toBe('number');
      expect(results[0]!.data.id).toBe('v1');
    });

    it('applies pre-filter (Req 8.2)', async () => {
      engine = await LanceDBEngine.open(tmpDir);
      await engine.upsert([
        { id: 'v1', vector: [1, 0, 0, 0], category: 'A' },
        { id: 'v2', vector: [0.9, 0.1, 0, 0], category: 'B' },
        { id: 'v3', vector: [0, 1, 0, 0], category: 'A' },
      ]);

      const results = await engine.vectorSearch([1, 0, 0, 0], {
        limit: 10,
        filter: "category = 'A'",
      });

      expect(results.every((r) => r.data.category === 'A')).toBe(true);
      expect(results.find((r) => r.data.id === 'v2')).toBeUndefined();
    });

    it('respects limit', async () => {
      engine = await LanceDBEngine.open(tmpDir);
      const records: { id: string; vector: number[]; idx: number }[] = [];
      for (let i = 0; i < 20; i++) {
        records.push({ id: `v${i}`, vector: makeVector(4, i), idx: i });
      }
      await engine.upsert(records);

      const results = await engine.vectorSearch(makeVector(4, 0), { limit: 5 });
      expect(results.length).toBeLessThanOrEqual(5);
    });

    it('returns empty for uninitialized table', async () => {
      engine = await LanceDBEngine.open(tmpDir);
      const results = await engine.vectorSearch([1, 0, 0, 0], { limit: 10 });
      expect(results).toHaveLength(0);
    });
  });

  describe('filterSearch (Req 8.6)', () => {
    it('filters records by scalar condition', async () => {
      engine = await LanceDBEngine.open(tmpDir);
      await engine.upsert([
        { id: 'f1', vector: [1, 0, 0, 0], status: 'active' },
        { id: 'f2', vector: [0, 1, 0, 0], status: 'inactive' },
        { id: 'f3', vector: [0, 0, 1, 0], status: 'active' },
      ]);

      const results = await engine.filterSearch("status = 'active'", 10);
      expect(results).toHaveLength(2);
      expect(results.every((r) => r.data.status === 'active')).toBe(true);
      expect(results.every((r) => r._engine === 'lancedb')).toBe(true);
    });

    it('respects limit', async () => {
      engine = await LanceDBEngine.open(tmpDir);
      const records: { id: string; vector: number[]; tag: string }[] = [];
      for (let i = 0; i < 10; i++) {
        records.push({ id: `f${i}`, vector: makeVector(4, i), tag: 'same' });
      }
      await engine.upsert(records);

      const results = await engine.filterSearch("tag = 'same'", 3);
      expect(results.length).toBeLessThanOrEqual(3);
    });

    it('returns empty for uninitialized table', async () => {
      engine = await LanceDBEngine.open(tmpDir);
      const results = await engine.filterSearch("status = 'active'", 10);
      expect(results).toHaveLength(0);
    });
  });

  describe('countRows', () => {
    it('returns 0 for empty/uninitialized table', async () => {
      engine = await LanceDBEngine.open(tmpDir);
      expect(await engine.countRows()).toBe(0);
    });

    it('returns correct count after inserts', async () => {
      engine = await LanceDBEngine.open(tmpDir);
      await engine.upsert([
        { id: 'a', vector: [1, 0, 0, 0] },
        { id: 'b', vector: [0, 1, 0, 0] },
        { id: 'c', vector: [0, 0, 1, 0] },
      ]);
      expect(await engine.countRows()).toBe(3);
    });
  });

  describe('close', () => {
    it('closes without error on initialized engine', async () => {
      engine = await LanceDBEngine.open(tmpDir);
      await engine.upsert([{ id: 'x', vector: [1, 0, 0, 0] }]);
      await engine.close();
      engine = undefined as unknown as LanceDBEngine;
    });

    it('closes without error on uninitialized (deferred) engine', async () => {
      engine = await LanceDBEngine.open(tmpDir);
      await engine.close();
      engine = undefined as unknown as LanceDBEngine;
    });
  });

  describe('SearchResult format', () => {
    it('vectorSearch results have _engine=lancedb and numeric _score', async () => {
      engine = await LanceDBEngine.open(tmpDir);
      await engine.upsert([
        { id: 'doc1', vector: [1, 0, 0, 0], text: 'hello' },
      ]);

      const results = await engine.vectorSearch([1, 0, 0, 0], { limit: 10 });
      expect(results).toHaveLength(1);
      expect(results[0]!._engine).toBe('lancedb');
      expect(typeof results[0]!._score).toBe('number');
      expect(results[0]!._score).toBeGreaterThan(0);
    });

    it('filterSearch results have _engine=lancedb and no _score', async () => {
      engine = await LanceDBEngine.open(tmpDir);
      await engine.upsert([
        { id: 'doc1', vector: [1, 0, 0, 0], text: 'hello' },
      ]);

      const results = await engine.filterSearch("id = 'doc1'", 10);
      expect(results).toHaveLength(1);
      expect(results[0]!._engine).toBe('lancedb');
      expect(results[0]!._score).toBeUndefined();
    });
  });

  describe('data round-trip', () => {
    it('preserves scalar fields through write and read', async () => {
      engine = await LanceDBEngine.open(tmpDir);
      const original = {
        id: 'rt1',
        vector: [1.0, 2.0, 3.0, 4.0],
        name: 'test-record',
        count: 42,
      };

      await engine.upsert([original]);
      const results = await engine.filterSearch("id = 'rt1'", 1);
      expect(results).toHaveLength(1);
      expect(results[0]!.data.id).toBe('rt1');
      expect(results[0]!.data.name).toBe('test-record');
      expect(results[0]!.data.count).toBe(42);
    });
  });
});
