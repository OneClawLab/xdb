/**
 * Real embedding manual test — requires a configured embedding provider (API key).
 * Run via: npm run test:manual
 *
 * This file is intentionally excluded from the regular vitest.config.ts.
 * Results are logged to stdout for human evaluation of semantic relevance.
 *
 * Requirements: 3.3, 3.4
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CollectionManager } from '../../src/collection-manager.js';
import { DataWriter } from '../../src/data-writer.js';
import { DataFinder } from '../../src/data-finder.js';
import { SQLiteEngine } from '../../src/engines/sqlite-engine.js';
import { LanceDBEngine } from '../../src/engines/lancedb-engine.js';
import { Embedder } from '../../src/embedder.js';
import type { PolicyConfig } from '../../src/policy-registry.js';

// hybrid/knowledge-base policy: supports both --similar (LanceDB) and --match (SQLite FTS)
const hybridPolicy: PolicyConfig = {
  main: 'hybrid',
  minor: 'knowledge-base',
  fields: { content: { findCaps: ['similar', 'match'] } },
  autoIndex: true,
};

describe('xdb real embedding integration tests', () => {
  let tmpDir: string;
  let manager: CollectionManager;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'xdb-real-'));
    manager = new CollectionManager(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // Req 3.3, 3.4: real embedding write + --similar semantic search
  it('writes documents with real embeddings and retrieves via --similar semantic search', async () => {
    const colName = 'real-embed-col';
    await manager.init(colName, hybridPolicy);

    const colPath = join(tmpDir, 'collections', colName);
    const embedder = new Embedder();

    const sqliteEngine = SQLiteEngine.open(colPath);
    sqliteEngine.initSchema(hybridPolicy);
    const lanceEngine = await LanceDBEngine.open(colPath);

    // Record embedding dimension into collection_meta.json on first write
    const onEmbeddingDimension = async (dim: number) => {
      await manager.recordEmbeddingDimension(colName, dim);
    };

    const writer = new DataWriter(hybridPolicy, embedder, lanceEngine, sqliteEngine, onEmbeddingDimension);

    const documents = [
      { id: 'doc-1', content: 'TypeScript is a strongly typed programming language that builds on JavaScript' },
      { id: 'doc-2', content: 'Python is widely used for machine learning and data science applications' },
      { id: 'doc-3', content: 'TypeScript compiles to plain JavaScript and runs in any browser or Node.js' },
      { id: 'doc-4', content: 'Rust provides memory safety without garbage collection through ownership' },
      { id: 'doc-5', content: 'JavaScript is the language of the web, running in every modern browser' },
    ];

    for (const doc of documents) {
      await writer.write(doc);
    }

    // Verify embedding dimension was recorded in collection_meta.json (Req 3.3)
    const metaRaw = await readFile(join(colPath, 'collection_meta.json'), 'utf-8');
    const meta = JSON.parse(metaRaw) as { embeddingDimension?: number };
    expect(meta.embeddingDimension).toBeDefined();
    expect(typeof meta.embeddingDimension).toBe('number');
    expect(meta.embeddingDimension).toBeGreaterThan(0);
    console.log(`Embedding dimension recorded in meta: ${meta.embeddingDimension}`);

    // --similar semantic search: query about TypeScript (Req 3.4)
    const finder = new DataFinder(hybridPolicy, embedder, lanceEngine, sqliteEngine);
    const results = await finder.find('TypeScript static typing', { similar: true, limit: 5 });

    // Structural assertions (non-empty, has id field)
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]).toHaveProperty('data');
    expect(results[0]!.data).toHaveProperty('id');

    // Log results for human evaluation of semantic relevance
    console.log('\n=== Semantic search results for "TypeScript static typing" ===');
    for (const r of results) {
      console.log(`  [score=${r._score?.toFixed(4) ?? 'n/a'}] id=${r.data['id']} content="${r.data['content']}"`);
    }
    console.log('=== Please evaluate: TypeScript docs should rank above Python/Rust ===\n');

    await lanceEngine.close();
    sqliteEngine.close();
  });

  // Req 3.4: --similar with a different semantic query
  it('semantic search returns structurally valid results for a different query', async () => {
    const colName = 'real-embed-col2';
    await manager.init(colName, hybridPolicy);

    const colPath = join(tmpDir, 'collections', colName);
    const embedder = new Embedder();

    const sqliteEngine = SQLiteEngine.open(colPath);
    sqliteEngine.initSchema(hybridPolicy);
    const lanceEngine = await LanceDBEngine.open(colPath);

    const onEmbeddingDimension = async (dim: number) => {
      await manager.recordEmbeddingDimension(colName, dim);
    };

    const writer = new DataWriter(hybridPolicy, embedder, lanceEngine, sqliteEngine, onEmbeddingDimension);

    await writer.write({ id: 'a1', content: 'Machine learning models require large datasets for training' });
    await writer.write({ id: 'a2', content: 'Neural networks are inspired by the human brain structure' });
    await writer.write({ id: 'a3', content: 'SQL databases store structured data in tables with rows and columns' });

    const finder = new DataFinder(hybridPolicy, embedder, lanceEngine, sqliteEngine);
    const results = await finder.find('deep learning neural network', { similar: true, limit: 3 });

    // Structural assertions
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.data).toHaveProperty('id');
      expect(r.data).toHaveProperty('content');
    }

    console.log('\n=== Semantic search results for "deep learning neural network" ===');
    for (const r of results) {
      console.log(`  [score=${r._score?.toFixed(4) ?? 'n/a'}] id=${r.data['id']} content="${r.data['content']}"`);
    }
    console.log('=== Please evaluate: ML/neural docs should rank above SQL doc ===\n');

    await lanceEngine.close();
    sqliteEngine.close();
  });
});
