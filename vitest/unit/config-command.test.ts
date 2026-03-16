import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { executeConfig, executeConfigEmbed } from '../../src/commands/config.js';
import { XdbConfigManager } from '../../src/config-manager.js';
import { XDBError, PARAMETER_ERROR } from '../../src/errors.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'xdb-config-cmd-test-'));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('executeConfig', () => {
  let stdoutOutput: string;
  let stderrOutput: string;
  let tmpDir: string;
  let configPath: string;

  beforeEach(async () => {
    stdoutOutput = '';
    stderrOutput = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutOutput += String(chunk);
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrOutput += String(chunk);
      return true;
    });
    tmpDir = await makeTempDir();
    configPath = path.join(tmpDir, 'default.json');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('xdb config (no subcommand)', () => {
    it('outputs embed configuration section', async () => {
      await fs.writeFile(
        configPath,
        JSON.stringify({
          defaultEmbedProvider: 'openai',
          defaultEmbedModel: 'text-embedding-3-small',
          providers: [{ name: 'openai', apiKey: 'sk-test' }],
        }),
        'utf-8',
      );
      const manager = new XdbConfigManager(configPath);
      await executeConfig({}, manager);

      expect(stdoutOutput).toContain('Embed Configuration:');
      expect(stdoutOutput).toContain('openai');
      expect(stdoutOutput).toContain('text-embedding-3-small');
    });

    it('outputs available policies section', async () => {
      const manager = new XdbConfigManager(configPath);
      await executeConfig({}, manager);

      expect(stdoutOutput).toContain('Available Policies:');
      expect(stdoutOutput).toContain('hybrid/knowledge-base');
    });

    it('masks api key in output', async () => {
      await fs.writeFile(
        configPath,
        JSON.stringify({
          defaultEmbedProvider: 'openai',
          defaultEmbedModel: 'text-embedding-3-small',
          providers: [{ name: 'openai', apiKey: 'sk-verylongkey' }],
        }),
        'utf-8',
      );
      const manager = new XdbConfigManager(configPath);
      await executeConfig({}, manager);

      // Should not show full key
      expect(stdoutOutput).not.toContain('sk-verylongkey');
      // Should show masked version
      expect(stdoutOutput).toContain('sk-');
    });

    it('shows (not set) when no provider configured', async () => {
      const manager = new XdbConfigManager(configPath);
      await executeConfig({}, manager);

      expect(stdoutOutput).toContain('(not set)');
    });
  });

  describe('xdb config --json', () => {
    it('outputs valid JSON with embed and policies fields', async () => {
      await fs.writeFile(
        configPath,
        JSON.stringify({
          defaultEmbedProvider: 'openai',
          defaultEmbedModel: 'text-embedding-3-small',
          providers: [{ name: 'openai', apiKey: 'sk-test' }],
        }),
        'utf-8',
      );
      const manager = new XdbConfigManager(configPath);
      await executeConfig({ json: true }, manager);

      const parsed = JSON.parse(stdoutOutput.trim());
      expect(parsed).toHaveProperty('embed');
      expect(parsed).toHaveProperty('policies');
      expect(Array.isArray(parsed.policies)).toBe(true);
    });

    it('embed object contains provider, model, baseUrl, hasApiKey', async () => {
      await fs.writeFile(
        configPath,
        JSON.stringify({
          defaultEmbedProvider: 'openai',
          defaultEmbedModel: 'text-embedding-3-small',
          providers: [{ name: 'openai', apiKey: 'sk-test' }],
        }),
        'utf-8',
      );
      const manager = new XdbConfigManager(configPath);
      await executeConfig({ json: true }, manager);

      const parsed = JSON.parse(stdoutOutput.trim());
      expect(parsed.embed).toHaveProperty('provider', 'openai');
      expect(parsed.embed).toHaveProperty('model', 'text-embedding-3-small');
      expect(parsed.embed).toHaveProperty('baseUrl');
      expect(parsed.embed).toHaveProperty('hasApiKey', true);
    });

    it('hasApiKey is false when no key configured', async () => {
      await fs.writeFile(
        configPath,
        JSON.stringify({
          defaultEmbedProvider: 'openai',
          defaultEmbedModel: 'text-embedding-3-small',
          providers: [],
        }),
        'utf-8',
      );
      const manager = new XdbConfigManager(configPath);
      await executeConfig({ json: true }, manager);

      const parsed = JSON.parse(stdoutOutput.trim());
      expect(parsed.embed.hasApiKey).toBe(false);
    });
  });
});

describe('executeConfigEmbed', () => {
  let stdoutOutput: string;
  let tmpDir: string;
  let configPath: string;

  beforeEach(async () => {
    stdoutOutput = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutOutput += String(chunk);
      return true;
    });
    tmpDir = await makeTempDir();
    configPath = path.join(tmpDir, 'default.json');
    // Write base config
    await fs.writeFile(
      configPath,
      JSON.stringify({
        defaultEmbedProvider: 'openai',
        defaultEmbedModel: 'text-embedding-3-small',
        providers: [{ name: 'openai', apiKey: 'sk-test' }],
      }),
      'utf-8',
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('--set-provider', () => {
    it('saves updated provider to config', async () => {
      const manager = new XdbConfigManager(configPath);
      await executeConfigEmbed({ setProvider: 'azure-openai' }, manager);

      const loaded = await manager.load();
      expect(loaded.defaultEmbedProvider).toBe('azure-openai');
      expect(stdoutOutput).toContain('azure-openai');
    });
  });

  describe('--set-model', () => {
    it('saves updated model to config', async () => {
      const manager = new XdbConfigManager(configPath);
      await executeConfigEmbed({ setModel: 'text-embedding-3-large' }, manager);

      const loaded = await manager.load();
      expect(loaded.defaultEmbedModel).toBe('text-embedding-3-large');
    });
  });

  describe('--set-key', () => {
    it('saves api key for current provider', async () => {
      const manager = new XdbConfigManager(configPath);
      await executeConfigEmbed({ setKey: 'sk-new-key' }, manager);

      const loaded = await manager.load();
      const provider = loaded.providers.find((p) => p.name === 'openai');
      expect(provider?.apiKey).toBe('sk-new-key');
    });

    it('throws PARAMETER_ERROR when no provider configured', async () => {
      await fs.writeFile(configPath, JSON.stringify({ providers: [] }), 'utf-8');
      const manager = new XdbConfigManager(configPath);

      await expect(executeConfigEmbed({ setKey: 'sk-test' }, manager)).rejects.toMatchObject({
        exitCode: PARAMETER_ERROR,
      });
    });
  });

  describe('--set-base-url', () => {
    it('saves base url for current provider', async () => {
      const manager = new XdbConfigManager(configPath);
      await executeConfigEmbed({ setBaseUrl: 'https://my.api.com' }, manager);

      const loaded = await manager.load();
      const provider = loaded.providers.find((p) => p.name === 'openai');
      expect(provider?.baseUrl).toBe('https://my.api.com');
    });

    it('throws PARAMETER_ERROR when no provider configured', async () => {
      await fs.writeFile(configPath, JSON.stringify({ providers: [] }), 'utf-8');
      const manager = new XdbConfigManager(configPath);

      await expect(executeConfigEmbed({ setBaseUrl: 'https://x.com' }, manager)).rejects.toMatchObject({
        exitCode: PARAMETER_ERROR,
      });
    });
  });
});
