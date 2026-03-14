import { readdir, mkdir, rm, stat, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PARAMETER_ERROR, RUNTIME_ERROR, XDBError } from './errors.js';
import type { PolicyConfig } from './policy-registry.js';

export interface CollectionMeta {
  name: string;
  policy: PolicyConfig;
  createdAt: string;
}

export interface CollectionInfo {
  name: string;
  policy: string; // "main/minor"
  recordCount: number;
  sizeBytes: number;
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

        results.push({
          name: meta.name,
          policy: `${meta.policy.main}/${meta.policy.minor}`,
          recordCount: 0, // Will be populated when engines are available
          sizeBytes,
        });
      } catch {
        // Skip directories without valid meta
        continue;
      }
    }

    return results;
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
