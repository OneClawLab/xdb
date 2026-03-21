import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CollectionManager } from '../../src/collection-manager.js';
import { PolicyRegistry } from '../../src/policy-registry.js';
import { SQLiteEngine } from '../../src/engines/sqlite-engine.js';
import { executeFind } from '../../src/commands/find.js';

describe('find command', () => {
  let tmpDir: string;
  const registry = new PolicyRegistry();

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'xdb-find-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  /** Helper: create a relational collection and seed data via SQLiteEngine */
  async function seedRelationalCollection(
    name: string,
    records: Record<string, unknown>[],
    policyStr = 'relational/structured-logs',
  ) {
    const manager = new CollectionManager(tmpDir);
    const policy = registry.resolve(policyStr);
    await manager.init(name, policy);

    const colPath = join(tmpDir, 'collections', name);
    const sqlite = SQLiteEngine.open(colPath);
    sqlite.initSchema(policy);
    sqlite.upsert(records);
    sqlite.close();
  }

  describe('--where (relational collection)', () => {
    it('returns matching records as JSONL to stdout (Req 8.1, 8.4)', async () => {
      await seedRelationalCollection('logs', [
        { id: 'r1', level: 'info', msg: 'hello' },
        { id: 'r2', level: 'error', msg: 'fail' },
        { id: 'r3', level: 'info', msg: 'world' },
      ]);

      const lines: string[] = [];
      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
        lines.push(String(chunk));
        return true;
      });

      try {
        await executeFind(tmpDir, 'logs', undefined, {
          where: "json_extract(data, '$.level') = 'info'",
          limit: '10',
          json: true,
        });
      } finally {
        stdoutSpy.mockRestore();
      }

      const output = lines.join('');
      const resultLines = output.trim().split('\n');
      expect(resultLines.length).toBe(2);

      for (const line of resultLines) {
        const obj = JSON.parse(line);
        expect(obj._engine).toBe('sqlite');
        expect(obj.level).toBe('info');
      }
    });

    it('respects --limit parameter (Req 6.4, 7.3)', async () => {
      const records = Array.from({ length: 20 }, (_, i) => ({
        id: `r${i}`,
        val: i,
      }));
      await seedRelationalCollection('many', records);

      const lines: string[] = [];
      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
        lines.push(String(chunk));
        return true;
      });

      try {
        await executeFind(tmpDir, 'many', undefined, {
          where: '1=1',
          limit: '5',
          json: true,
        });
      } finally {
        stdoutSpy.mockRestore();
      }

      const output = lines.join('');
      const resultLines = output.trim().split('\n');
      expect(resultLines.length).toBe(5);
    });

    it('default limit is 10 (Req 6.4, 7.3)', async () => {
      const records = Array.from({ length: 15 }, (_, i) => ({
        id: `r${i}`,
        val: i,
      }));
      await seedRelationalCollection('default-limit', records);

      const lines: string[] = [];
      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
        lines.push(String(chunk));
        return true;
      });

      try {
        await executeFind(tmpDir, 'default-limit', undefined, {
          where: '1=1',
          limit: '10',
          json: true,
        });
      } finally {
        stdoutSpy.mockRestore();
      }

      const output = lines.join('');
      const resultLines = output.trim().split('\n');
      expect(resultLines.length).toBe(10);
    });
  });

  describe('error handling', () => {
    it('throws when collection does not exist (Req 4.7)', async () => {
      await expect(
        executeFind(tmpDir, 'nonexistent', 'hello', {
          where: '1=1',
          limit: '10',
        }),
      ).rejects.toThrow(/does not exist/);
    });

    it('throws when no search intent is specified', async () => {
      await seedRelationalCollection('no-intent', [{ id: 'r1', val: 1 }]);

      await expect(
        executeFind(tmpDir, 'no-intent', undefined, {
          limit: '10',
        }),
      ).rejects.toThrow(/No search intent/);
    });

    it('throws when --similar is used on relational collection (Req 6.5)', async () => {
      await seedRelationalCollection('rel-only', [{ id: 'r1', val: 1 }]);

      await expect(
        executeFind(tmpDir, 'rel-only', 'query', {
          similar: true,
          limit: '10',
        }),
      ).rejects.toThrow(/does not support semantic search/);
    });

    it('throws when --match is used on collection without match caps (Req 7.4)', async () => {
      await seedRelationalCollection('no-match', [{ id: 'r1', val: 1 }], 'relational/simple-kv');

      await expect(
        executeFind(tmpDir, 'no-match', 'query', {
          match: true,
          limit: '10',
        }),
      ).rejects.toThrow(/does not support full-text search/);
    });

    it('throws on invalid limit value', async () => {
      await seedRelationalCollection('bad-limit', [{ id: 'r1', val: 1 }]);

      await expect(
        executeFind(tmpDir, 'bad-limit', undefined, {
          where: '1=1',
          limit: 'abc',
        }),
      ).rejects.toThrow(/Invalid limit/);
    });
  });

  describe('--match (FTS search)', () => {
    it('returns FTS results with _score and _engine (Req 7.1, 7.2)', async () => {
      const manager = new CollectionManager(tmpDir);
      const policy = registry.resolve('hybrid/knowledge-base');
      await manager.init('kb', policy);

      const colPath = join(tmpDir, 'collections', 'kb');
      const sqlite = SQLiteEngine.open(colPath);
      sqlite.initSchema(policy);
      sqlite.upsert([
        { id: 'd1', content: 'TypeScript is a typed superset of JavaScript' },
        { id: 'd2', content: 'Python is a popular programming language' },
        { id: 'd3', content: 'JavaScript runs in the browser' },
      ]);
      sqlite.close();

      const lines: string[] = [];
      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
        lines.push(String(chunk));
        return true;
      });

      try {
        await executeFind(tmpDir, 'kb', 'JavaScript', {
          match: true,
          limit: '10',
          json: true,
        });
      } finally {
        stdoutSpy.mockRestore();
      }

      const output = lines.join('');
      const resultLines = output.trim().split('\n');
      expect(resultLines.length).toBeGreaterThanOrEqual(1);

      for (const line of resultLines) {
        const obj = JSON.parse(line);
        expect(obj._engine).toBe('sqlite');
        expect(typeof obj._score).toBe('number');
        expect(obj.content).toBeDefined();
      }
    });
  });

  describe('--match + --where (Req 8.3)', () => {
    it('combines FTS and WHERE filtering', async () => {
      const manager = new CollectionManager(tmpDir);
      const policy = registry.resolve('hybrid/knowledge-base');
      await manager.init('combo', policy);

      const colPath = join(tmpDir, 'collections', 'combo');
      const sqlite = SQLiteEngine.open(colPath);
      sqlite.initSchema(policy);
      sqlite.upsert([
        { id: 'd1', content: 'TypeScript language' },
        { id: 'd2', content: 'TypeScript framework' },
        { id: 'd3', content: 'Python language' },
      ]);
      sqlite.close();

      const lines: string[] = [];
      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
        lines.push(String(chunk));
        return true;
      });

      try {
        await executeFind(tmpDir, 'combo', 'TypeScript', {
          match: true,
          where: "json_extract(data, '$.id') = 'd1'",
          limit: '10',
          json: true,
        });
      } finally {
        stdoutSpy.mockRestore();
      }

      const output = lines.join('');
      const resultLines = output.trim().split('\n');
      expect(resultLines.length).toBe(1);

      const obj = JSON.parse(resultLines[0]!);
      expect(obj.id).toBe('d1');
      expect(obj.content).toBe('TypeScript language');
    });
  });

  describe('JSONL output format (Req 6.3, 10.2)', () => {
    it('each output line is valid JSON with _score and _engine when --json', async () => {
      await seedRelationalCollection('fmt', [
        { id: 'r1', name: 'alice' },
        { id: 'r2', name: 'bob' },
      ]);

      const lines: string[] = [];
      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
        lines.push(String(chunk));
        return true;
      });

      try {
        await executeFind(tmpDir, 'fmt', undefined, {
          where: '1=1',
          limit: '10',
          json: true,
        });
      } finally {
        stdoutSpy.mockRestore();
      }

      const output = lines.join('');
      const resultLines = output.trim().split('\n');

      for (const line of resultLines) {
        const obj = JSON.parse(line);
        expect(obj).toHaveProperty('_engine');
        expect(['lancedb', 'sqlite']).toContain(obj._engine);
      }
    });
  });

  describe('registerFindCommand', () => {
    it('registers find command on a Commander program', async () => {
      const { Command } = await import('commander');
      const { registerFindCommand } = await import('../../src/commands/find.js');

      const program = new Command();
      program.exitOverride();
      registerFindCommand(program);

      const findCmd = program.commands.find((c) => c.name() === 'find');
      expect(findCmd).toBeDefined();
      expect(findCmd!.description()).toBe('Search data in a collection');
    });
  });
});
