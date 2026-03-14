import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DataWriter } from './data-writer.js';
import { SQLiteEngine } from './engines/sqlite-engine.js';
import type { LanceDBEngine } from './engines/lancedb-engine.js';
import type { Embedder } from './embedder.js';
import type { PolicyConfig } from './policy-registry.js';
import { XDBError } from './errors.js';

// UUID v4 regex
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// --- Mock factories ---

function createMockEmbedder(): Embedder {
  return {
    embed: vi.fn().mockResolvedValue(Array(128).fill(0.1)),
    embedBatch: vi.fn().mockImplementation((texts: string[]) =>
      Promise.resolve(texts.map(() => Array(128).fill(0.1))),
    ),
  } as unknown as Embedder;
}

function createMockLanceEngine() {
  let store: Map<string, Record<string, unknown>> = new Map();
  return {
    upsert: vi.fn().mockImplementation(async (records: Record<string, unknown>[]) => {
      let inserted = 0;
      let updated = 0;
      for (const r of records) {
        if (store.has(String(r.id))) {
          updated++;
        } else {
          inserted++;
        }
        store.set(String(r.id), r);
      }
      return { inserted, updated };
    }),
    countRows: vi.fn().mockImplementation(async () => store.size),
    close: vi.fn(),
    _store: store,
    _getStore: () => store,
  } as unknown as LanceDBEngine & { _store: Map<string, Record<string, unknown>>; _getStore: () => Map<string, Record<string, unknown>> };
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

describe('DataWriter', () => {
  let tmpDir: string;
  let sqliteEngine: SQLiteEngine;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'xdb-dw-test-'));
  });

  afterEach(async () => {
    if (sqliteEngine) {
      try { sqliteEngine.close(); } catch { /* ignore */ }
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe('write() - single record', () => {
    it('auto-generates UUID when record has no id (Req 4.4)', async () => {
      sqliteEngine = SQLiteEngine.open(tmpDir);
      sqliteEngine.initSchema(relationalPolicy);
      const embedder = createMockEmbedder();
      const writer = new DataWriter(relationalPolicy, embedder, undefined, sqliteEngine);

      await writer.write({ name: 'test' });

      expect(sqliteEngine.countRows()).toBe(1);
      const rows = sqliteEngine.whereSearch('1=1', 10);
      expect(rows).toHaveLength(1);
      expect(rows[0].data.id).toBeDefined();
      expect(String(rows[0].data.id)).toMatch(UUID_V4_RE);
    });

    it('preserves existing id (Req 4.3)', async () => {
      sqliteEngine = SQLiteEngine.open(tmpDir);
      sqliteEngine.initSchema(relationalPolicy);
      const embedder = createMockEmbedder();
      const writer = new DataWriter(relationalPolicy, embedder, undefined, sqliteEngine);

      await writer.write({ id: 'my-id', name: 'test' });

      const rows = sqliteEngine.whereSearch("json_extract(data, '$.id') = 'my-id'", 10);
      expect(rows).toHaveLength(1);
      expect(rows[0].data.id).toBe('my-id');
    });

    it('performs upsert - updates existing record (Req 4.3)', async () => {
      sqliteEngine = SQLiteEngine.open(tmpDir);
      sqliteEngine.initSchema(relationalPolicy);
      const embedder = createMockEmbedder();
      const writer = new DataWriter(relationalPolicy, embedder, undefined, sqliteEngine);

      const r1 = await writer.write({ id: 'u1', value: 'old' });
      expect(r1.inserted).toBe(1);
      expect(r1.updated).toBe(0);

      const r2 = await writer.write({ id: 'u1', value: 'new' });
      expect(r2.inserted).toBe(0);
      expect(r2.updated).toBe(1);

      expect(sqliteEngine.countRows()).toBe(1);
      const rows = sqliteEngine.whereSearch("json_extract(data, '$.id') = 'u1'", 10);
      expect(rows[0].data.value).toBe('new');
    });

    it('throws on invalid input (Req 4.6)', async () => {
      const embedder = createMockEmbedder();
      const writer = new DataWriter(relationalPolicy, embedder);

      await expect(writer.write(null as any)).rejects.toThrow(XDBError);
      await expect(writer.write(undefined as any)).rejects.toThrow(XDBError);
      await expect(writer.write([] as any)).rejects.toThrow(XDBError);
      await expect(writer.write('string' as any)).rejects.toThrow(XDBError);
      await expect(writer.write(42 as any)).rejects.toThrow(XDBError);
    });

    it('writes to SQLite for relational policy', async () => {
      sqliteEngine = SQLiteEngine.open(tmpDir);
      sqliteEngine.initSchema(relationalPolicy);
      const embedder = createMockEmbedder();
      const writer = new DataWriter(relationalPolicy, embedder, undefined, sqliteEngine);

      const result = await writer.write({ id: 'r1', key: 'val' });

      expect(result.inserted).toBe(1);
      expect(sqliteEngine.countRows()).toBe(1);
      // Embedder should NOT be called for relational policy
      expect(embedder.embed).not.toHaveBeenCalled();
    });

    it('writes to LanceDB for vector policy with embedding', async () => {
      const embedder = createMockEmbedder();
      const lanceEngine = createMockLanceEngine();
      const writer = new DataWriter(vectorPolicy, embedder, lanceEngine);

      const result = await writer.write({ id: 'v1', tensor: 'some data' });

      expect(result.inserted).toBe(1);
      expect(embedder.embed).toHaveBeenCalledWith('some data');
      expect(lanceEngine.upsert).toHaveBeenCalledTimes(1);
      // Verify vector field was added
      const call = (lanceEngine.upsert as any).mock.calls[0][0][0];
      expect(call.tensor_vector).toBeInstanceOf(Float32Array);
    });

    it('writes to both engines for hybrid policy (Req 4.5)', async () => {
      sqliteEngine = SQLiteEngine.open(tmpDir);
      sqliteEngine.initSchema(hybridPolicy);
      const embedder = createMockEmbedder();
      const lanceEngine = createMockLanceEngine();
      const writer = new DataWriter(hybridPolicy, embedder, lanceEngine, sqliteEngine);

      const result = await writer.write({ id: 'h1', content: 'hello world' });

      expect(result.inserted).toBe(1);
      expect(embedder.embed).toHaveBeenCalledWith('hello world');
      expect(lanceEngine.upsert).toHaveBeenCalledTimes(1);
      expect(sqliteEngine.countRows()).toBe(1);
    });
  });

  describe('writeBatch() - batch write', () => {
    it('writes multiple records with transaction optimization (Req 5.1)', async () => {
      sqliteEngine = SQLiteEngine.open(tmpDir);
      sqliteEngine.initSchema(relationalPolicy);
      const embedder = createMockEmbedder();
      const writer = new DataWriter(relationalPolicy, embedder, undefined, sqliteEngine);

      const records = [
        { id: 'b1', value: 1 },
        { id: 'b2', value: 2 },
        { id: 'b3', value: 3 },
      ];

      const result = await writer.writeBatch(records);

      expect(result.inserted).toBe(3);
      expect(result.updated).toBe(0);
      expect(result.errors).toBe(0);
      expect(sqliteEngine.countRows()).toBe(3);
    });

    it('auto-generates UUIDs for records without id', async () => {
      sqliteEngine = SQLiteEngine.open(tmpDir);
      sqliteEngine.initSchema(relationalPolicy);
      const embedder = createMockEmbedder();
      const writer = new DataWriter(relationalPolicy, embedder, undefined, sqliteEngine);

      const result = await writer.writeBatch([
        { name: 'a' },
        { name: 'b' },
      ]);

      expect(result.inserted).toBe(2);
      const rows = sqliteEngine.whereSearch('1=1', 10);
      expect(rows).toHaveLength(2);
      const ids = rows.map((r) => String(r.data.id));
      expect(ids[0]).toMatch(UUID_V4_RE);
      expect(ids[1]).toMatch(UUID_V4_RE);
      expect(ids[0]).not.toBe(ids[1]); // unique
    });

    it('skips invalid records and continues (Req 5.3)', async () => {
      sqliteEngine = SQLiteEngine.open(tmpDir);
      sqliteEngine.initSchema(relationalPolicy);
      const embedder = createMockEmbedder();
      const writer = new DataWriter(relationalPolicy, embedder, undefined, sqliteEngine);

      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

      const records = [
        { id: 'ok1', value: 1 },
        null as any,           // invalid
        { id: 'ok2', value: 2 },
        'not-an-object' as any, // invalid
        { id: 'ok3', value: 3 },
      ];

      const result = await writer.writeBatch(records);

      expect(result.inserted).toBe(3);
      expect(result.errors).toBe(2);
      expect(result.inserted + result.updated + result.errors).toBe(5);
      expect(sqliteEngine.countRows()).toBe(3);

      // Verify warnings were written to stderr
      expect(stderrSpy).toHaveBeenCalled();
      stderrSpy.mockRestore();
    });

    it('stats invariant: inserted + updated + errors = total (Req 5.2)', async () => {
      sqliteEngine = SQLiteEngine.open(tmpDir);
      sqliteEngine.initSchema(relationalPolicy);
      const embedder = createMockEmbedder();
      const writer = new DataWriter(relationalPolicy, embedder, undefined, sqliteEngine);

      // Pre-insert a record for update
      await writer.write({ id: 'existing', value: 'old' });

      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

      const records = [
        { id: 'existing', value: 'updated' }, // update
        { id: 'new1', value: 1 },             // insert
        42 as any,                              // error
        { id: 'new2', value: 2 },             // insert
      ];

      const result = await writer.writeBatch(records);

      expect(result.inserted + result.updated + result.errors).toBe(4);
      expect(result.updated).toBe(1);
      expect(result.inserted).toBe(2);
      expect(result.errors).toBe(1);

      stderrSpy.mockRestore();
    });

    it('uses embedBatch for vector policy in batch mode', async () => {
      const embedder = createMockEmbedder();
      const lanceEngine = createMockLanceEngine();
      const writer = new DataWriter(vectorPolicy, embedder, lanceEngine);

      await writer.writeBatch([
        { id: 'v1', tensor: 'text1' },
        { id: 'v2', tensor: 'text2' },
      ]);

      // Should use embedBatch, not individual embed calls
      expect(embedder.embedBatch).toHaveBeenCalledWith(['text1', 'text2']);
      expect(embedder.embed).not.toHaveBeenCalled();
      expect(lanceEngine.upsert).toHaveBeenCalledTimes(1);
    });

    it('writes to both engines in hybrid batch mode', async () => {
      sqliteEngine = SQLiteEngine.open(tmpDir);
      sqliteEngine.initSchema(hybridPolicy);
      const embedder = createMockEmbedder();
      const lanceEngine = createMockLanceEngine();
      const writer = new DataWriter(hybridPolicy, embedder, lanceEngine, sqliteEngine);

      const result = await writer.writeBatch([
        { id: 'h1', content: 'hello' },
        { id: 'h2', content: 'world' },
      ]);

      expect(result.inserted).toBe(2);
      expect(lanceEngine.upsert).toHaveBeenCalledTimes(1);
      expect(sqliteEngine.countRows()).toBe(2);
      expect(embedder.embedBatch).toHaveBeenCalledWith(['hello', 'world']);
    });

    it('handles empty batch', async () => {
      const embedder = createMockEmbedder();
      const writer = new DataWriter(relationalPolicy, embedder);

      const result = await writer.writeBatch([]);

      expect(result.inserted).toBe(0);
      expect(result.updated).toBe(0);
      expect(result.errors).toBe(0);
    });

    it('handles batch where all records are invalid', async () => {
      const embedder = createMockEmbedder();
      const writer = new DataWriter(relationalPolicy, embedder);

      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

      const result = await writer.writeBatch([null as any, 'bad' as any, 123 as any]);

      expect(result.errors).toBe(3);
      expect(result.inserted).toBe(0);
      expect(result.updated).toBe(0);

      stderrSpy.mockRestore();
    });
  });

  describe('write routing logic', () => {
    it('does not call embedder for relational-only policy', async () => {
      sqliteEngine = SQLiteEngine.open(tmpDir);
      sqliteEngine.initSchema(relationalPolicy);
      const embedder = createMockEmbedder();
      const writer = new DataWriter(relationalPolicy, embedder, undefined, sqliteEngine);

      await writer.write({ id: 'r1', data: 'test' });

      expect(embedder.embed).not.toHaveBeenCalled();
      expect(embedder.embedBatch).not.toHaveBeenCalled();
    });

    it('calls embedder for fields with similar findCaps', async () => {
      const embedder = createMockEmbedder();
      const lanceEngine = createMockLanceEngine();
      const writer = new DataWriter(vectorPolicy, embedder, lanceEngine);

      await writer.write({ id: 'v1', tensor: 'embed me' });

      expect(embedder.embed).toHaveBeenCalledWith('embed me');
    });

    it('handles missing similar field value gracefully', async () => {
      const embedder = createMockEmbedder();
      const lanceEngine = createMockLanceEngine();
      const writer = new DataWriter(vectorPolicy, embedder, lanceEngine);

      // Record doesn't have the 'tensor' field — should embed empty string
      await writer.write({ id: 'v1' });

      expect(embedder.embed).toHaveBeenCalledWith('');
    });
  });
});
