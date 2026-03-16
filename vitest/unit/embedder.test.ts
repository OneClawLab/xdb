import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Embedder } from '../../src/embedder.js';
import { XDBError, RUNTIME_ERROR, PARAMETER_ERROR } from '../../src/errors.js';
import type { XdbConfigManager } from '../../src/config-manager.js';

// Mock EmbeddingClient
const mockEmbed = vi.fn();
vi.mock('../../src/embedding-client.js', () => ({
  EmbeddingClient: vi.fn().mockImplementation(() => ({
    embed: mockEmbed,
  })),
}));

/** Build a minimal XdbConfigManager mock */
function makeConfigManager(overrides?: Partial<{
  provider: string;
  model: string;
  baseUrl?: string;
  api?: string;
  apiKey: string;
}>): XdbConfigManager {
  const cfg = {
    provider: 'openai',
    model: 'text-embedding-3-small',
    apiKey: 'sk-test',
    providerConfig: {
      name: overrides?.provider ?? 'openai',
      baseUrl: overrides?.baseUrl,
      api: overrides?.api,
    },
    ...overrides,
  };
  return {
    resolveEmbedConfig: vi.fn().mockResolvedValue({
      provider: cfg.provider,
      model: cfg.model,
      apiKey: cfg.apiKey,
      providerConfig: cfg.providerConfig,
    }),
  } as unknown as XdbConfigManager;
}

describe('Embedder', () => {
  let configManager: XdbConfigManager;
  let embedder: Embedder;

  beforeEach(() => {
    vi.clearAllMocks();
    configManager = makeConfigManager();
    embedder = new Embedder(configManager);
  });

  describe('embed(text)', () => {
    it('should call EmbeddingClient.embed with the text and return number[]', async () => {
      const vector = [0.1, 0.2, 0.3];
      mockEmbed.mockResolvedValue({
        embeddings: [vector],
        model: 'text-embedding-3-small',
        usage: { promptTokens: 1, totalTokens: 1 },
      });

      const result = await embedder.embed('hello world');

      expect(result).toEqual(vector);
      expect(mockEmbed).toHaveBeenCalledWith({
        texts: ['hello world'],
        model: 'text-embedding-3-small',
      });
    });

    it('should return number[] directly (not hex strings)', async () => {
      const vector = [0.5, -0.5, 1.0];
      mockEmbed.mockResolvedValue({
        embeddings: [vector],
        model: 'text-embedding-3-small',
        usage: { promptTokens: 1, totalTokens: 1 },
      });

      const result = await embedder.embed('test');

      expect(Array.isArray(result)).toBe(true);
      for (const v of result) {
        expect(typeof v).toBe('number');
      }
    });

    it('should handle high-dimensional vectors', async () => {
      const vector = Array.from({ length: 384 }, (_, i) => i * 0.001);
      mockEmbed.mockResolvedValue({
        embeddings: [vector],
        model: 'text-embedding-3-small',
        usage: { promptTokens: 1, totalTokens: 1 },
      });

      const result = await embedder.embed('test');
      expect(result).toHaveLength(384);
    });
  });

  describe('embedBatch(texts)', () => {
    it('should call EmbeddingClient.embed with all texts and return number[][]', async () => {
      const embeddings = [[0.1, 0.2], [0.3, 0.4]];
      mockEmbed.mockResolvedValue({
        embeddings,
        model: 'text-embedding-3-small',
        usage: { promptTokens: 2, totalTokens: 2 },
      });

      const result = await embedder.embedBatch(['hello', 'world']);

      expect(result).toEqual(embeddings);
      expect(mockEmbed).toHaveBeenCalledWith({
        texts: ['hello', 'world'],
        model: 'text-embedding-3-small',
      });
    });

    it('should handle single-item batch', async () => {
      mockEmbed.mockResolvedValue({
        embeddings: [[0.1, 0.2]],
        model: 'text-embedding-3-small',
        usage: { promptTokens: 1, totalTokens: 1 },
      });

      const result = await embedder.embedBatch(['single']);
      expect(result).toHaveLength(1);
    });

    it('should handle empty batch', async () => {
      mockEmbed.mockResolvedValue({
        embeddings: [],
        model: 'text-embedding-3-small',
        usage: { promptTokens: 0, totalTokens: 0 },
      });

      const result = await embedder.embedBatch([]);
      expect(result).toEqual([]);
    });
  });

  describe('error handling', () => {
    it('should re-throw XDBError from EmbeddingClient', async () => {
      const xdbErr = new XDBError(RUNTIME_ERROR, 'API error');
      mockEmbed.mockRejectedValue(xdbErr);

      await expect(embedder.embed('test')).rejects.toThrow(XDBError);
      await expect(embedder.embed('test')).rejects.toMatchObject({ exitCode: RUNTIME_ERROR });
    });

    it('should wrap non-XDBError as XDBError(RUNTIME_ERROR)', async () => {
      mockEmbed.mockRejectedValue(new Error('network timeout'));

      await expect(embedder.embed('test')).rejects.toThrow(XDBError);
      await expect(embedder.embed('test')).rejects.toMatchObject({ exitCode: RUNTIME_ERROR });
    });

    it('should throw XDBError(PARAMETER_ERROR) when config not set', async () => {
      const badConfig = {
        resolveEmbedConfig: vi.fn().mockRejectedValue(
          new XDBError(PARAMETER_ERROR, 'No embed provider configured'),
        ),
      } as unknown as XdbConfigManager;
      const e = new Embedder(badConfig);

      await expect(e.embed('test')).rejects.toMatchObject({ exitCode: PARAMETER_ERROR });
    });

    it('should throw XDBError for batch errors too', async () => {
      mockEmbed.mockRejectedValue(new Error('timeout'));

      await expect(embedder.embedBatch(['a', 'b'])).rejects.toThrow(XDBError);
      await expect(embedder.embedBatch(['a', 'b'])).rejects.toMatchObject({ exitCode: RUNTIME_ERROR });
    });
  });
});
