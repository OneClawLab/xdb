import { describe, it, expect, vi, afterEach } from 'vitest';
import { EmbeddingClient } from '../../src/embedding-client.js';
import { XDBError, PARAMETER_ERROR, RUNTIME_ERROR } from '../../src/errors.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockFetchResponse(body: object, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response);
}

function makeOpenAIResponse(embeddings: number[][], model = 'text-embedding-3-small') {
  return {
    object: 'list',
    data: embeddings.map((emb, i) => ({ object: 'embedding', index: i, embedding: emb })),
    model,
    usage: { prompt_tokens: 2, total_tokens: 2 },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EmbeddingClient', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // ---- resolveEndpoint ----

  describe('resolveEndpoint', () => {
    it('should use baseUrl when provided', () => {
      const url = EmbeddingClient.resolveEndpoint('openai', 'https://custom.example.com');
      expect(url).toBe('https://custom.example.com/v1/embeddings');
    });

    it('should strip trailing slash from baseUrl', () => {
      const url = EmbeddingClient.resolveEndpoint('openai', 'https://custom.example.com/');
      expect(url).toBe('https://custom.example.com/v1/embeddings');
    });

    it('should use provider default for openai when no baseUrl', () => {
      const url = EmbeddingClient.resolveEndpoint('openai');
      expect(url).toBe('https://api.openai.com/v1/embeddings');
    });

    it('should throw XDBError(PARAMETER_ERROR) for unknown provider without baseUrl', () => {
      expect(() => EmbeddingClient.resolveEndpoint('azure-openai')).toThrow(XDBError);
      try {
        EmbeddingClient.resolveEndpoint('azure-openai');
      } catch (e) {
        expect(e).toBeInstanceOf(XDBError);
        expect((e as XDBError).exitCode).toBe(PARAMETER_ERROR);
      }
    });
  });

  // ---- embed() success ----

  describe('embed – success', () => {
    it('should return embeddings for a single text', async () => {
      globalThis.fetch = mockFetchResponse(makeOpenAIResponse([[0.1, 0.2, 0.3]]));

      const client = new EmbeddingClient({
        provider: 'openai',
        apiKey: 'sk-test',
        model: 'text-embedding-3-small',
      });

      const result = await client.embed({ texts: ['hello'], model: 'text-embedding-3-small' });

      expect(result.embeddings).toEqual([[0.1, 0.2, 0.3]]);
      expect(result.model).toBe('text-embedding-3-small');
      expect(result.usage.promptTokens).toBe(2);
      expect(result.usage.totalTokens).toBe(2);
    });

    it('should return embeddings for multiple texts in order', async () => {
      globalThis.fetch = mockFetchResponse(makeOpenAIResponse([[0.1], [0.2], [0.3]]));

      const client = new EmbeddingClient({
        provider: 'openai',
        apiKey: 'sk-test',
        model: 'text-embedding-3-small',
      });

      const result = await client.embed({ texts: ['a', 'b', 'c'], model: 'text-embedding-3-small' });
      expect(result.embeddings).toEqual([[0.1], [0.2], [0.3]]);
    });

    it('should sort response data by index', async () => {
      const apiResponse = {
        object: 'list',
        data: [
          { object: 'embedding', index: 2, embedding: [0.3] },
          { object: 'embedding', index: 0, embedding: [0.1] },
          { object: 'embedding', index: 1, embedding: [0.2] },
        ],
        model: 'text-embedding-3-small',
        usage: { prompt_tokens: 3, total_tokens: 3 },
      };
      globalThis.fetch = mockFetchResponse(apiResponse);

      const client = new EmbeddingClient({
        provider: 'openai',
        apiKey: 'sk-test',
        model: 'text-embedding-3-small',
      });

      const result = await client.embed({ texts: ['a', 'b', 'c'], model: 'text-embedding-3-small' });
      expect(result.embeddings).toEqual([[0.1], [0.2], [0.3]]);
    });

    it('should send correct request headers and body', async () => {
      const fetchMock = mockFetchResponse(makeOpenAIResponse([[0.1]]));
      globalThis.fetch = fetchMock;

      const client = new EmbeddingClient({
        provider: 'openai',
        apiKey: 'sk-test-key',
        model: 'text-embedding-3-small',
      });

      await client.embed({ texts: ['hello'], model: 'text-embedding-3-small' });

      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, options] = fetchMock.mock.calls[0]!;
      expect(url).toBe('https://api.openai.com/v1/embeddings');
      expect(options.method).toBe('POST');
      expect(options.headers['Authorization']).toBe('Bearer sk-test-key');
      expect(options.headers['Content-Type']).toBe('application/json');
      expect(JSON.parse(options.body)).toEqual({
        model: 'text-embedding-3-small',
        input: ['hello'],
      });
    });

    it('should use api-key header for Azure', async () => {
      const fetchMock = mockFetchResponse(makeOpenAIResponse([[0.1]]));
      globalThis.fetch = fetchMock;

      const client = new EmbeddingClient({
        provider: 'azure-openai',
        apiKey: 'azure-key',
        model: 'text-embedding-3-small',
        baseUrl: 'https://my-resource.openai.azure.com',
        api: 'azure-openai',
      });

      await client.embed({ texts: ['hello'], model: 'text-embedding-3-small' });

      const [, options] = fetchMock.mock.calls[0]!;
      expect(options.headers['api-key']).toBe('azure-key');
      expect(options.headers['Authorization']).toBeUndefined();
    });
  });

  // ---- embed() API errors ----

  describe('embed – API errors', () => {
    it('should throw XDBError(RUNTIME_ERROR) for 401', async () => {
      globalThis.fetch = mockFetchResponse({ error: { message: 'Invalid API key' } }, 401);

      const client = new EmbeddingClient({
        provider: 'openai',
        apiKey: 'bad-key',
        model: 'text-embedding-3-small',
      });

      await expect(client.embed({ texts: ['hi'], model: 'text-embedding-3-small' }))
        .rejects.toThrow(XDBError);

      try {
        await client.embed({ texts: ['hi'], model: 'text-embedding-3-small' });
      } catch (e) {
        expect(e).toBeInstanceOf(XDBError);
        expect((e as XDBError).exitCode).toBe(RUNTIME_ERROR);
        expect((e as XDBError).message).toContain('401');
      }
    });

    it('should throw XDBError(RUNTIME_ERROR) for 500', async () => {
      globalThis.fetch = mockFetchResponse({ error: { message: 'Internal error' } }, 500);

      const client = new EmbeddingClient({
        provider: 'openai',
        apiKey: 'sk-test',
        model: 'text-embedding-3-small',
      });

      try {
        await client.embed({ texts: ['hi'], model: 'text-embedding-3-small' });
      } catch (e) {
        expect(e).toBeInstanceOf(XDBError);
        expect((e as XDBError).exitCode).toBe(RUNTIME_ERROR);
        expect((e as XDBError).message).toContain('500');
      }
    });

    it('should throw XDBError(RUNTIME_ERROR) for 429 rate limit', async () => {
      globalThis.fetch = mockFetchResponse({ error: { message: 'Rate limit exceeded' } }, 429);

      const client = new EmbeddingClient({
        provider: 'openai',
        apiKey: 'sk-test',
        model: 'text-embedding-3-small',
      });

      try {
        await client.embed({ texts: ['hi'], model: 'text-embedding-3-small' });
      } catch (e) {
        expect(e).toBeInstanceOf(XDBError);
        expect((e as XDBError).exitCode).toBe(RUNTIME_ERROR);
      }
    });
  });

  // ---- embed() network errors ----

  describe('embed – network errors', () => {
    it('should throw XDBError(RUNTIME_ERROR) on fetch failure', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed'));

      const client = new EmbeddingClient({
        provider: 'openai',
        apiKey: 'sk-test',
        model: 'text-embedding-3-small',
      });

      try {
        await client.embed({ texts: ['hi'], model: 'text-embedding-3-small' });
      } catch (e) {
        expect(e).toBeInstanceOf(XDBError);
        expect((e as XDBError).exitCode).toBe(RUNTIME_ERROR);
        expect((e as XDBError).message).toContain('Network error');
      }
    });

    it('should throw XDBError(RUNTIME_ERROR) on connection refused', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

      const client = new EmbeddingClient({
        provider: 'openai',
        apiKey: 'sk-test',
        model: 'text-embedding-3-small',
        baseUrl: 'http://localhost:9999',
      });

      try {
        await client.embed({ texts: ['hi'], model: 'text-embedding-3-small' });
      } catch (e) {
        expect(e).toBeInstanceOf(XDBError);
        expect((e as XDBError).exitCode).toBe(RUNTIME_ERROR);
        expect((e as XDBError).message).toContain('ECONNREFUSED');
      }
    });
  });

  // ---- custom baseUrl ----

  describe('custom baseUrl', () => {
    it('should call the custom endpoint', async () => {
      const fetchMock = mockFetchResponse(makeOpenAIResponse([[0.5]]));
      globalThis.fetch = fetchMock;

      const client = new EmbeddingClient({
        provider: 'custom',
        apiKey: 'sk-custom',
        model: 'my-model',
        baseUrl: 'https://my-proxy.example.com',
      });

      await client.embed({ texts: ['test'], model: 'my-model' });

      const [url] = fetchMock.mock.calls[0]!;
      expect(url).toBe('https://my-proxy.example.com/v1/embeddings');
    });
  });
});
