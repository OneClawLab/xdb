import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Command } from 'commander';
import { CollectionManager } from '../collection-manager.js';
import { PolicyRegistry } from '../policy-registry.js';
import { handleError, PARAMETER_ERROR, XDBError } from '../errors.js';

function getDataRoot(): string {
  return join(homedir(), '.local', 'share', 'xdb');
}

/** Format bytes into a human-readable string */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function registerColCommands(col: Command): void {
  col
    .command('init <name>')
    .description('Initialize a new collection')
    .requiredOption('--policy <policy>', 'Policy name (main/minor format)')
    .option('--params <json>', 'Custom parameters as JSON to override policy defaults')
    .action(async (name: string, opts: { policy: string; params?: string }) => {
      try {
        const registry = new PolicyRegistry();
        let params: Record<string, unknown> | undefined;
        if (opts.params) {
          try {
            params = JSON.parse(opts.params) as Record<string, unknown>;
          } catch {
            throw new XDBError(PARAMETER_ERROR, `Invalid JSON for --params: ${opts.params}`);
          }
        }
        const config = registry.resolve(opts.policy, params);
        registry.validate(config);
        const manager = new CollectionManager(getDataRoot());
        await manager.init(name, config);
        process.stderr.write(`Collection "${name}" created (policy: ${config.main}/${config.minor})\n`);
      } catch (err) {
        handleError(err);
      }
    });

  col
    .command('list')
    .description('List all collections')
    .option('--json', 'Output as JSON array')
    .action(async (opts: { json?: boolean }) => {
      try {
        const manager = new CollectionManager(getDataRoot());
        const collections = await manager.list();

        if (opts.json) {
          process.stdout.write(JSON.stringify(collections) + '\n');
          return;
        }

        // Human-readable output
        if (collections.length === 0) {
          process.stderr.write('No collections found.\n');
          return;
        }

        for (const info of collections) {
          const dim = info.embeddingDimension ? `, dim=${info.embeddingDimension}` : '';
          process.stdout.write(
            `${info.name}  policy=${info.policy}  records=${info.recordCount}  size=${formatBytes(info.sizeBytes)}${dim}\n`,
          );
        }
      } catch (err) {
        handleError(err);
      }
    });

  col
    .command('info <name>')
    .description('Show detailed information about a collection')
    .option('--json', 'Output as JSON')
    .action(async (name: string, opts: { json?: boolean }) => {
      try {
        const manager = new CollectionManager(getDataRoot());
        const meta = await manager.load(name);
        const collections = await manager.list();
        const stats = collections.find((c) => c.name === name);

        const info = {
          name: meta.name,
          createdAt: meta.createdAt,
          policy: `${meta.policy.main}/${meta.policy.minor}`,
          engines: meta.policy.main,
          autoIndex: meta.policy.autoIndex ?? false,
          fields: meta.policy.fields,
          embeddingDimension: meta.embeddingDimension ?? null,
          recordCount: stats?.recordCount ?? 0,
          sizeBytes: stats?.sizeBytes ?? 0,
        };

        if (opts.json) {
          process.stdout.write(JSON.stringify(info) + '\n');
          return;
        }

        process.stdout.write(`name:       ${info.name}\n`);
        process.stdout.write(`createdAt:  ${info.createdAt}\n`);
        process.stdout.write(`policy:     ${info.policy}\n`);
        process.stdout.write(`engines:    ${info.engines}\n`);
        process.stdout.write(`autoIndex:  ${info.autoIndex}\n`);
        process.stdout.write(`records:    ${info.recordCount}\n`);
        process.stdout.write(`size:       ${formatBytes(info.sizeBytes)}\n`);
        if (info.embeddingDimension) {
          process.stdout.write(`embedDim:   ${info.embeddingDimension}\n`);
        }

        const fieldNames = Object.keys(info.fields);
        if (fieldNames.length > 0) {
          process.stdout.write(`fields:\n`);
          for (const [f, cfg] of Object.entries(info.fields)) {
            process.stdout.write(`  ${f}  findCaps=[${cfg.findCaps.join(', ')}]\n`);
          }
        } else {
          process.stdout.write(`fields:     (none)\n`);
        }
      } catch (err) {
        handleError(err);
      }
    });

  col
    .command('rm <name>')
    .description('Remove a collection')
    .action(async (name: string) => {
      try {
        const manager = new CollectionManager(getDataRoot());
        await manager.remove(name);
        process.stderr.write(`Collection "${name}" removed.\n`);
      } catch (err) {
        handleError(err);
      }
    });
}
