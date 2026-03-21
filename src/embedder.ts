import { XDBError, RUNTIME_ERROR } from './errors.js';
import { EmbeddingClient } from './embedding-client.js';
import { XdbConfigManager } from './config-manager.js';

/**
 * Internal embedder that calls EmbeddingClient directly.
 * Returns number[] / number[][] — no hex encoding.
 */
export class Embedder {
  private readonly configManager: XdbConfigManager;

  constructor(configManager?: XdbConfigManager) {
    this.configManager = configManager ?? new XdbConfigManager();
  }

  /**
   * Embed a single text string into a vector.
   * Returns number[] directly (no hex encoding).
   */
  async embed(text: string): Promise<number[]> {
    const { model, providerConfig, apiKey } = await this.configManager.resolveEmbedConfig();
    const client = new EmbeddingClient({
      provider: providerConfig.name,
      apiKey,
      model,
      ...(providerConfig.baseUrl !== undefined ? { baseUrl: providerConfig.baseUrl } : {}),
      ...(providerConfig.api !== undefined ? { api: providerConfig.api } : {}),
      ...(providerConfig.providerOptions !== undefined ? { providerOptions: providerConfig.providerOptions } : {}),
    });
    try {
      const response = await client.embed({ texts: [text], model });
      return response.embeddings[0]!;
    } catch (err) {
      if (err instanceof XDBError) throw err;
      throw new XDBError(RUNTIME_ERROR, `Embedding failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Embed multiple texts in a single batch call.
   * Returns number[][] directly (no hex encoding).
   */
  async embedBatch(texts: string[]): Promise<number[][]> {
    const { model, providerConfig, apiKey } = await this.configManager.resolveEmbedConfig();
    const client = new EmbeddingClient({
      provider: providerConfig.name,
      apiKey,
      model,
      ...(providerConfig.baseUrl !== undefined ? { baseUrl: providerConfig.baseUrl } : {}),
      ...(providerConfig.api !== undefined ? { api: providerConfig.api } : {}),
      ...(providerConfig.providerOptions !== undefined ? { providerOptions: providerConfig.providerOptions } : {}),
    });
    try {
      const response = await client.embed({ texts, model });
      return response.embeddings;
    } catch (err) {
      if (err instanceof XDBError) throw err;
      throw new XDBError(RUNTIME_ERROR, `Embedding failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
