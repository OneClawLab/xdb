import type { Command } from 'commander';
import { XdbConfigManager } from '../config-manager.js';
import { PolicyRegistry } from '../policy-registry.js';
import { handleError, XDBError, PARAMETER_ERROR } from '../errors.js';

/** Engine descriptions for human-readable output */
const ENGINE_DESC: Record<string, string> = {
  hybrid: 'LanceDB + SQLite',
  relational: 'SQLite',
  vector: 'LanceDB',
};

/** Mask an API key for display: show first 3 chars + last 4 chars */
function maskApiKey(key: string): string {
  if (key.length <= 7) return '****';
  return `${key.slice(0, 3)}...${key.slice(-4)}`;
}

/** Core logic for `xdb config` (no subcommand), extracted for testability */
export async function executeConfig(
  opts: { json?: boolean },
  manager: XdbConfigManager = new XdbConfigManager(),
): Promise<void> {
  const cfg = await manager.load();
  const registry = new PolicyRegistry();
  const policies = registry.listPolicies();

  if (opts.json) {
    let hasApiKey = false;
    const provider = cfg.defaultEmbedProvider;
    if (provider) {
      try {
        await manager.resolveApiKey(provider);
        hasApiKey = true;
      } catch {
        hasApiKey = false;
      }
    }

    const providerConfig = cfg.providers.find((p) => p.name === provider);

    const output = {
      embed: {
        provider: cfg.defaultEmbedProvider ?? null,
        model: cfg.defaultEmbedModel ?? null,
        baseUrl: providerConfig?.baseUrl ?? null,
        hasApiKey,
      },
      policies,
    };
    process.stdout.write(JSON.stringify(output, null, 2) + '\n');
    return;
  }

  // Human-readable output
  const provider = cfg.defaultEmbedProvider ?? '(not set)';
  const model = cfg.defaultEmbedModel ?? '(not set)';
  const providerConfig = cfg.providers.find((p) => p.name === cfg.defaultEmbedProvider);
  const baseUrl = providerConfig?.baseUrl ?? '(default)';

  let apiKeyDisplay = '(not set)';
  if (cfg.defaultEmbedProvider) {
    try {
      const key = await manager.resolveApiKey(cfg.defaultEmbedProvider);
      apiKeyDisplay = maskApiKey(key);
    } catch {
      apiKeyDisplay = '(not set)';
    }
  }

  process.stdout.write('Embed Configuration:\n');
  process.stdout.write(`  provider:  ${provider}\n`);
  process.stdout.write(`  model:     ${model}\n`);
  process.stdout.write(`  base-url:  ${baseUrl}\n`);
  process.stdout.write(`  api-key:   ${apiKeyDisplay}\n`);
  process.stdout.write('\n');
  process.stdout.write('Available Policies:\n');

  for (const p of policies) {
    const name = `${p.main}/${p.minor}`;
    const engines = ENGINE_DESC[p.main] ?? p.main;
    const fieldNames = Object.keys(p.fields);
    const fieldsStr =
      fieldNames.length > 0
        ? fieldNames
            .map((f) => {
              const caps = p.fields[f]!.findCaps.join(', ');
              return `${f} [${caps}]`;
            })
            .join('; ')
        : '(none)';
    const autoIdx = p.autoIndex ? 'yes' : 'no';

    process.stdout.write(`  ${name}\n`);
    process.stdout.write(`    engines:    ${engines}\n`);
    process.stdout.write(`    fields:     ${fieldsStr}\n`);
    process.stdout.write(`    autoIndex:  ${autoIdx}\n`);
  }
}

export interface ConfigEmbedOptions {
  setProvider?: string;
  setModel?: string;
  setKey?: string;
  setBaseUrl?: string;
}

/** Core logic for `xdb config embed`, extracted for testability */
export async function executeConfigEmbed(
  opts: ConfigEmbedOptions,
  manager: XdbConfigManager = new XdbConfigManager(),
): Promise<void> {
  const cfg = await manager.load();

  if (opts.setProvider !== undefined) {
    cfg.defaultEmbedProvider = opts.setProvider;
    await manager.save(cfg);
    process.stdout.write(`Embed provider set to: ${opts.setProvider}\n`);
  }

  if (opts.setModel !== undefined) {
    cfg.defaultEmbedModel = opts.setModel;
    await manager.save(cfg);
    process.stdout.write(`Embed model set to: ${opts.setModel}\n`);
  }

  if (opts.setKey !== undefined) {
    if (!cfg.defaultEmbedProvider) {
      throw new XDBError(
        PARAMETER_ERROR,
        'No embed provider configured. Run: xdb config embed --set-provider <name>',
      );
    }
    const existing = cfg.providers.find((p) => p.name === cfg.defaultEmbedProvider);
    if (existing) {
      existing.apiKey = opts.setKey;
    } else {
      cfg.providers.push({ name: cfg.defaultEmbedProvider!, apiKey: opts.setKey });
    }
    await manager.save(cfg);
    process.stdout.write(`API key set for provider: ${cfg.defaultEmbedProvider}\n`);
  }

  if (opts.setBaseUrl !== undefined) {
    if (!cfg.defaultEmbedProvider) {
      throw new XDBError(
        PARAMETER_ERROR,
        'No embed provider configured. Run: xdb config embed --set-provider <name>',
      );
    }
    const existing = cfg.providers.find((p) => p.name === cfg.defaultEmbedProvider);
    if (existing) {
      existing.baseUrl = opts.setBaseUrl;
    } else {
      cfg.providers.push({ name: cfg.defaultEmbedProvider!, baseUrl: opts.setBaseUrl });
    }
    await manager.save(cfg);
    process.stdout.write(`Base URL set for provider: ${cfg.defaultEmbedProvider}\n`);
  }
}

export function registerConfigCommands(config: Command): void {
  // xdb config (no subcommand): display full current configuration
  config
    .option('--json', 'Output as JSON')
    .action(async (opts: { json?: boolean }) => {
      try {
        await executeConfig(opts);
      } catch (err) {
        handleError(err);
      }
    });

  // xdb config embed subcommand
  config
    .command('embed')
    .description('Manage embed service configuration')
    .option('--set-provider <name>', 'Set the default embed provider')
    .option('--set-model <model>', 'Set the default embed model')
    .option('--set-key <apiKey>', 'Set the API key for the current provider')
    .option('--set-base-url <url>', 'Set the base URL for the current provider')
    .action(async (opts: ConfigEmbedOptions) => {
      try {
        await executeConfigEmbed(opts);
      } catch (err) {
        handleError(err);
      }
    });
}
