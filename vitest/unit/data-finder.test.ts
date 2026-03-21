import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DataFinder } from '../../src/data-finder.js';
import { SQLiteEngine } from '../../src/engines/sqlite-engine.js';
import type { LanceDBEngine } from '../../src/engines/lancedb-engine.js';
import type { Embedder } from '../../src/embedder.js';
import type { PolicyConfig } from '../../src/policy-registry.js';
import { XDBError } from '../../src/errors.js';

// --- Mock factories ---

function createMockEmbedder(): Embedder {
  return {
    embed: vi.fn().mockResolvedValue(Array(128).fill(0.1)),
    embedBatch: vi.fn().mockImplementation((texts: string[]) =>
      Promise.resolve(texts.map(() => Array(128).fill(0.1))),
    ),
  } as unknown as Embedder;
}

function createMockLanceEngine(data: Record<string, unknown>[] = []) {
  const store = new Map<string, Record<string, unknown>>();
  for (const r of data) {
    store.set(String(r.id), r);
  }

  return {
    vectorSearch: vi.fn().mockImplementation(async (_vec: number[], opts: { limit: number; filter?: string }) => {
      const results = Array.from(store.values()).slice(0, opts.limit);
      return results.map((r) => ({
        data: { ...r },
        _score: 0.95,
        _engine: 'lancedb' as const,
      }));
    }),
    filterSearch: vi.fn().mockImplementation(async (_filter: string, limit: number) => {
      const results = Array.from(store.values()).slice(0, limit);
      return results.map((r) => ({
        data: { ...r },
        _engine: 'lancedb' as const,
      }));
    }),
    upsert: vi.fn(),
    countRows: vi.fn().mockResolvedValue(store.size),
    close: vi.fn(),
  } as unknown as LanceDBEngine;
}

// --- Policies ---

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

const vectorPolicy: PolicyConfig = {
  main: 'vector',
  minor: 'feature-store',
  fields: { tensor: { findCaps: ['similar'] } },
  autoIndex: false,
};

const matchOnlyPolicy: PolicyConfig = {
  main: 'relational',
  minor: 'structured-logs',
  fields: { title: { findCaps: ['match'] } },
  autoIndex: true,
};

describe('DataFinder', () => {
  let tmpDir: string;
  let sqliteEngine: SQLiteEngine;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'xdb-df-test-'));
  });

  afterEach(async () => {
    if (sqliteEngine) {
      try { sqliteEngine.close(); } catch { /* ignore */ }
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe('no intent flags → error', () => {
    it('throws PARAMETER_ERROR when no --similar, --match, or --where', async () => {
      const embedder = createMockEmbedder();
      const finder = new DataFinder(relationalPolicy, embedder);

      await expect(finder.find('query', { limit: 10 })).rejects.toThrow(XDBError);
      await expect(finder.find('query', { limit: 10 })).rejects.toThrow(/No search intent/);
    });
  });

  describe('--similar (semantic search)', () => {
    it('calls embedder and lanceEngine.vectorSearch (Req 6.1)', async () => {
      const embedder = createMockEmbedder();
      const lanceEngine = createMockLanceEngine([{ id: 'r1', content: 'hello' }]);
      const finder = new DataFinder(hybridPolicy, embedder, lanceEngine);

      const results = await finder.find('search text', { similar: true, limit: 5 });

      expect(embedder.embed).toHaveBeenCalledWith('search text');
      expect(lanceEngine.vectorSearch).toHaveBeenCalledWith(
        Array(128).fill(0.1),
        { limit: 5, filter: undefined, column: 'content_vector' },
      );
      expect(results).toHaveLength(1);
      expect(results[0]!._engine).toBe('lancedb');
      expect(results[0]!._score).toBeDefined();
    });

    it('passes --where as pre-filter to vectorSearch (Req 8.2)', async () => {
      const embedder = createMockEmbedder();
      const lanceEngine = createMockLanceEngine([{ id: 'r1', content: 'hello' }]);
      const finder = new DataFinder(hybridPolicy, embedder, lanceEngine);

      await finder.find('query', { similar: true, where: "category = 'tech'", limit: 10 });

      expect(lanceEngine.vectorSearch).toHaveBeenCalledWith(
        expect.any(Array),
        { limit: 10, filter: "category = 'tech'", column: 'content_vector' },
      );
    });

    it('throws when collection has no similar capability (Req 6.5)', async () => {
      const embedder = createMockEmbedder();
      const finder = new DataFinder(relationalPolicy, embedder);

      await expect(
        finder.find('query', { similar: true, limit: 10 }),
      ).rejects.toThrow(/does not support semantic search/);
    });

    it('throws when query text is missing for --similar', async () => {
      const embedder = createMockEmbedder();
      const lanceEngine = createMockLanceEngine();
      const finder = new DataFinder(hybridPolicy, embedder, lanceEngine);

      await expect(
        finder.find(undefined, { similar: true, limit: 10 }),
      ).rejects.toThrow(/Query text is required/);
    });
  });

  describe('--match (full-text search)', () => {
    it('calls sqliteEngine.ftsSearch (Req 7.1)', async () => {
      sqliteEngine = SQLiteEngine.open(tmpDir);
      sqliteEngine.initSchema(hybridPolicy);
      // Insert test data
      sqliteEngine.upsert([
        { id: 'r1', content: 'hello world' },
        { id: 'r2', content: 'goodbye world' },
      ]);

      const embedder = createMockEmbedder();
      const finder = new DataFinder(hybridPolicy, embedder, undefined, sqliteEngine);

      const results = await finder.find('hello', { match: true, limit: 10 });

      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0]!._engine).toBe('sqlite');
      expect(results[0]!._score).toBeDefined();
    });

    it('uses ftsWhereSearch when --where is combined with --match (Req 8.3)', async () => {
      sqliteEngine = SQLiteEngine.open(tmpDir);
      sqliteEngine.initSchema(hybridPolicy);
      sqliteEngine.upsert([
        { id: 'r1', content: 'hello world' },
        { id: 'r2', content: 'hello universe' },
      ]);

      const embedder = createMockEmbedder();
      const finder = new DataFinder(hybridPolicy, embedder, undefined, sqliteEngine);

      const results = await finder.find('hello', {
        match: true,
        where: "json_extract(data, '$.id') = 'r1'",
        limit: 10,
      });

      expect(results.length).toBe(1);
      expect(results[0]!.data.id).toBe('r1');
    });

    it('throws when collection has no match capability (Req 7.4)', async () => {
      const embedder = createMockEmbedder();
      const lanceEngine = createMockLanceEngine();
      const finder = new DataFinder(vectorPolicy, embedder, lanceEngine);

      await expect(
        finder.find('query', { match: true, limit: 10 }),
      ).rejects.toThrow(/does not support full-text search/);
    });

    it('throws when query text is missing for --match', async () => {
      sqliteEngine = SQLiteEngine.open(tmpDir);
      sqliteEngine.initSchema(hybridPolicy);
      const embedder = createMockEmbedder();
      const finder = new DataFinder(hybridPolicy, embedder, undefined, sqliteEngine);

      await expect(
        finder.find(undefined, { match: true, limit: 10 }),
      ).rejects.toThrow(/Query text is required/);
    });
  });

  describe('--where only (structured filter)', () => {
    it('uses sqliteEngine.whereSearch when SQLite is available (Req 8.4)', async () => {
      sqliteEngine = SQLiteEngine.open(tmpDir);
      sqliteEngine.initSchema(relationalPolicy);
      sqliteEngine.upsert([
        { id: 'r1', status: 'active' },
        { id: 'r2', status: 'inactive' },
      ]);

      const embedder = createMockEmbedder();
      const finder = new DataFinder(relationalPolicy, embedder, undefined, sqliteEngine);

      const results = await finder.find(undefined, {
        where: "json_extract(data, '$.status') = 'active'",
        limit: 10,
      });

      expect(results).toHaveLength(1);
      expect(results[0]!.data.status).toBe('active');
      expect(results[0]!._engine).toBe('sqlite');
    });

    it('falls back to lanceEngine.filterSearch when only LanceDB available (Req 8.6)', async () => {
      const embedder = createMockEmbedder();
      const lanceEngine = createMockLanceEngine([{ id: 'r1', category: 'tech' }]);
      const finder = new DataFinder(vectorPolicy, embedder, lanceEngine);

      const results = await finder.find(undefined, {
        where: "category = 'tech'",
        limit: 10,
      });

      expect(lanceEngine.filterSearch).toHaveBeenCalledWith("category = 'tech'", 10);
      expect(results).toHaveLength(1);
      expect(results[0]!._engine).toBe('lancedb');
    });

    it('throws when no engine is available', async () => {
      const embedder = createMockEmbedder();
      const finder = new DataFinder(relationalPolicy, embedder);

      await expect(
        finder.find(undefined, { where: '1=1', limit: 10 }),
      ).rejects.toThrow(/No search engine available/);
    });
  });

  describe('default limit', () => {
    it('uses limit from options (Req 6.4, 7.3)', async () => {
      const embedder = createMockEmbedder();
      const lanceEngine = createMockLanceEngine([
        { id: 'r1', content: 'a' },
        { id: 'r2', content: 'b' },
      ]);
      const finder = new DataFinder(hybridPolicy, embedder, lanceEngine);

      await finder.find('query', { similar: true, limit: 3 });

      expect(lanceEngine.vectorSearch).toHaveBeenCalledWith(
        expect.any(Array),
        { limit: 3, filter: undefined, column: 'content_vector' },
      );
    });
  });

  describe('result format (Req 6.3, 7.2, 10.2)', () => {
    it('returns results with _engine field from vector search', async () => {
      const embedder = createMockEmbedder();
      const lanceEngine = createMockLanceEngine([{ id: 'r1', content: 'test' }]);
      const finder = new DataFinder(hybridPolicy, embedder, lanceEngine);

      const results = await finder.find('query', { similar: true, limit: 10 });

      for (const r of results) {
        expect(r._engine).toBe('lancedb');
        expect(r.data).toBeDefined();
      }
    });

    it('returns results with _engine and _score from FTS search', async () => {
      sqliteEngine = SQLiteEngine.open(tmpDir);
      sqliteEngine.initSchema(hybridPolicy);
      sqliteEngine.upsert([{ id: 'r1', content: 'test data' }]);

      const embedder = createMockEmbedder();
      const finder = new DataFinder(hybridPolicy, embedder, undefined, sqliteEngine);

      const results = await finder.find('test', { match: true, limit: 10 });

      expect(results).toHaveLength(1);
      expect(results[0]!._engine).toBe('sqlite');
      expect(typeof results[0]!._score).toBe('number');
      expect(results[0]!.data).toBeDefined();
    });

    it('returns results with _engine from where search', async () => {
      sqliteEngine = SQLiteEngine.open(tmpDir);
      sqliteEngine.initSchema(relationalPolicy);
      sqliteEngine.upsert([{ id: 'r1', value: 42 }]);

      const embedder = createMockEmbedder();
      const finder = new DataFinder(relationalPolicy, embedder, undefined, sqliteEngine);

      const results = await finder.find(undefined, { where: '1=1', limit: 10 });

      expect(results).toHaveLength(1);
      expect(results[0]!._engine).toBe('sqlite');
    });
  });

  describe('capability checks with various policies', () => {
    it('relational policy rejects --similar (Req 6.5)', async () => {
      sqliteEngine = SQLiteEngine.open(tmpDir);
      sqliteEngine.initSchema(relationalPolicy);
      const embedder = createMockEmbedder();
      const finder = new DataFinder(relationalPolicy, embedder, undefined, sqliteEngine);

      await expect(
        finder.find('query', { similar: true, limit: 10 }),
      ).rejects.toThrow(/does not support semantic search/);
    });

    it('vector policy rejects --match (Req 7.4)', async () => {
      const embedder = createMockEmbedder();
      const lanceEngine = createMockLanceEngine();
      const finder = new DataFinder(vectorPolicy, embedder, lanceEngine);

      await expect(
        finder.find('query', { match: true, limit: 10 }),
      ).rejects.toThrow(/does not support full-text search/);
    });

    it('relational/simple-kv rejects --match (no match fields)', async () => {
      const simpleKvPolicy: PolicyConfig = {
        main: 'relational',
        minor: 'simple-kv',
        fields: {},
        autoIndex: false,
      };
      const embedder = createMockEmbedder();
      const finder = new DataFinder(simpleKvPolicy, embedder);

      await expect(
        finder.find('query', { match: true, limit: 10 }),
      ).rejects.toThrow(/does not support full-text search/);
    });

    it('hybrid policy supports both --similar and --match', async () => {
      sqliteEngine = SQLiteEngine.open(tmpDir);
      sqliteEngine.initSchema(hybridPolicy);
      sqliteEngine.upsert([{ id: 'r1', content: 'hello world' }]);

      const embedder = createMockEmbedder();
      const lanceEngine = createMockLanceEngine([{ id: 'r1', content: 'hello world' }]);
      const finder = new DataFinder(hybridPolicy, embedder, lanceEngine, sqliteEngine);

      // --similar should work
      const similarResults = await finder.find('hello', { similar: true, limit: 10 });
      expect(similarResults.length).toBeGreaterThanOrEqual(1);

      // --match should work
      const matchResults = await finder.find('hello', { match: true, limit: 10 });
      expect(matchResults.length).toBeGreaterThanOrEqual(1);
    });
  });
});
