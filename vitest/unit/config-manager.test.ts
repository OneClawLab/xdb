import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { XdbConfigManager } from '../../src/config-manager.js';
import { XDBError, PARAMETER_ERROR, RUNTIME_ERROR } from '../../src/errors.js';

/** Create a temp dir for each test */
async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'xdb-config-test-'));
}

describe('XdbConfigManager', () => {
  let tmpDir: string;
  let configPath: string;
  // Use a non-existent pai config path so the pai fallback never fires in tests
  const noPaiConfig = '/nonexistent/pai/default.json';

  beforeEach(async () => {
    tmpDir = await makeTempDir();
    configPath = path.join(tmpDir, 'default.json');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // ---- load() ----

  describe('load()', () => {
    it('returns empty default config when file does not exist', async () => {
      const mgr = new XdbConfigManager(configPath);
      const cfg = await mgr.load();
      expect(cfg.providers).toEqual([]);
      expect(cfg.defaultEmbedProvider).toBeUndefined();
      expect(cfg.defaultEmbedModel).toBeUndefined();
    });

    it('returns parsed config when file exists', async () => {
      const data = {
        defaultEmbedProvider: 'openai',
        defaultEmbedModel: 'text-embedding-3-small',
        providers: [{ name: 'openai', apiKey: 'sk-test' }],
      };
      await fs.writeFile(configPath, JSON.stringify(data), 'utf-8');

      const mgr = new XdbConfigManager(configPath);
      const cfg = await mgr.load();
      expect(cfg.defaultEmbedProvider).toBe('openai');
      expect(cfg.defaultEmbedModel).toBe('text-embedding-3-small');
      expect(cfg.providers).toHaveLength(1);
      expect(cfg.providers[0]!.apiKey).toBe('sk-test');
    });

    it('throws RUNTIME_ERROR for invalid JSON', async () => {
      await fs.writeFile(configPath, 'not valid json', 'utf-8');

      const mgr = new XdbConfigManager(configPath);
      await expect(mgr.load()).rejects.toMatchObject({
        exitCode: RUNTIME_ERROR,
      });
    });

    it('normalises missing providers array to []', async () => {
      await fs.writeFile(configPath, JSON.stringify({ defaultEmbedProvider: 'openai' }), 'utf-8');

      const mgr = new XdbConfigManager(configPath);
      const cfg = await mgr.load();
      expect(Array.isArray(cfg.providers)).toBe(true);
    });
  });

  // ---- save() ----

  describe('save()', () => {
    it('creates directory automatically', async () => {
      const nestedPath = path.join(tmpDir, 'a', 'b', 'c', 'default.json');
      const mgr = new XdbConfigManager(nestedPath);
      await mgr.save({ providers: [] });

      const stat = await fs.stat(nestedPath);
      expect(stat.isFile()).toBe(true);
    });

    it('persists config that can be loaded back', async () => {
      const mgr = new XdbConfigManager(configPath);
      const original = {
        defaultEmbedProvider: 'openai',
        defaultEmbedModel: 'text-embedding-3-small',
        providers: [{ name: 'openai', apiKey: 'sk-abc' }],
      };
      await mgr.save(original);
      const loaded = await mgr.load();
      expect(loaded).toEqual(original);
    });
  });

  // ---- resolveApiKey() ----

  describe('resolveApiKey()', () => {
    it('returns env var value when XDB_<PROVIDER>_API_KEY is set', async () => {
      process.env['XDB_OPENAI_API_KEY'] = 'env-key-123';
      try {
        const mgr = new XdbConfigManager(configPath);
        const key = await mgr.resolveApiKey('openai');
        expect(key).toBe('env-key-123');
      } finally {
        delete process.env['XDB_OPENAI_API_KEY'];
      }
    });

    it('env var takes priority over config file apiKey', async () => {
      process.env['XDB_OPENAI_API_KEY'] = 'env-wins';
      try {
        await fs.writeFile(
          configPath,
          JSON.stringify({ providers: [{ name: 'openai', apiKey: 'config-key' }] }),
          'utf-8',
        );
        const mgr = new XdbConfigManager(configPath);
        const key = await mgr.resolveApiKey('openai');
        expect(key).toBe('env-wins');
      } finally {
        delete process.env['XDB_OPENAI_API_KEY'];
      }
    });

    it('falls back to config file apiKey when env var absent', async () => {
      delete process.env['XDB_OPENAI_API_KEY'];
      await fs.writeFile(
        configPath,
        JSON.stringify({ providers: [{ name: 'openai', apiKey: 'config-key' }] }),
        'utf-8',
      );
      const mgr = new XdbConfigManager(configPath);
      const key = await mgr.resolveApiKey('openai');
      expect(key).toBe('config-key');
    });

    it('throws PARAMETER_ERROR when no key found', async () => {
      delete process.env['XDB_OPENAI_API_KEY'];
      const mgr = new XdbConfigManager(configPath);
      await expect(mgr.resolveApiKey('openai')).rejects.toMatchObject({
        exitCode: PARAMETER_ERROR,
      });
    });

    it('handles hyphenated provider names (azure-openai → XDB_AZURE_OPENAI_API_KEY)', async () => {
      process.env['XDB_AZURE_OPENAI_API_KEY'] = 'azure-env-key';
      try {
        const mgr = new XdbConfigManager(configPath);
        const key = await mgr.resolveApiKey('azure-openai');
        expect(key).toBe('azure-env-key');
      } finally {
        delete process.env['XDB_AZURE_OPENAI_API_KEY'];
      }
    });
  });

  // ---- resolveEmbedConfig() ----

  describe('resolveEmbedConfig()', () => {
    it('throws PARAMETER_ERROR when defaultEmbedProvider not set', async () => {
      const mgr = new XdbConfigManager(configPath, noPaiConfig);
      await expect(mgr.resolveEmbedConfig()).rejects.toMatchObject({
        exitCode: PARAMETER_ERROR,
      });
    });

    it('throws PARAMETER_ERROR when defaultEmbedModel not set', async () => {
      await fs.writeFile(
        configPath,
        JSON.stringify({ defaultEmbedProvider: 'openai', providers: [] }),
        'utf-8',
      );
      const mgr = new XdbConfigManager(configPath, noPaiConfig);
      await expect(mgr.resolveEmbedConfig()).rejects.toMatchObject({
        exitCode: PARAMETER_ERROR,
      });
    });

    it('returns full embed config when everything is set', async () => {
      process.env['XDB_OPENAI_API_KEY'] = 'sk-resolve-test';
      try {
        await fs.writeFile(
          configPath,
          JSON.stringify({
            defaultEmbedProvider: 'openai',
            defaultEmbedModel: 'text-embedding-3-small',
            providers: [{ name: 'openai' }],
          }),
          'utf-8',
        );
        const mgr = new XdbConfigManager(configPath, noPaiConfig);
        const result = await mgr.resolveEmbedConfig();
        expect(result.provider).toBe('openai');
        expect(result.model).toBe('text-embedding-3-small');
        expect(result.apiKey).toBe('sk-resolve-test');
        expect(result.providerConfig.name).toBe('openai');
      } finally {
        delete process.env['XDB_OPENAI_API_KEY'];
      }
    });
  });
});
