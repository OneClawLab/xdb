import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { XDBError, PARAMETER_ERROR, RUNTIME_ERROR } from './errors.js';

export interface XdbProviderConfig {
  name: string;
  apiKey?: string;
  baseUrl?: string;
  api?: string; // e.g. 'azure-openai'
  providerOptions?: Record<string, unknown>;
}

export interface XdbConfig {
  defaultEmbedProvider?: string;
  defaultEmbedModel?: string;
  providers: XdbProviderConfig[];
}

/** Minimal shape of pai's config file we care about for embed fallback */
interface PaiConfig {
  defaultEmbedProvider?: string;
  defaultEmbedModel?: string;
  providers?: Array<{
    name: string;
    apiKey?: string;
    baseUrl?: string;
    api?: string;
    providerOptions?: Record<string, unknown>;
    oauth?: unknown;
  }>;
}

const DEFAULT_CONFIG_PATH = path.join(os.homedir(), 'config', 'xdb', 'default.json');
const PAI_CONFIG_PATH = path.join(os.homedir(), 'config', 'pai', 'default.json');

const EMPTY_CONFIG: XdbConfig = {
  providers: [],
};

export class XdbConfigManager {
  private readonly configPath: string;

  constructor(configPath?: string) {
    this.configPath = configPath ?? DEFAULT_CONFIG_PATH;
  }

  async load(): Promise<XdbConfig> {
    let raw: string;
    try {
      raw = await fs.readFile(this.configPath, 'utf-8');
    } catch (err: unknown) {
      // File not found → return empty default config
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { ...EMPTY_CONFIG, providers: [] };
      }
      throw new XDBError(RUNTIME_ERROR, `Failed to read config file: ${(err as Error).message}`);
    }

    try {
      const parsed = JSON.parse(raw) as XdbConfig;
      // Ensure providers array exists
      if (!Array.isArray(parsed.providers)) {
        parsed.providers = [];
      }
      return parsed;
    } catch {
      throw new XDBError(RUNTIME_ERROR, `Config file contains invalid JSON: ${this.configPath}`);
    }
  }

  async save(config: XdbConfig): Promise<void> {
    const dir = path.dirname(this.configPath);
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch (err: unknown) {
      throw new XDBError(RUNTIME_ERROR, `Failed to create config directory: ${(err as Error).message}`);
    }

    try {
      await fs.writeFile(this.configPath, JSON.stringify(config, null, 2), 'utf-8');
    } catch (err: unknown) {
      throw new XDBError(RUNTIME_ERROR, `Failed to write config file: ${(err as Error).message}`);
    }
  }

  /**
   * Resolve API key for a provider.
   * Priority: XDB_<PROVIDER>_API_KEY env var > config file apiKey
   */
  async resolveApiKey(providerName: string): Promise<string> {
    // Build env var name: uppercase, hyphens → underscores, prefix XDB_, suffix _API_KEY
    const envVarName = `XDB_${providerName.toUpperCase().replace(/-/g, '_')}_API_KEY`;
    const envValue = process.env[envVarName];
    if (envValue) {
      return envValue;
    }

    const config = await this.load();
    const providerConfig = config.providers.find((p) => p.name === providerName);
    if (providerConfig?.apiKey) {
      return providerConfig.apiKey;
    }

    throw new XDBError(
      PARAMETER_ERROR,
      `No API key found for provider "${providerName}". ` +
        `Set the ${envVarName} environment variable or run: xdb config embed --set-key <apiKey>`,
    );
  }

  /**
   * Try to load pai's config as an embed fallback.
   * Returns null if pai config doesn't exist or has no embed settings.
   */
  private async loadPaiFallback(): Promise<{ provider: string; model: string; providerConfig: XdbProviderConfig; apiKey: string } | null> {
    let raw: string;
    try {
      raw = await fs.readFile(PAI_CONFIG_PATH, 'utf-8');
    } catch {
      return null;
    }

    let pai: PaiConfig;
    try {
      pai = JSON.parse(raw) as PaiConfig;
    } catch {
      return null;
    }

    const provider = pai.defaultEmbedProvider;
    const model = pai.defaultEmbedModel;
    if (!provider || !model) return null;

    const paiProvider = pai.providers?.find((p) => p.name === provider);
    if (!paiProvider) return null;

    // pai OAuth providers don't have a usable apiKey for embedding — skip them
    if (!paiProvider.apiKey) return null;

    const providerConfig: XdbProviderConfig = {
      name: paiProvider.name,
      apiKey: paiProvider.apiKey,
      baseUrl: paiProvider.baseUrl,
      api: paiProvider.api,
      providerOptions: paiProvider.providerOptions,
    };

    return { provider, model, providerConfig, apiKey: paiProvider.apiKey };
  }

  /**
   * Resolve the current embed configuration (provider + model + providerConfig + apiKey).
   * Priority:
   *   1. xdb's own config (~/.config/xdb/default.json or XDB_* env vars)
   *   2. pai's config (~/.config/pai/default.json) as fallback
   * Throws XDBError(PARAMETER_ERROR) if neither source has embed config.
   */
  async resolveEmbedConfig(): Promise<{
    provider: string;
    model: string;
    providerConfig: XdbProviderConfig;
    apiKey: string;
  }> {
    const config = await this.load();

    const provider = config.defaultEmbedProvider;
    const model = config.defaultEmbedModel;

    if (provider && model) {
      const providerConfig = config.providers.find((p) => p.name === provider) ?? { name: provider };
      const apiKey = await this.resolveApiKey(provider);
      return { provider, model, providerConfig, apiKey };
    }

    // Fallback: try pai config
    const paiFallback = await this.loadPaiFallback();
    if (paiFallback) {
      return paiFallback;
    }

    throw new XDBError(
      PARAMETER_ERROR,
      'No embed provider configured. Run: xdb config embed --set-provider <name>\n' +
      'Or configure pai embed settings: pai model default --embed-provider <name> --embed-model <model>',
    );
  }
}
