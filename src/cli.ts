import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerColCommands } from './commands/col.js';
import { registerPutCommand } from './commands/put.js';
import { registerFindCommand } from './commands/find.js';
import { installHelp, addColExamples, addPutExamples, addFindExamples } from './help.js';

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
let pkgVersion = '0.1.0';
try {
  const pkg = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8'));
  pkgVersion = pkg.version;
} catch { /* fallback */ }

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

// --- put command (data writing) ---
registerPutCommand(program);
addPutExamples(program.commands.find(c => c.name() === 'put')!);

// --- find command (data retrieval) ---
registerFindCommand(program);
addFindExamples(program.commands.find(c => c.name() === 'find')!);

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
