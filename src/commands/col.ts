import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Command } from 'commander';
import { CollectionManager } from '../collection-manager.js';
import { PolicyRegistry } from '../policy-registry.js';
import { handleError, PARAMETER_ERROR, XDBError } from '../errors.js';

function getDataRoot(): string {
  return join(homedir(), '.local', 'share', 'xdb');
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
      } catch (err) {
        handleError(err);
      }
    });

  col
    .command('list')
    .description('List all collections')
    .action(async () => {
      try {
        const manager = new CollectionManager(getDataRoot());
        const collections = await manager.list();
        for (const info of collections) {
          process.stdout.write(JSON.stringify(info) + '\n');
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
      } catch (err) {
        handleError(err);
      }
    });
}
