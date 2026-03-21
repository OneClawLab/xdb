/**
 * Feature: embed-service
 * Properties 1, 2, 3, 8: XdbConfig 序列化/凭证解析属性测试
 *
 * Validates: Requirements 1.2, 1.3, 1.4, 1.6, 2.1, 2.3, 2.4, 4.1, 4.2
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { XdbConfigManager } from '../../src/config-manager.js';
import type { XdbConfig } from '../../src/config-manager.js';
import { XDBError, RUNTIME_ERROR } from '../../src/errors.js';

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

const providerNameArb = fc
  .string({ minLength: 1, maxLength: 30 })
  .filter((s) => /^[a-zA-Z][a-zA-Z0-9-_]*$/.test(s));

const optionalStringArb = fc.option(fc.string({ minLength: 1, maxLength: 100 }), { nil: undefined });

const providerConfigArb = fc
  .tuple(
    providerNameArb,
    optionalStringArb,
    optionalStringArb,
    optionalStringArb,
  )
  .map(([name, apiKey, baseUrl, api]) => {
    const cfg: { name: string; apiKey?: string; baseUrl?: string; api?: string } = { name };
    if (apiKey !== undefined) cfg.apiKey = apiKey;
    if (baseUrl !== undefined) cfg.baseUrl = baseUrl;
    if (api !== undefined) cfg.api = api;
    return cfg;
  });

const xdbConfigArb: fc.Arbitrary<XdbConfig> = fc
  .tuple(
    optionalStringArb,
    optionalStringArb,
    fc.array(providerConfigArb, { minLength: 0, maxLength: 5 }),
  )
  .map(([defaultEmbedProvider, defaultEmbedModel, providers]) => {
    const config: XdbConfig = { providers };
    if (defaultEmbedProvider !== undefined) config.defaultEmbedProvider = defaultEmbedProvider;
    if (defaultEmbedModel !== undefined) config.defaultEmbedModel = defaultEmbedModel;
    return config;
  });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'xdb-pbt-'));
}

// ---------------------------------------------------------------------------
// Property 1: XdbConfig 序列化 round-trip
// ---------------------------------------------------------------------------

describe('Property 1: XdbConfig 序列化 round-trip', () => {
  // Feature: embed-service, Property 1: XdbConfig 序列化 round-trip
  // Validates: Requirements 1.2, 1.3, 1.4

  it('save then load returns equivalent config (all fields preserved)', async () => {
    await fc.assert(
      fc.asyncProperty(xdbConfigArb, async (config) => {
        const tmpDir = await makeTempDir();
        const configPath = path.join(tmpDir, 'default.json');
        try {
          const mgr = new XdbConfigManager(configPath);
          await mgr.save(config);
          const loaded = await mgr.load();

          expect(loaded.defaultEmbedProvider).toBe(config.defaultEmbedProvider);
          expect(loaded.defaultEmbedModel).toBe(config.defaultEmbedModel);
          expect(loaded.providers).toHaveLength(config.providers.length);

          for (let i = 0; i < config.providers.length; i++) {
            const orig = config.providers[i]!;
            const got = loaded.providers[i]!;
            expect(got.name).toBe(orig.name);
            expect(got.apiKey).toBe(orig.apiKey);
            expect(got.baseUrl).toBe(orig.baseUrl);
            expect(got.api).toBe(orig.api);
          }
        } finally {
          await fs.rm(tmpDir, { recursive: true, force: true });
        }
      }),
      { numRuns: 50 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 2: 非法 JSON 配置文件总是返回错误
// ---------------------------------------------------------------------------

describe('Property 2: 非法 JSON 配置文件总是返回错误', () => {
  // Feature: embed-service, Property 2: 非法 JSON 配置文件总是返回错误
  // Validates: Requirements 1.6

  it('any non-JSON string as config file always throws RUNTIME_ERROR', async () => {
    const invalidJsonArb = fc.string({ minLength: 1 }).filter((s) => {
      try {
        JSON.parse(s);
        return false;
      } catch {
        return true;
      }
    });

    await fc.assert(
      fc.asyncProperty(invalidJsonArb, async (badContent) => {
        const tmpDir = await makeTempDir();
        const configPath = path.join(tmpDir, 'default.json');
        try {
          await fs.writeFile(configPath, badContent, 'utf-8');
          const mgr = new XdbConfigManager(configPath);
          await expect(mgr.load()).rejects.toMatchObject({ exitCode: RUNTIME_ERROR });
        } finally {
          await fs.rm(tmpDir, { recursive: true, force: true });
        }
      }),
      { numRuns: 50 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 3: embed 配置写入 round-trip
// ---------------------------------------------------------------------------

describe('Property 3: embed 配置写入 round-trip', () => {
  // Feature: embed-service, Property 3: embed 配置写入 round-trip
  // Validates: Requirements 2.1, 2.3, 2.4

  it('writing provider and model then loading returns same values', async () => {
    await fc.assert(
      fc.asyncProperty(
        providerNameArb,
        fc.string({ minLength: 1, maxLength: 50 }),
        async (provider, model) => {
          const tmpDir = await makeTempDir();
          const configPath = path.join(tmpDir, 'default.json');
          try {
            const mgr = new XdbConfigManager(configPath);
            const cfg = await mgr.load();
            cfg.defaultEmbedProvider = provider;
            cfg.defaultEmbedModel = model;
            await mgr.save(cfg);

            const loaded = await mgr.load();
            expect(loaded.defaultEmbedProvider).toBe(provider);
            expect(loaded.defaultEmbedModel).toBe(model);
          } finally {
            await fs.rm(tmpDir, { recursive: true, force: true });
          }
        },
      ),
      { numRuns: 50 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 8: 凭证解析优先级
// ---------------------------------------------------------------------------

describe('Property 8: 凭证解析优先级', () => {
  // Feature: embed-service, Property 8: 凭证解析优先级
  // Validates: Requirements 4.1, 4.2

  it('env var XDB_<PROVIDER>_API_KEY always wins over config file apiKey', async () => {
    await fc.assert(
      fc.asyncProperty(
        providerNameArb.filter((p) => /^[A-Za-z][A-Za-z0-9]*$/.test(p)), // simple names only for env var
        fc.string({ minLength: 1, maxLength: 50 }),
        fc.string({ minLength: 1, maxLength: 50 }),
        async (provider, envKey, configKey) => {
          fc.pre(envKey !== configKey); // ensure they differ so we can tell which was used

          const envVarName = `XDB_${provider.toUpperCase()}_API_KEY`;
          const tmpDir = await makeTempDir();
          const configPath = path.join(tmpDir, 'default.json');

          process.env[envVarName] = envKey;
          try {
            await fs.writeFile(
              configPath,
              JSON.stringify({ providers: [{ name: provider, apiKey: configKey }] }),
              'utf-8',
            );
            const mgr = new XdbConfigManager(configPath);
            const resolved = await mgr.resolveApiKey(provider);
            expect(resolved).toBe(envKey);
          } finally {
            delete process.env[envVarName];
            await fs.rm(tmpDir, { recursive: true, force: true });
          }
        },
      ),
      { numRuns: 50 },
    );
  });
});
