import type { Command } from 'commander';
import { PolicyRegistry } from '../policy-registry.js';
import { handleError } from '../errors.js';

/** Engine descriptions for human-readable output */
const ENGINE_DESC: Record<string, string> = {
  hybrid: 'LanceDB + SQLite',
  relational: 'SQLite',
  vector: 'LanceDB',
};

export function registerPolicyCommands(policy: Command): void {
  policy
    .command('list')
    .description('List all available built-in policies')
    .option('--json', 'Output as JSON array')
    .action((opts: { json?: boolean }) => {
      process.stderr.write("[Deprecated] xdb policy list is deprecated. Use 'xdb config' instead.\n");
      try {
        const registry = new PolicyRegistry();
        const policies = registry.listPolicies();

        if (opts.json) {
          process.stdout.write(JSON.stringify(policies) + '\n');
          return;
        }

        for (const p of policies) {
          const name = `${p.main}/${p.minor}`;
          const engines = ENGINE_DESC[p.main] ?? p.main;
          const fieldNames = Object.keys(p.fields);
          const fieldsStr = fieldNames.length > 0
            ? fieldNames.map((f) => {
                const caps = p.fields[f]!.findCaps.join(', ');
                return `${f} [${caps}]`;
              }).join('; ')
            : '(none)';
          const autoIdx = p.autoIndex ? 'yes' : 'no';

          process.stdout.write(`${name}\n`);
          process.stdout.write(`  engines:    ${engines}\n`);
          process.stdout.write(`  fields:     ${fieldsStr}\n`);
          process.stdout.write(`  autoIndex:  ${autoIdx}\n`);
        }
      } catch (err) {
        handleError(err);
      }
    });
}
