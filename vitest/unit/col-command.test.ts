import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Command } from 'commander';
import { CollectionManager } from '../../src/collection-manager.js';
import { PolicyRegistry } from '../../src/policy-registry.js';

/**
 * Helper: create a col command tree wired to a temp dataRoot.
 * We replicate the registerColCommands logic but inject a custom dataRoot
 * and capture process.exit / stderr / stdout for assertions.
 */
function createTestColCommand(dataRoot: string) {
  const captured = {
    stdout: '' as string,
    stderr: '' as string,
    exitCode: null as number | null,
  };

  // Stub process.stdout.write, process.stderr.write, process.exit
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
  program.exitOverride(); // throw on commander errors instead of process.exit

  const col = program.command('col').description('Manage collections');

  // Wire up col commands with injected dataRoot
  col
    .command('init <name>')
    .description('Initialize a new collection')
    .requiredOption('--policy <policy>', 'Policy name (main/minor format)')
    .option('--params <json>', 'Custom parameters as JSON to override policy defaults')
    .action(async (name: string, opts: { policy: string; params?: string }) => {
      const { handleError, PARAMETER_ERROR, XDBError } = await import('../../src/errors.js');
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
        const manager = new CollectionManager(dataRoot);
        await manager.init(name, config);
      } catch (err) {
        handleError(err);
      }
    });

  col
    .command('list')
    .description('List all collections')
    .option('--json', 'Output as JSON array')
    .action(async (opts: { json?: boolean }) => {
      const { handleError } = await import('../../src/errors.js');
      try {
        const manager = new CollectionManager(dataRoot);
        const collections = await manager.list();

        if (opts.json) {
          process.stdout.write(JSON.stringify(collections) + '\n');
          return;
        }

        if (collections.length === 0) {
          process.stderr.write('No collections found.\n');
          return;
        }

        for (const info of collections) {
          process.stdout.write(
            `${info.name}  policy=${info.policy}  records=${info.recordCount}\n`,
          );
        }
      } catch (err) {
        handleError(err);
      }
    });

  col
    .command('rm <name>')
    .description('Remove a collection')
    .action(async (name: string) => {
      const { handleError } = await import('../../src/errors.js');
      try {
        const manager = new CollectionManager(dataRoot);
        await manager.remove(name);
      } catch (err) {
        handleError(err);
      }
    });

  return { program, captured, cleanup: () => { stdoutSpy.mockRestore(); stderrSpy.mockRestore(); exitSpy.mockRestore(); } };
}

describe('col subcommand', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'xdb-col-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe('col init', () => {
    it('creates a collection with a valid policy (Req 1.1)', async () => {
      const { program, captured, cleanup } = createTestColCommand(tmpDir);
      try {
        await program.parseAsync(['node', 'xdb', 'col', 'init', 'my-col', '--policy', 'hybrid']);
      } finally {
        cleanup();
      }

      // Verify collection was created
      const manager = new CollectionManager(tmpDir);
      expect(await manager.exists('my-col')).toBe(true);

      const meta = await manager.load('my-col');
      expect(meta.policy.main).toBe('hybrid');
      expect(meta.policy.minor).toBe('knowledge-base');
      expect(captured.exitCode).toBeNull();
    });

    it('creates a collection with full main/minor policy name', async () => {
      const { program, captured, cleanup } = createTestColCommand(tmpDir);
      try {
        await program.parseAsync(['node', 'xdb', 'col', 'init', 'test-col', '--policy', 'relational/simple-kv']);
      } finally {
        cleanup();
      }

      const manager = new CollectionManager(tmpDir);
      const meta = await manager.load('test-col');
      expect(meta.policy.main).toBe('relational');
      expect(meta.policy.minor).toBe('simple-kv');
      expect(captured.exitCode).toBeNull();
    });

    it('merges --params into policy snapshot (Req 1.2)', async () => {
      const { program, captured, cleanup } = createTestColCommand(tmpDir);
      const params = JSON.stringify({ fields: { summary: { findCaps: ['match'] } } });
      try {
        await program.parseAsync(['node', 'xdb', 'col', 'init', 'param-col', '--policy', 'hybrid', '--params', params]);
      } finally {
        cleanup();
      }

      const manager = new CollectionManager(tmpDir);
      const meta = await manager.load('param-col');
      expect(meta.policy.fields.summary).toEqual({ findCaps: ['match'] });
      expect(meta.policy.fields.content).toEqual({ findCaps: ['similar', 'match'] });
      expect(captured.exitCode).toBeNull();
    });

    it('exits with code 1 when --policy is missing (Req 1.3)', async () => {
      const { program, cleanup } = createTestColCommand(tmpDir);
      try {
        await program.parseAsync(['node', 'xdb', 'col', 'init', 'no-policy']);
        expect.fail('Should have thrown');
      } catch (e) {
        expect((e as Error).message).toBeTruthy();
      } finally {
        cleanup();
      }
    });

    it('exits with code 1 when policy name is unknown (Req 1.4)', async () => {
      const { program, captured, cleanup } = createTestColCommand(tmpDir);
      try {
        await program.parseAsync(['node', 'xdb', 'col', 'init', 'bad-pol', '--policy', 'nonexistent']);
      } catch {
      } finally {
        cleanup();
      }

      expect(captured.exitCode).toBe(1);
      expect(captured.stderr).toContain('Unknown policy');
      expect(captured.stderr).toContain('Available policies');
    });

    it('exits with code 1 when collection already exists (Req 1.5)', async () => {
      const { program: p1, cleanup: c1 } = createTestColCommand(tmpDir);
      try {
        await p1.parseAsync(['node', 'xdb', 'col', 'init', 'dup', '--policy', 'hybrid']);
      } finally {
        c1();
      }

      const { program: p2, captured: cap2, cleanup: c2 } = createTestColCommand(tmpDir);
      try {
        await p2.parseAsync(['node', 'xdb', 'col', 'init', 'dup', '--policy', 'hybrid']);
      } catch {
      } finally {
        c2();
      }

      expect(cap2.exitCode).toBe(1);
      expect(cap2.stderr).toContain('already exists');
    });

    it('exits with code 1 when --params has invalid JSON', async () => {
      const { program, captured, cleanup } = createTestColCommand(tmpDir);
      try {
        await program.parseAsync(['node', 'xdb', 'col', 'init', 'bad-json', '--policy', 'hybrid', '--params', '{bad}']);
      } catch {
      } finally {
        cleanup();
      }

      expect(captured.exitCode).toBe(1);
      expect(captured.stderr).toContain('Invalid JSON');
    });

    it('exits with code 1 when findCaps conflict with engine type (Req 9.11)', async () => {
      const params = JSON.stringify({ fields: { vec: { findCaps: ['similar'] } } });
      const { program, captured, cleanup } = createTestColCommand(tmpDir);
      try {
        await program.parseAsync(['node', 'xdb', 'col', 'init', 'conflict', '--policy', 'relational', '--params', params]);
      } catch {
      } finally {
        cleanup();
      }

      expect(captured.exitCode).toBe(1);
      expect(captured.stderr).toContain('similar');
      expect(captured.stderr).toContain('relational');
    });
  });

  describe('col list', () => {
    it('outputs human-readable message when no collections exist', async () => {
      const { program, captured, cleanup } = createTestColCommand(tmpDir);
      try {
        await program.parseAsync(['node', 'xdb', 'col', 'list']);
      } finally {
        cleanup();
      }

      expect(captured.stdout).toBe('');
      expect(captured.stderr).toContain('No collections found');
      expect(captured.exitCode).toBeNull();
    });

    it('outputs empty JSON array with --json when no collections exist', async () => {
      const { program, captured, cleanup } = createTestColCommand(tmpDir);
      try {
        await program.parseAsync(['node', 'xdb', 'col', 'list', '--json']);
      } finally {
        cleanup();
      }

      expect(JSON.parse(captured.stdout.trim())).toEqual([]);
      expect(captured.exitCode).toBeNull();
    });

    it('outputs human-readable list with collection info', async () => {
      const manager = new CollectionManager(tmpDir);
      const registry = new PolicyRegistry();
      await manager.init('col-a', registry.resolve('hybrid'));
      await manager.init('col-b', registry.resolve('relational'));

      const { program, captured, cleanup } = createTestColCommand(tmpDir);
      try {
        await program.parseAsync(['node', 'xdb', 'col', 'list']);
      } finally {
        cleanup();
      }

      const lines = captured.stdout.trim().split('\n');
      expect(lines).toHaveLength(2);
      // Each line should contain the collection name and policy
      const combined = lines.join('\n');
      expect(combined).toContain('col-a');
      expect(combined).toContain('col-b');
      expect(combined).toContain('policy=');
      expect(combined).toContain('records=');
    });

    it('outputs JSON array with --json (Req 2.1)', async () => {
      const manager = new CollectionManager(tmpDir);
      const registry = new PolicyRegistry();
      await manager.init('col-a', registry.resolve('hybrid'));
      await manager.init('col-b', registry.resolve('relational'));

      const { program, captured, cleanup } = createTestColCommand(tmpDir);
      try {
        await program.parseAsync(['node', 'xdb', 'col', 'list', '--json']);
      } finally {
        cleanup();
      }

      const parsed = JSON.parse(captured.stdout.trim());
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toHaveLength(2);

      const names = parsed.map((p: { name: string }) => p.name).sort();
      expect(names).toEqual(['col-a', 'col-b']);

      for (const item of parsed) {
        expect(item).toHaveProperty('name');
        expect(item).toHaveProperty('policy');
        expect(item).toHaveProperty('recordCount');
        expect(item).toHaveProperty('sizeBytes');
      }
    });

    it('--json output for single collection has correct policy', async () => {
      const manager = new CollectionManager(tmpDir);
      const registry = new PolicyRegistry();
      await manager.init('single', registry.resolve('vector'));

      const { program, captured, cleanup } = createTestColCommand(tmpDir);
      try {
        await program.parseAsync(['node', 'xdb', 'col', 'list', '--json']);
      } finally {
        cleanup();
      }

      const parsed = JSON.parse(captured.stdout.trim());
      expect(parsed).toHaveLength(1);
      expect(parsed[0].name).toBe('single');
      expect(parsed[0].policy).toBe('vector/feature-store');
    });
  });

  describe('col rm', () => {
    it('removes an existing collection (Req 3.1)', async () => {
      const manager = new CollectionManager(tmpDir);
      const registry = new PolicyRegistry();
      await manager.init('to-remove', registry.resolve('hybrid'));
      expect(await manager.exists('to-remove')).toBe(true);

      const { program, captured, cleanup } = createTestColCommand(tmpDir);
      try {
        await program.parseAsync(['node', 'xdb', 'col', 'rm', 'to-remove']);
      } finally {
        cleanup();
      }

      expect(await manager.exists('to-remove')).toBe(false);
      expect(captured.exitCode).toBeNull();
    });

    it('exits with code 1 when collection does not exist (Req 3.2)', async () => {
      const { program, captured, cleanup } = createTestColCommand(tmpDir);
      try {
        await program.parseAsync(['node', 'xdb', 'col', 'rm', 'ghost']);
      } catch {
      } finally {
        cleanup();
      }

      expect(captured.exitCode).toBe(1);
      expect(captured.stderr).toContain('does not exist');
    });
  });
});
