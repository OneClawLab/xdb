import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Command } from 'commander';
import { CollectionManager } from '../collection-manager.js';
import { Embedder } from '../embedder.js';
import { DataFinder } from '../data-finder.js';
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

/** Determine which engines to open based on policy */
function needsLance(policy: PolicyConfig): boolean {
  return policy.main === 'hybrid' || policy.main === 'vector';
}

function needsSqlite(policy: PolicyConfig): boolean {
  return policy.main === 'hybrid' || policy.main === 'relational';
}

export function registerFindCommand(program: Command): void {
  program
    .command('find <collection> [query]')
    .description('Search data in a collection')
    .option('-s, --similar', 'Semantic similarity search')
    .option('-m, --match', 'Full-text search')
    .option('-H, --hybrid', 'Hybrid search (vector + FTS with RRF fusion)')
    .option('-w, --where <sql>', 'SQL WHERE clause for filtering')
    .option('-l, --limit <n>', 'Maximum number of results', '10')
    .option('--json', 'Output as JSONL (machine-readable)')
    .action(
      async (
        collection: string,
        query: string | undefined,
        opts: { similar?: boolean; match?: boolean; hybrid?: boolean; where?: string; limit: string; json?: boolean },
      ) => {
        try {
          await executeFind(getDataRoot(), collection, query, opts);
        } catch (err) {
          handleError(err);
        }
      },
    );
}

export async function executeFind(
  dataRoot: string,
  collection: string,
  query: string | undefined,
  opts: { similar?: boolean; match?: boolean; hybrid?: boolean; where?: string; limit: string; json?: boolean },
): Promise<void> {
  // 1. Load collection meta
  const manager = new CollectionManager(dataRoot);
  const meta = await manager.load(collection); // throws if not exists
  const policy = meta.policy;
  const colPath = join(dataRoot, 'collections', collection);

  // Parse limit
  const limit = parseInt(opts.limit, 10);
  if (isNaN(limit) || limit <= 0) {
    throw new XDBError(PARAMETER_ERROR, `Invalid limit value: ${opts.limit}`);
  }

  // 2. If no query positional arg, read from stdin (Req 6.2)
  if (query === undefined && (opts.similar || opts.match || opts.hybrid)) {
    const stdinText = await readStdin();
    const trimmed = stdinText.trim();
    if (trimmed.length > 0) {
      query = trimmed;
    }
  }

  // 3. Open engines based on policy
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

    // 4. Create Embedder and DataFinder
    const embedder = new Embedder();
    const finder = new DataFinder(policy, embedder, lanceEngine, sqliteEngine, {
      info(msg) { process.stderr.write(`${msg}\n`); },
      warn(msg) { process.stderr.write(`Warning: ${msg}\n`); },
      error(msg) { process.stderr.write(`Error: ${msg}\n`); },
    });

    // 5. Execute find
    const results = await finder.find(query, {
      ...(opts.similar !== undefined ? { similar: opts.similar } : {}),
      ...(opts.match !== undefined ? { match: opts.match } : {}),
      ...(opts.hybrid !== undefined ? { hybrid: opts.hybrid } : {}),
      ...(opts.where !== undefined ? { where: opts.where } : {}),
      limit,
    });

    // 6. Output results
    if (results.length === 0) {
      if (!opts.json) {
        process.stderr.write('No results found.\n');
      }
      return;
    }

    if (opts.json) {
      // JSONL output (Req 6.3, 7.2, 10.2)
      for (const result of results) {
        const output: Record<string, unknown> = {
          ...result.data,
          _score: result._score,
          _engine: result._engine,
          ...(result._scores !== undefined ? { _scores: result._scores } : {}),
        };
        process.stdout.write(JSON.stringify(output) + '\n');
      }
    } else {
      // Human-readable output
      for (const result of results) {
        const score = typeof result._score === 'number' ? ` (score: ${result._score.toFixed(4)})` : '';
        const id = result.data.id ? `[${result.data.id}]` : '';
        // Show a compact summary of the data
        const dataKeys = Object.keys(result.data).filter((k) => k !== 'id');
        const preview = dataKeys
          .slice(0, 3)
          .map((k) => {
            const v = result.data[k];
            const s = typeof v === 'string' ? v : JSON.stringify(v);
            const truncated = s != null && s.length > 60 ? s.substring(0, 57) + '...' : s;
            return `${k}=${truncated}`;
          })
          .join('  ');
        const more = dataKeys.length > 3 ? `  (+${dataKeys.length - 3} more)` : '';
        process.stdout.write(`${id}${score}  ${preview}${more}\n`);
      }
      process.stderr.write(`${results.length} result(s) found.\n`);
    }
  } finally {
    // 7. Close engines
    if (lanceEngine) await lanceEngine.close();
    if (sqliteEngine) sqliteEngine.close();
  }
}
