import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Command } from 'commander';
import { CollectionManager } from '../collection-manager.js';
import { Embedder } from '../embedder.js';
import { DataWriter } from '../data-writer.js';
import { handleError, PARAMETER_ERROR, XDBError } from '../errors.js';
import { LanceDBEngine } from '../engines/lancedb-engine.js';
import { SQLiteEngine } from '../engines/sqlite-engine.js';
import type { PolicyConfig } from '../policy-registry.js';

function getDataRoot(): string {
  return join(homedir(), '.local', 'share', 'xdb');
}

/** Read all of stdin as a string. Returns empty string if stdin is a TTY. */
function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }
    const chunks: Buffer[] = [];
    process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    process.stdin.on('error', reject);
  });
}

/** Parse JSONL string into an array of records. Throws on invalid JSON. */
function parseJsonl(input: string): Record<string, unknown>[] {
  const lines = input.split('\n').filter((l) => l.trim().length > 0);
  return lines.map((line, i) => {
    try {
      const parsed = JSON.parse(line);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Expected a JSON object');
      }
      return parsed as Record<string, unknown>;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new XDBError(PARAMETER_ERROR, `Invalid JSON at line ${i + 1}: ${msg}`);
    }
  });
}

/** Determine which engines to open based on policy */
function needsLance(policy: PolicyConfig): boolean {
  return policy.main === 'hybrid' || policy.main === 'vector';
}

function needsSqlite(policy: PolicyConfig): boolean {
  return policy.main === 'hybrid' || policy.main === 'relational';
}

export function registerPutCommand(program: Command): void {
  program
    .command('put <collection> [json]')
    .description('Write data to a collection')
    .option('--batch', 'Enable batch write mode for JSONL stdin input')
    .option('--json', 'Output stats as JSON (batch mode)')
    .action(async (collection: string, json: string | undefined, opts: { batch?: boolean; json?: boolean }) => {
      try {
        await executePut(getDataRoot(), collection, json, !!opts.batch, !!opts.json);
      } catch (err) {
        handleError(err);
      }
    });
}

export async function executePut(
  dataRoot: string,
  collection: string,
  json: string | undefined,
  batch: boolean,
  jsonOutput: boolean = false,
): Promise<void> {
  // 1. Load collection meta
  const manager = new CollectionManager(dataRoot);
  const meta = await manager.load(collection); // throws if not exists (Req 4.7)
  const policy = meta.policy;
  const colPath = join(dataRoot, 'collections', collection);

  // 2. Open engines based on policy
  let lanceEngine: LanceDBEngine | undefined;
  let sqliteEngine: SQLiteEngine | undefined;

  try {
    if (needsLance(policy)) {
      lanceEngine = await LanceDBEngine.open(colPath);
    }
    if (needsSqlite(policy)) {
      sqliteEngine = SQLiteEngine.open(colPath);
      sqliteEngine.initSchema(policy);
    }

    // 3. Create Embedder and DataWriter
    const embedder = new Embedder();
    const stderrLogger = {
      info(msg: string) { process.stderr.write(`${msg}\n`); },
      warn(msg: string) { process.stderr.write(`Warning: ${msg}\n`); },
      error(msg: string) { process.stderr.write(`Error: ${msg}\n`); },
    };
    const writer = new DataWriter(policy, embedder, lanceEngine, sqliteEngine, async (dim) => {
      await manager.recordEmbeddingDimension(collection, dim);
    }, stderrLogger);

    // 4. Collect records
    let records: Record<string, unknown>[];

    if (json !== undefined) {
      // Positional argument: single JSON object
      let parsed: unknown;
      try {
        parsed = JSON.parse(json);
      } catch {
        throw new XDBError(PARAMETER_ERROR, `Invalid JSON: ${json}`);
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new XDBError(PARAMETER_ERROR, 'Invalid input: expected a JSON object');
      }
      records = [parsed as Record<string, unknown>];
    } else {
      // Read from stdin (JSONL)
      const input = await readStdin();
      if (input.trim().length === 0) {
        throw new XDBError(PARAMETER_ERROR, 'No input provided. Pass JSON as argument or pipe JSONL via stdin.');
      }
      records = parseJsonl(input);
    }

    // 5. Write data
    if (batch) {
      const stats = await writer.writeBatch(records);
      if (jsonOutput) {
        process.stdout.write(JSON.stringify(stats) + '\n');
      } else {
        process.stderr.write(`Batch complete: ${stats.inserted} inserted, ${stats.updated} updated, ${stats.errors} errors\n`);
      }
    } else {
      for (const record of records) {
        await writer.write(record);
      }
      process.stderr.write(`${records.length} record(s) written to "${collection}"\n`);
    }
  } finally {
    // 6. Close engines
    if (lanceEngine) await lanceEngine.close();
    if (sqliteEngine) sqliteEngine.close();
  }
}
