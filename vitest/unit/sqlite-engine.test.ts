import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SQLiteEngine } from '../../src/engines/sqlite-engine.js';
import { XDBError } from '../../src/errors.js';
import type { PolicyConfig } from '../../src/policy-registry.js';

const hybridPolicy: PolicyConfig = {
  main: 'hybrid',
  minor: 'knowledge-base',
  fields: { content: { findCaps: ['similar', 'match'] } },
  autoIndex: true,
};

const relationalPolicy: PolicyConfig = {
  main: 'relational',
  minor: 'structured-logs',
  fields: {},
  autoIndex: true,
};

const multiMatchPolicy: PolicyConfig = {
  main: 'relational',
  minor: 'structured-logs',
  fields: {
    title: { findCaps: ['match'] },
    body: { findCaps: ['match'] },
  },
  autoIndex: true,
};

describe('SQLiteEngine', () => {
  let tmpDir: string;
  let engine: SQLiteEngine;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'xdb-sqlite-test-'));
  });

  afterEach(async () => {
    if (engine) {
      engine.close();
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe('open and initSchema', () => {
    it('creates relational.db and initializes records table', () => {
      engine = SQLiteEngine.open(tmpDir);
      engine.initSchema(relationalPolicy);
      expect(engine.countRows()).toBe(0);
    });

    it('creates FTS5 virtual table when policy has match findCaps', () => {
      engine = SQLiteEngine.open(tmpDir);
      engine.initSchema(hybridPolicy);
      engine.upsert([{ id: 'doc1', content: 'hello world' }]);
      const results = engine.ftsSearch('hello', 10);
      expect(results).toHaveLength(1);
      expect(results[0]!.data.content).toBe('hello world');
    });

    it('does not create FTS5 when no match findCaps fields', () => {
      engine = SQLiteEngine.open(tmpDir);
      engine.initSchema(relationalPolicy);
      engine.upsert([{ id: 'doc1', content: 'hello world' }]);
      const results = engine.ftsSearch('hello', 10);
      expect(results).toHaveLength(0);
    });
  });

  describe('upsert', () => {
    it('inserts new records', () => {
      engine = SQLiteEngine.open(tmpDir);
      engine.initSchema(relationalPolicy);

      const result = engine.upsert([
        { id: 'a', value: 1 },
        { id: 'b', value: 2 },
      ]);

      expect(result.inserted).toBe(2);
      expect(result.updated).toBe(0);
      expect(engine.countRows()).toBe(2);
    });

    it('updates existing records (upsert semantics, Req 4.3)', () => {
      engine = SQLiteEngine.open(tmpDir);
      engine.initSchema(relationalPolicy);

      engine.upsert([{ id: 'a', value: 'old' }]);
      const result = engine.upsert([{ id: 'a', value: 'new' }]);

      expect(result.inserted).toBe(0);
      expect(result.updated).toBe(1);
      expect(engine.countRows()).toBe(1);

      const rows = engine.whereSearch("json_extract(data, '$.id') = 'a'", 10);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.data.value).toBe('new');
    });

    it('handles mixed insert and update', () => {
      engine = SQLiteEngine.open(tmpDir);
      engine.initSchema(relationalPolicy);

      engine.upsert([{ id: 'a', value: 1 }]);
      const result = engine.upsert([
        { id: 'a', value: 10 },
        { id: 'b', value: 2 },
      ]);

      expect(result.inserted).toBe(1);
      expect(result.updated).toBe(1);
      expect(engine.countRows()).toBe(2);
    });
  });

  describe('batchUpsert', () => {
    it('inserts records in a transaction (Req 5.1)', () => {
      engine = SQLiteEngine.open(tmpDir);
      engine.initSchema(relationalPolicy);

      const result = engine.batchUpsert([
        { id: 'x', data: 'one' },
        { id: 'y', data: 'two' },
        { id: 'z', data: 'three' },
      ]);

      expect(result.inserted).toBe(3);
      expect(result.updated).toBe(0);
      expect(result.errors).toBe(0);
      expect(engine.countRows()).toBe(3);
    });

    it('returns correct stats for mixed operations', () => {
      engine = SQLiteEngine.open(tmpDir);
      engine.initSchema(relationalPolicy);

      engine.upsert([{ id: 'x', data: 'old' }]);
      const result = engine.batchUpsert([
        { id: 'x', data: 'updated' },
        { id: 'y', data: 'new' },
      ]);

      expect(result.inserted).toBe(1);
      expect(result.updated).toBe(1);
      expect(result.errors).toBe(0);
    });
  });

  describe('ftsSearch (Req 7.1)', () => {
    it('returns matching documents with scores', () => {
      engine = SQLiteEngine.open(tmpDir);
      engine.initSchema(hybridPolicy);

      engine.upsert([
        { id: 'doc1', content: 'TypeScript is a typed superset of JavaScript' },
        { id: 'doc2', content: 'Python is a popular programming language' },
        { id: 'doc3', content: 'JavaScript runs in the browser' },
      ]);

      const results = engine.ftsSearch('JavaScript', 10);
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results.every((r) => r._engine === 'sqlite')).toBe(true);
      expect(results.every((r) => typeof r._score === 'number')).toBe(true);
    });

    it('respects limit parameter', () => {
      engine = SQLiteEngine.open(tmpDir);
      engine.initSchema(hybridPolicy);

      for (let i = 0; i < 20; i++) {
        engine.upsert([{ id: `doc${i}`, content: `document about testing number ${i}` }]);
      }

      const results = engine.ftsSearch('testing', 5);
      expect(results.length).toBeLessThanOrEqual(5);
    });

    it('supports multiple match fields', () => {
      engine = SQLiteEngine.open(tmpDir);
      engine.initSchema(multiMatchPolicy);

      engine.upsert([
        { id: 'doc1', title: 'TypeScript Guide', body: 'Learn TypeScript basics' },
        { id: 'doc2', title: 'Python Guide', body: 'Learn Python basics' },
      ]);

      const results = engine.ftsSearch('TypeScript', 10);
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0]!.data.title).toBe('TypeScript Guide');
    });
  });

  describe('whereSearch (Req 8.1, 8.4)', () => {
    it('filters records by JSON field conditions', () => {
      engine = SQLiteEngine.open(tmpDir);
      engine.initSchema(relationalPolicy);

      engine.upsert([
        { id: 'a', status: 'active', priority: 1 },
        { id: 'b', status: 'inactive', priority: 2 },
        { id: 'c', status: 'active', priority: 3 },
      ]);

      const results = engine.whereSearch("json_extract(data, '$.status') = 'active'", 10);
      expect(results).toHaveLength(2);
      expect(results.every((r) => r.data.status === 'active')).toBe(true);
      expect(results.every((r) => r._engine === 'sqlite')).toBe(true);
    });

    it('respects limit', () => {
      engine = SQLiteEngine.open(tmpDir);
      engine.initSchema(relationalPolicy);

      for (let i = 0; i < 10; i++) {
        engine.upsert([{ id: `r${i}`, tag: 'same' }]);
      }

      const results = engine.whereSearch("json_extract(data, '$.tag') = 'same'", 3);
      expect(results).toHaveLength(3);
    });

    it('throws on invalid SQL filter', () => {
      engine = SQLiteEngine.open(tmpDir);
      engine.initSchema(relationalPolicy);

      expect(() => engine.whereSearch('INVALID SQL ;;;', 10)).toThrow(XDBError);
    });
  });

  describe('ftsWhereSearch (Req 8.3)', () => {
    it('combines FTS and WHERE filtering', () => {
      engine = SQLiteEngine.open(tmpDir);
      engine.initSchema(hybridPolicy);

      engine.upsert([
        { id: 'doc1', content: 'TypeScript tutorial', category: 'programming' },
        { id: 'doc2', content: 'TypeScript advanced patterns', category: 'advanced' },
        { id: 'doc3', content: 'Python tutorial', category: 'programming' },
      ]);

      const results = engine.ftsWhereSearch(
        'TypeScript',
        "json_extract(r.data, '$.category') = 'programming'",
        10,
      );

      expect(results).toHaveLength(1);
      expect(results[0]!.data.id).toBe('doc1');
      expect(results[0]!._engine).toBe('sqlite');
      expect(typeof results[0]!._score).toBe('number');
    });
  });

  describe('countRows', () => {
    it('returns 0 for empty table', () => {
      engine = SQLiteEngine.open(tmpDir);
      engine.initSchema(relationalPolicy);
      expect(engine.countRows()).toBe(0);
    });

    it('returns correct count after inserts', () => {
      engine = SQLiteEngine.open(tmpDir);
      engine.initSchema(relationalPolicy);

      engine.upsert([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
      expect(engine.countRows()).toBe(3);
    });
  });

  describe('close', () => {
    it('closes the database without error', () => {
      engine = SQLiteEngine.open(tmpDir);
      engine.initSchema(relationalPolicy);
      engine.close();
      engine = undefined as unknown as SQLiteEngine;
    });
  });

  describe('SearchResult format (Req 10.2)', () => {
    it('returns results with correct _engine field', () => {
      engine = SQLiteEngine.open(tmpDir);
      engine.initSchema(hybridPolicy);

      engine.upsert([{ id: 'doc1', content: 'test data' }]);

      const ftsResults = engine.ftsSearch('test', 10);
      expect(ftsResults[0]!._engine).toBe('sqlite');

      const whereResults = engine.whereSearch("json_extract(data, '$.id') = 'doc1'", 10);
      expect(whereResults[0]!._engine).toBe('sqlite');
    });

    it('ftsSearch results have numeric _score', () => {
      engine = SQLiteEngine.open(tmpDir);
      engine.initSchema(hybridPolicy);

      engine.upsert([{ id: 'doc1', content: 'search term here' }]);
      const results = engine.ftsSearch('search', 10);
      expect(results).toHaveLength(1);
      expect(typeof results[0]!._score).toBe('number');
      expect(results[0]!._score).toBeGreaterThan(0);
    });

    it('whereSearch results have no _score', () => {
      engine = SQLiteEngine.open(tmpDir);
      engine.initSchema(relationalPolicy);

      engine.upsert([{ id: 'doc1', value: 42 }]);
      const results = engine.whereSearch("json_extract(data, '$.value') = 42", 10);
      expect(results).toHaveLength(1);
      expect(results[0]!._score).toBeUndefined();
    });
  });

  describe('data round-trip (Req 10.4)', () => {
    it('preserves all fields through write and read', () => {
      engine = SQLiteEngine.open(tmpDir);
      engine.initSchema(relationalPolicy);

      const original = {
        id: 'rt1',
        name: 'test',
        count: 42,
        nested: { a: 1, b: [2, 3] },
        tags: ['x', 'y'],
      };

      engine.upsert([original]);
      const results = engine.whereSearch("json_extract(data, '$.id') = 'rt1'", 1);
      expect(results).toHaveLength(1);
      expect(results[0]!.data).toEqual(original);
    });
  });
});
