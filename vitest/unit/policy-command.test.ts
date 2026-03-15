import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import { PolicyRegistry } from '../../src/policy-registry.js';

function createTestPolicyCommand() {
  const captured = {
    stdout: '' as string,
    stderr: '' as string,
    exitCode: null as number | null,
  };

  const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    captured.stdout += String(chunk);
    return true;
  });
  const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    captured.stderr += String(chunk);
    return true;
  });
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: number | string | null | undefined) => {
    captured.exitCode = typeof code === 'number' ? code : 0;
    throw new Error(`process.exit(${code})`);
  });

  const program = new Command();
  program.exitOverride();

  const ENGINE_DESC: Record<string, string> = {
    hybrid: 'LanceDB + SQLite',
    relational: 'SQLite',
    vector: 'LanceDB',
  };

  const policy = program.command('policy').description('Discover available policies');

  policy
    .command('list')
    .description('List all available built-in policies')
    .option('--json', 'Output as JSON array')
    .action((opts: { json?: boolean }) => {
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
                const caps = p.fields[f].findCaps.join(', ');
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
        const { handleError } = require('../../src/errors.js');
        handleError(err);
      }
    });

  return { program, captured, cleanup: () => { stdoutSpy.mockRestore(); stderrSpy.mockRestore(); exitSpy.mockRestore(); } };
}

describe('policy subcommand', () => {
  describe('policy list', () => {
    it('lists all built-in policies in human-readable format', async () => {
      const { program, captured, cleanup } = createTestPolicyCommand();
      try {
        await program.parseAsync(['node', 'xdb', 'policy', 'list']);
      } finally {
        cleanup();
      }

      expect(captured.exitCode).toBeNull();
      expect(captured.stdout).toContain('hybrid/knowledge-base');
      expect(captured.stdout).toContain('relational/structured-logs');
      expect(captured.stdout).toContain('relational/simple-kv');
      expect(captured.stdout).toContain('vector/feature-store');
      expect(captured.stdout).toContain('engines:');
      expect(captured.stdout).toContain('fields:');
      expect(captured.stdout).toContain('autoIndex:');
    });

    it('shows engine info for each policy', async () => {
      const { program, captured, cleanup } = createTestPolicyCommand();
      try {
        await program.parseAsync(['node', 'xdb', 'policy', 'list']);
      } finally {
        cleanup();
      }

      expect(captured.stdout).toContain('LanceDB + SQLite');
      expect(captured.stdout).toContain('SQLite');
      expect(captured.stdout).toContain('LanceDB');
    });

    it('shows field findCaps for policies with fields', async () => {
      const { program, captured, cleanup } = createTestPolicyCommand();
      try {
        await program.parseAsync(['node', 'xdb', 'policy', 'list']);
      } finally {
        cleanup();
      }

      expect(captured.stdout).toContain('content [similar, match]');
      expect(captured.stdout).toContain('tensor [similar]');
    });

    it('shows (none) for policies without fields', async () => {
      const { program, captured, cleanup } = createTestPolicyCommand();
      try {
        await program.parseAsync(['node', 'xdb', 'policy', 'list']);
      } finally {
        cleanup();
      }

      expect(captured.stdout).toContain('(none)');
    });

    it('outputs JSON array with --json', async () => {
      const { program, captured, cleanup } = createTestPolicyCommand();
      try {
        await program.parseAsync(['node', 'xdb', 'policy', 'list', '--json']);
      } finally {
        cleanup();
      }

      expect(captured.exitCode).toBeNull();
      const parsed = JSON.parse(captured.stdout.trim());
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBe(4);

      const names = parsed.map((p: { main: string; minor: string }) => `${p.main}/${p.minor}`);
      expect(names).toContain('hybrid/knowledge-base');
      expect(names).toContain('relational/structured-logs');
      expect(names).toContain('relational/simple-kv');
      expect(names).toContain('vector/feature-store');

      for (const p of parsed) {
        expect(p).toHaveProperty('main');
        expect(p).toHaveProperty('minor');
        expect(p).toHaveProperty('fields');
      }
    });
  });
});
