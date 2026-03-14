import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CollectionManager } from './collection-manager.js';
import { XDBError, PARAMETER_ERROR } from './errors.js';
import type { PolicyConfig } from './policy-registry.js';

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

describe('CollectionManager', () => {
  let tmpDir: string;
  let manager: CollectionManager;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'xdb-test-'));
    manager = new CollectionManager(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe('init', () => {
    it('creates collection directory and writes collection_meta.json', async () => {
      await manager.init('test-col', hybridPolicy);

      const metaPath = join(tmpDir, 'collections', 'test-col', 'collection_meta.json');
      const raw = await readFile(metaPath, 'utf-8');
      const meta = JSON.parse(raw);

      expect(meta.name).toBe('test-col');
      expect(meta.policy.main).toBe('hybrid');
      expect(meta.policy.minor).toBe('knowledge-base');
      expect(meta.policy.fields.content.findCaps).toEqual(['similar', 'match']);
      expect(meta.createdAt).toBeTruthy();
      // Verify createdAt is a valid ISO date
      expect(new Date(meta.createdAt).toISOString()).toBe(meta.createdAt);
    });

    it('auto-creates dataRoot on first operation (Req 11.3)', async () => {
      const deepRoot = join(tmpDir, 'nested', 'deep', 'root');
      const mgr = new CollectionManager(deepRoot);
      await mgr.init('col1', hybridPolicy);

      const s = await stat(join(deepRoot, 'collections', 'col1'));
      expect(s.isDirectory()).toBe(true);
    });

    it('throws PARAMETER_ERROR if collection already exists (Req 1.5)', async () => {
      await manager.init('dup', hybridPolicy);

      try {
        await manager.init('dup', hybridPolicy);
        expect.fail('Should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(XDBError);
        expect((e as XDBError).exitCode).toBe(PARAMETER_ERROR);
        expect((e as XDBError).message).toContain('already exists');
      }
    });
  });

  describe('exists', () => {
    it('returns false for non-existent collection', async () => {
      expect(await manager.exists('nope')).toBe(false);
    });

    it('returns true after init', async () => {
      await manager.init('my-col', hybridPolicy);
      expect(await manager.exists('my-col')).toBe(true);
    });
  });

  describe('load', () => {
    it('reads and parses collection_meta.json', async () => {
      await manager.init('loadme', relationalPolicy);
      const meta = await manager.load('loadme');

      expect(meta.name).toBe('loadme');
      expect(meta.policy.main).toBe('relational');
      expect(meta.policy.minor).toBe('structured-logs');
      expect(meta.createdAt).toBeTruthy();
    });

    it('throws PARAMETER_ERROR if collection does not exist (Req 3.2)', async () => {
      try {
        await manager.load('ghost');
        expect.fail('Should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(XDBError);
        expect((e as XDBError).exitCode).toBe(PARAMETER_ERROR);
        expect((e as XDBError).message).toContain('does not exist');
      }
    });
  });

  describe('remove', () => {
    it('deletes collection directory completely', async () => {
      await manager.init('removeme', hybridPolicy);
      expect(await manager.exists('removeme')).toBe(true);

      await manager.remove('removeme');
      expect(await manager.exists('removeme')).toBe(false);
    });

    it('throws PARAMETER_ERROR if collection does not exist (Req 3.2)', async () => {
      try {
        await manager.remove('ghost');
        expect.fail('Should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(XDBError);
        expect((e as XDBError).exitCode).toBe(PARAMETER_ERROR);
        expect((e as XDBError).message).toContain('does not exist');
      }
    });
  });

  describe('list', () => {
    it('returns empty array when no collections exist (Req 2.2)', async () => {
      const result = await manager.list();
      expect(result).toEqual([]);
    });

    it('returns all created collections with correct info (Req 2.1)', async () => {
      await manager.init('col-a', hybridPolicy);
      await manager.init('col-b', relationalPolicy);

      const result = await manager.list();
      expect(result).toHaveLength(2);

      const names = result.map((c) => c.name).sort();
      expect(names).toEqual(['col-a', 'col-b']);

      const colA = result.find((c) => c.name === 'col-a')!;
      expect(colA.policy).toBe('hybrid/knowledge-base');
      expect(colA.recordCount).toBe(0);
      expect(colA.sizeBytes).toBeGreaterThan(0); // meta file has size

      const colB = result.find((c) => c.name === 'col-b')!;
      expect(colB.policy).toBe('relational/structured-logs');
    });

    it('auto-creates dataRoot if it does not exist', async () => {
      const freshRoot = join(tmpDir, 'fresh');
      const mgr = new CollectionManager(freshRoot);
      const result = await mgr.list();
      expect(result).toEqual([]);
      // Verify directory was created
      const s = await stat(join(freshRoot, 'collections'));
      expect(s.isDirectory()).toBe(true);
    });

    it('skips directories without valid collection_meta.json', async () => {
      await manager.init('valid', hybridPolicy);
      // Create a rogue directory without meta
      await mkdir(join(tmpDir, 'collections', 'invalid'), { recursive: true });

      const result = await manager.list();
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('valid');
    });
  });

  describe('sizeBytes calculation', () => {
    it('includes nested file sizes', async () => {
      await manager.init('sized', hybridPolicy);
      // Write an extra file to increase size
      const extraPath = join(tmpDir, 'collections', 'sized', 'extra.dat');
      await writeFile(extraPath, 'x'.repeat(1024));

      const result = await manager.list();
      const col = result.find((c) => c.name === 'sized')!;
      expect(col.sizeBytes).toBeGreaterThanOrEqual(1024);
    });
  });
});
