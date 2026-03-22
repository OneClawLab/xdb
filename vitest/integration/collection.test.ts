import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CollectionManager } from '../../src/collection-manager.js';
import { DataWriter } from '../../src/data-writer.js';
import { DataFinder } from '../../src/data-finder.js';
import { SQLiteEngine } from '../../src/engines/sqlite-engine.js';
import { XDBError, PARAMETER_ERROR } from '../../src/errors.js';
import type { PolicyConfig } from '../../src/policy-registry.js';

// UUID v4 regex
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Mock embedder — returns fixed-dimension random vectors, no real LLM calls
const mockEmbedder = {
  embed: async (_text: string) => new Array(384).fill(0).map(() => Math.random()),
  embedBatch: async (texts: string[]) => texts.map(() => new Array(384).fill(0).map(() => Math.random())),
};

// Relational policy with FTS support for --match queries
const relationalMatchPolicy: PolicyConfig = {
  main: 'relational',
  minor: 'structured-logs',
  fields: { content: { findCaps: ['match'] } },
  autoIndex: true,
};

// Simple relational policy (no FTS)
const relationalPolicy: PolicyConfig = {
  main: 'relational',
  minor: 'structured-logs',
  fields: {},
  autoIndex: true,
};

describe('xdb collection integration tests', () => {
  let tmpDir: string;
  let manager: CollectionManager;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'xdb-integration-'));
    manager = new CollectionManager(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // Req 3.1: CollectionManager.init creates directory and collection_meta.json
  it('init creates collection directory and collection_meta.json (Req 3.1)', async () => {
    await manager.init('my-col', relationalPolicy);

    const colDir = join(tmpDir, 'collections', 'my-col');
    const metaPath = join(colDir, 'collection_meta.json');

    const dirStat = await stat(colDir);
    expect(dirStat.isDirectory()).toBe(true);

    const raw = await readFile(metaPath, 'utf-8');
    const meta = JSON.parse(raw);
    expect(meta.name).toBe('my-col');
    expect(meta.policy.main).toBe('relational');
    expect(meta.createdAt).toBeTruthy();
    expect(new Date(meta.createdAt).toISOString()).toBe(meta.createdAt);
  });

  // Req 3.2: Duplicate init on same collection name throws PARAMETER_ERROR
  it('duplicate init throws PARAMETER_ERROR (Req 3.2)', async () => {
    await manager.init('dup-col', relationalPolicy);

    await expect(manager.init('dup-col', relationalPolicy)).rejects.toSatisfy((e: unknown) => {
      return e instanceof XDBError && e.exitCode === PARAMETER_ERROR && e.message.includes('already exists');
    });
  });

  // Req 3.3: DataWriter.write persists record to SQLite
  it('DataWriter.write persists record to SQLite (Req 3.3)', async () => {
    await manager.init('write-col', relationalPolicy);

    const colPath = join(tmpDir, 'collections', 'write-col');
    const engine = SQLiteEngine.open(colPath);
    engine.initSchema(relationalPolicy);

    const writer = new DataWriter(relationalPolicy, mockEmbedder, undefined, engine);
    const result = await writer.write({ id: 'rec-1', name: 'Alice', age: 30 });

    expect(result.inserted).toBe(1);
    expect(engine.countRows()).toBe(1);

    const rows = engine.whereSearch("json_extract(data, '$.id') = 'rec-1'", 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.data.name).toBe('Alice');
    expect(rows[0]!.data.age).toBe(30);

    engine.close();
  });

  // Req 3.4: DataFinder.find with --match query returns matching records
  it('DataFinder.find with --match returns matching records (Req 3.4)', async () => {
    await manager.init('find-col', relationalMatchPolicy);

    const colPath = join(tmpDir, 'collections', 'find-col');
    const engine = SQLiteEngine.open(colPath);
    engine.initSchema(relationalMatchPolicy);

    const writer = new DataWriter(relationalMatchPolicy, mockEmbedder, undefined, engine);
    await writer.write({ id: 'doc-1', content: 'TypeScript is a typed superset of JavaScript' });
    await writer.write({ id: 'doc-2', content: 'Python is great for data science' });
    await writer.write({ id: 'doc-3', content: 'TypeScript compiles to plain JavaScript' });

    const finder = new DataFinder(relationalMatchPolicy, mockEmbedder, undefined, engine);
    const results = await finder.find('TypeScript', { match: true, limit: 10 });

    expect(results.length).toBeGreaterThanOrEqual(1);
    const ids = results.map((r) => r.data.id as string);
    expect(ids).toContain('doc-1');
    // Python-only doc should not appear
    expect(ids).not.toContain('doc-2');

    engine.close();
  });

  // Req 3.5: CollectionManager.remove deletes collection directory
  it('CollectionManager.remove deletes collection directory (Req 3.5)', async () => {
    await manager.init('remove-col', relationalPolicy);
    expect(await manager.exists('remove-col')).toBe(true);

    await manager.remove('remove-col');
    expect(await manager.exists('remove-col')).toBe(false);

    const colDir = join(tmpDir, 'collections', 'remove-col');
    await expect(stat(colDir)).rejects.toThrow();
  });

  // Req 3.6: CollectionManager.list returns all collections
  it('CollectionManager.list returns all collections (Req 3.6)', async () => {
    await manager.init('col-alpha', relationalPolicy);
    await manager.init('col-beta', relationalMatchPolicy);
    await manager.init('col-gamma', relationalPolicy);

    const list = await manager.list();
    expect(list).toHaveLength(3);

    const names = list.map((c) => c.name).sort();
    expect(names).toEqual(['col-alpha', 'col-beta', 'col-gamma']);
  });

  // Req 3.7: DataWriter.write with no id field auto-generates UUID
  it('DataWriter.write auto-generates UUID when no id field (Req 3.7)', async () => {
    await manager.init('uuid-col', relationalPolicy);

    const colPath = join(tmpDir, 'collections', 'uuid-col');
    const engine = SQLiteEngine.open(colPath);
    engine.initSchema(relationalPolicy);

    const writer = new DataWriter(relationalPolicy, mockEmbedder, undefined, engine);
    await writer.write({ name: 'no-id-record', value: 42 });

    expect(engine.countRows()).toBe(1);
    const rows = engine.whereSearch('1=1', 10);
    expect(rows).toHaveLength(1);

    const id = rows[0]!.data.id;
    expect(id).toBeDefined();
    expect(String(id)).toMatch(UUID_V4_RE);

    engine.close();
  });
});
