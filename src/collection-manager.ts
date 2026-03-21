import { readdir, mkdir, rm, stat, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PARAMETER_ERROR, RUNTIME_ERROR, XDBError } from './errors.js';
import type { PolicyConfig } from './policy-registry.js';

export interface CollectionMeta {
  name: string;
  policy: PolicyConfig;
  createdAt: string;
  /** Embedding vector dimension, recorded on first vector write for consistency checks. */
  embeddingDimension?: number;
}

export interface CollectionInfo {
  name: string;
  policy: string; // "main/minor"
  recordCount: number;
  sizeBytes: number;
  embeddingDimension?: number;
}

export class CollectionManager {
  private collectionsDir: string;

  constructor(private dataRoot: string) {
    this.collectionsDir = join(dataRoot, 'collections');
  }

  /** Ensure the dataRoot and collections directory exist. */
  private async ensureRoot(): Promise<void> {
    await mkdir(this.collectionsDir, { recursive: true });
  }

  private collectionPath(name: string): string {
    return join(this.collectionsDir, name);
  }

  private metaPath(name: string): string {
    return join(this.collectionPath(name), 'collection_meta.json');
  }

  /**
   * Create a new collection directory and write collection_meta.json.
   * Throws PARAMETER_ERROR if the collection already exists.
   */
  async init(name: string, policy: PolicyConfig): Promise<void> {
    await this.ensureRoot();

    if (await this.exists(name)) {
      throw new XDBError(PARAMETER_ERROR, `Collection "${name}" already exists`);
    }

    const colPath = this.collectionPath(name);
    await mkdir(colPath, { recursive: true });

    const meta: CollectionMeta = {
      name,
      policy,
      createdAt: new Date().toISOString(),
    };

    await writeFile(this.metaPath(name), JSON.stringify(meta, null, 2), 'utf-8');
  }

  /**
   * Scan the collections directory and return info for each collection.
   */
  async list(): Promise<CollectionInfo[]> {
    await this.ensureRoot();

    let entries: string[];
    try {
      entries = await readdir(this.collectionsDir);
    } catch {
      return [];
    }

    const results: CollectionInfo[] = [];

    for (const entry of entries) {
      const colPath = this.collectionPath(entry);
      try {
        const s = await stat(colPath);
        if (!s.isDirectory()) continue;

        const meta = await this.load(entry);
        const sizeBytes = await this.calcDirSize(colPath);
        const recordCount = await this.countRecords(colPath, meta.policy);

        results.push({
          name: meta.name,
          policy: `${meta.policy.main}/${meta.policy.minor}`,
          recordCount,
          sizeBytes,
          ...(meta.embeddingDimension !== undefined ? { embeddingDimension: meta.embeddingDimension } : {}),
        });
      } catch {
        // Skip directories without valid meta
        continue;
      }
    }

    return results;
  }

  /**
   * Count records in a collection by opening the appropriate engine.
   * Prefers SQLite (cheaper to open) when available, falls back to LanceDB.
   */
  private async countRecords(colPath: string, policy: PolicyConfig): Promise<number> {
    const hasSqlite = policy.main === 'hybrid' || policy.main === 'relational';
    const hasLance = policy.main === 'hybrid' || policy.main === 'vector';

    if (hasSqlite) {
      try {
        const { default: Database } = await import('better-sqlite3');
        const dbPath = join(colPath, 'relational.db');
        // Check file exists before opening
        try { await stat(dbPath); } catch { return 0; }
        const db = new Database(dbPath, { readonly: true });
        try {
          const row = db.prepare('SELECT COUNT(*) as cnt FROM records').get() as { cnt: number } | undefined;
          return row?.cnt ?? 0;
        } catch {
          return 0;
        } finally {
          db.close();
        }
      } catch {
        return 0;
      }
    }

    if (hasLance) {
      try {
        const lancedb = await import('@lancedb/lancedb');
        const dbPath = join(colPath, 'vector.lance');
        try { await stat(dbPath); } catch { return 0; }
        const db = await lancedb.connect(dbPath);
        const tableNames = await db.tableNames();
        if (tableNames.includes('data')) {
          const table = await db.openTable('data');
          const count = await table.countRows();
          table.close();
          db.close();
          return count;
        }
        db.close();
        return 0;
      } catch {
        return 0;
      }
    }

    return 0;
  }

  /**
   * Recursively delete a collection directory.
   * Throws PARAMETER_ERROR if the collection doesn't exist.
   */
  async remove(name: string): Promise<void> {
    await this.ensureRoot();

    if (!(await this.exists(name))) {
      throw new XDBError(PARAMETER_ERROR, `Collection "${name}" does not exist`);
    }

    await rm(this.collectionPath(name), { recursive: true, force: true });
  }

  /**
   * Read and parse collection_meta.json for a collection.
   * Throws PARAMETER_ERROR if the collection doesn't exist.
   */
  async load(name: string): Promise<CollectionMeta> {
    if (!(await this.exists(name))) {
      throw new XDBError(PARAMETER_ERROR, `Collection "${name}" does not exist`);
    }

    try {
      const raw = await readFile(this.metaPath(name), 'utf-8');
      return JSON.parse(raw) as CollectionMeta;
    } catch (err) {
      if (err instanceof XDBError) throw err;
      throw new XDBError(RUNTIME_ERROR, `Failed to read metadata for collection "${name}": ${(err as Error).message}`);
    }
  }

  /**
   * Check if a collection directory exists.
   */
  async exists(name: string): Promise<boolean> {
    try {
      const s = await stat(this.collectionPath(name));
      return s.isDirectory();
    } catch {
      return false;
    }
  }

  /**
   * Update the embeddingDimension in collection_meta.json.
   * Only writes if the current meta has no embeddingDimension set.
   * Throws PARAMETER_ERROR if dimension conflicts with existing value.
   */
  async recordEmbeddingDimension(name: string, dimension: number): Promise<void> {
    const meta = await this.load(name);
    if (meta.embeddingDimension !== undefined) {
      if (meta.embeddingDimension !== dimension) {
        throw new XDBError(
          PARAMETER_ERROR,
          `Embedding dimension mismatch for collection "${name}": expected ${meta.embeddingDimension}, got ${dimension}. This usually means the embedding model has changed. Remove and recreate the collection to use a different model.`,
        );
      }
      return; // already recorded, same dimension
    }
    meta.embeddingDimension = dimension;
    await writeFile(this.metaPath(name), JSON.stringify(meta, null, 2), 'utf-8');
  }

  /** Calculate total size of all files in a directory (non-recursive for simplicity). */
  private async calcDirSize(dirPath: string): Promise<number> {
    let total = 0;
    try {
      const entries = await readdir(dirPath);
      for (const entry of entries) {
        const entryPath = join(dirPath, entry);
        const s = await stat(entryPath);
        if (s.isFile()) {
          total += s.size;
        } else if (s.isDirectory()) {
          total += await this.calcDirSize(entryPath);
        }
      }
    } catch {
      // Ignore errors in size calculation
    }
    return total;
  }
}
