import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerColCommands } from './commands/col.js';
import { registerPolicyCommands } from './commands/policy.js';
import { registerPutCommand } from './commands/put.js';
import { registerFindCommand } from './commands/find.js';
import { registerConfigCommands } from './commands/config.js';
import { registerEmbedCommand } from './commands/embed.js';
import { installHelp, addColExamples, addPolicyExamples, addPutExamples, addFindExamples } from './help.js';

// Gracefully handle EPIPE (broken pipe, e.g. `xdb ... | head`)
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(0);
  throw err;
});
process.stderr.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(0);
  throw err;
});

// Read version from package.json
const __dirname = dirname(fileURLToPath(import.meta.url));
const { version: pkgVersion } = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8')) as { version: string };

const program = new Command();

program
  .name('xdb')
  .description('Intent-driven data hub CLI for AI agents')
  .version(`xdb ${pkgVersion}`)
  .showHelpAfterError(true);

program.exitOverride();

// Install help system
installHelp(program);

// --- col subcommand (collection management) ---
const col = program
  .command('col')
  .description('Manage collections');

registerColCommands(col);
addColExamples(col);

// --- policy subcommand (policy discovery) ---
const policy = program
  .command('policy')
  .description('Discover available policies');

registerPolicyCommands(policy);
addPolicyExamples(policy);

policy.action(() => {
  policy.outputHelp();
});

// --- put command (data writing) ---
registerPutCommand(program);
addPutExamples(program.commands.find(c => c.name() === 'put')!);

// --- find command (data retrieval) ---
registerFindCommand(program);
addFindExamples(program.commands.find(c => c.name() === 'find')!);

// --- config command (embed service configuration) ---
const config = program
  .command('config')
  .description('Manage xdb configuration');

registerConfigCommands(config);

// --- embed command ---
registerEmbedCommand(program);

// Ensure errors go to stderr (Requirement 10.3)
program.configureOutput({
  writeErr: (str) => process.stderr.write(str),
  writeOut: (str) => process.stdout.write(str),
});

// Show help if no args (col also shows help if no subcommand)
col.action(() => {
  col.outputHelp();
});

(async () => {
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    if (err && typeof err === 'object' && 'exitCode' in err) {
      const exitCode = (err as { exitCode: number }).exitCode;
      // Map commander's exit code 1 (argument errors) to 2 per spec
      process.exitCode = exitCode === 1 ? 2 : exitCode;
    } else {
      process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    }
  }
})();
