import { Command } from 'commander';
import { registerColCommands } from './commands/col.js';
import { registerPutCommand } from './commands/put.js';
import { registerFindCommand } from './commands/find.js';

const program = new Command();

program
  .name('xdb')
  .description('Intent-driven data hub CLI for AI agents')
  .version('0.1.0');

// --- col subcommand (collection management) ---
const col = program
  .command('col')
  .description('Manage collections');

registerColCommands(col);

// --- put command (data writing) ---
registerPutCommand(program);

// --- find command (data retrieval) ---
registerFindCommand(program);

// Ensure errors go to stderr (Requirement 10.3)
program.configureOutput({
  writeErr: (str) => process.stderr.write(str),
  writeOut: (str) => process.stdout.write(str),
});

program.parse(process.argv);
