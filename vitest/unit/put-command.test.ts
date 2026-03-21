import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CollectionManager } from '../../src/collection-manager.js';
import { PolicyRegistry } from '../../src/policy-registry.js';
import { SQLiteEngine } from '../../src/engines/sqlite-engine.js';
import { executePut } from '../../src/commands/put.js';

describe('put command', () => {
  let tmpDir: string;
  const registry = new PolicyRegistry();

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'xdb-put-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  /** Helper: create a relational collection (no embedder needed) */
  async function createRelationalCollection(name: string): Promise<void> {
    const manager = new CollectionManager(tmpDir);
    const policy = registry.resolve('relational/structured-logs');
    await manager.init(name, policy);
  }

  /** Helper: open SQLite engine for a collection to verify data */
  function openSqlite(name: string): SQLiteEngine {
    const colPath = join(tmpDir, 'collections', name);
    const engine = SQLiteEngine.open(colPath);
    const policy = registry.resolve('relational/structured-logs');
    engine.initSchema(policy);
    return engine;
  }

  describe('single JSON positional argument (Req 4.1)', () => {
    it('writes a single JSON record to the collection', async () => {
      await createRelationalCollection('test-col');

      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      try {
        await executePut(tmpDir, 'test-col', '{"id":"r1","msg":"hello"}', false);
      } finally {
        stdoutSpy.mockRestore();
      }

      const engine = openSqlite('test-col');
      try {
        expect(engine.countRows()).toBe(1);
        const results = engine.whereSearch("json_extract(data, '$.id') = 'r1'", 10);
        expect(results).toHaveLength(1);
        expect(results[0]!.data.msg).toBe('hello');
      } finally {
        engine.close();
      }
    });

    it('auto-generates UUID when id is missing (Req 4.4)', async () => {
      await createRelationalCollection('auto-id');

      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      try {
        await executePut(tmpDir, 'auto-id', '{"msg":"no-id"}', false);
      } finally {
        stdoutSpy.mockRestore();
      }

      const engine = openSqlite('auto-id');
      try {
        expect(engine.countRows()).toBe(1);
        const results = engine.whereSearch('1=1', 10);
        expect(results).toHaveLength(1);
        expect(results[0]!.data.id).toBeDefined();
        expect(results[0]!.data.id).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        );
      } finally {
        engine.close();
      }
    });
  });

  describe('invalid JSON (Req 4.6)', () => {
    it('throws PARAMETER_ERROR for invalid JSON positional arg', async () => {
      await createRelationalCollection('bad-json');

      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: number | string | null) => {
        throw new Error(`process.exit(${code})`);
      });

      try {
        await executePut(tmpDir, 'bad-json', '{not valid json}', false);
        expect.fail('Should have thrown');
      } catch (e) {
        expect((e as Error).message).toContain('Invalid JSON');
      } finally {
        stderrSpy.mockRestore();
        exitSpy.mockRestore();
      }
    });

    it('throws PARAMETER_ERROR for non-object JSON (array)', async () => {
      await createRelationalCollection('arr-json');

      try {
        await executePut(tmpDir, 'arr-json', '[1,2,3]', false);
        expect.fail('Should have thrown');
      } catch (e) {
        expect((e as Error).message).toContain('expected a JSON object');
      }
    });
  });

  describe('collection not found (Req 4.7)', () => {
    it('throws PARAMETER_ERROR when collection does not exist', async () => {
      try {
        await executePut(tmpDir, 'nonexistent', '{"id":"1"}', false);
        expect.fail('Should have thrown');
      } catch (e) {
        expect((e as Error).message).toContain('does not exist');
      }
    });
  });

  describe('batch mode (Req 5.1, 5.2)', () => {
    it('writes multiple records in batch mode and outputs stats', async () => {
      await createRelationalCollection('batch-col');

      const captured = { stdout: '' };
      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
        captured.stdout += String(chunk);
        return true;
      });

      try {
        await executePut(tmpDir, 'batch-col', '{"id":"b1","msg":"batch1"}', true, true);
      } finally {
        stdoutSpy.mockRestore();
      }

      const stats = JSON.parse(captured.stdout.trim());
      expect(stats).toHaveProperty('inserted');
      expect(stats).toHaveProperty('updated');
      expect(stats).toHaveProperty('errors');
      expect(stats.inserted).toBe(1);
      expect(stats.errors).toBe(0);

      const engine = openSqlite('batch-col');
      try {
        expect(engine.countRows()).toBe(1);
      } finally {
        engine.close();
      }
    });
  });

  describe('upsert semantics (Req 4.3)', () => {
    it('updates existing record when same id is written again', async () => {
      await createRelationalCollection('upsert-col');

      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      try {
        await executePut(tmpDir, 'upsert-col', '{"id":"u1","msg":"first"}', false);
        await executePut(tmpDir, 'upsert-col', '{"id":"u1","msg":"second"}', false);
      } finally {
        stdoutSpy.mockRestore();
      }

      const engine = openSqlite('upsert-col');
      try {
        expect(engine.countRows()).toBe(1);
        const results = engine.whereSearch("json_extract(data, '$.id') = 'u1'", 10);
        expect(results).toHaveLength(1);
        expect(results[0]!.data.msg).toBe('second');
      } finally {
        engine.close();
      }
    });
  });

  describe('multiple records without batch', () => {
    it('writes each record individually when given positional JSON', async () => {
      await createRelationalCollection('multi-col');

      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      try {
        await executePut(tmpDir, 'multi-col', '{"id":"m1","msg":"one"}', false);
        await executePut(tmpDir, 'multi-col', '{"id":"m2","msg":"two"}', false);
      } finally {
        stdoutSpy.mockRestore();
      }

      const engine = openSqlite('multi-col');
      try {
        expect(engine.countRows()).toBe(2);
      } finally {
        engine.close();
      }
    });
  });

  describe('batch mode stats output (Req 5.2)', () => {
    it('outputs JSON stats with inserted, updated, errors fields', async () => {
      await createRelationalCollection('stats-col');

      const captured = { stdout: '' };
      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
        captured.stdout += String(chunk);
        return true;
      });

      try {
        await executePut(tmpDir, 'stats-col', '{"id":"s1","msg":"first"}', true, true);
      } finally {
        stdoutSpy.mockRestore();
      }

      const stats = JSON.parse(captured.stdout.trim());
      expect(typeof stats.inserted).toBe('number');
      expect(typeof stats.updated).toBe('number');
      expect(typeof stats.errors).toBe('number');
    });
  });
});
