/**
 * Feature: embed-service
 * Properties 4, 5, 6, 7: EmbeddingClient 属性测试
 *
 * Validates: Requirements 3.3, 3.5, 3.6, 3.7, 3.9
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fc from 'fast-check';
import { EmbeddingClient } from '../../src/embedding-client.js';
import { XDBError, PARAMETER_ERROR, RUNTIME_ERROR } from '../../src/errors.js';

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** Valid base URL (no trailing slash) */
const baseUrlArb = fc.webUrl({ withFragments: false, withQueryParameters: false });

/** Base URL with trailing slashes */
const baseUrlWithTrailingSlashesArb = baseUrlArb.chain((url) =>
  fc.integer({ min: 1, max: 5 }).map((n) => url.replace(/\/+$/, '') + '/'.repeat(n)),
);

/** Provider name that is NOT 'openai' (no default base URL) */
const unknownProviderArb = fc
  .string({ minLength: 1, maxLength: 30 })
  .filter((s) => /^[a-zA-Z]/.test(s))
  .filter((s) => s !== 'openai');

/** HTTP error status codes (4xx and 5xx) */
const httpErrorStatusArb = fc.oneof(
  fc.integer({ min: 400, max: 499 }),
  fc.integer({ min: 500, max: 599 }),
);

/** Valid embedding response with shuffled indices */
function makeShuffledResponse(embeddings: number[][]): object {
  const data = embeddings.map((emb, i) => ({ object: 'embedding', index: i, embedding: emb }));
  // Shuffle
  for (let i = data.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [data[i], data[j]] = [data[j]!, data[i]!];
  }
  return {
    object: 'list',
    data,
    model: 'text-embedding-3-small',
    usage: { prompt_tokens: embeddings.length, total_tokens: embeddings.length },
  };
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// Property 4: 端点 URL 构建正确性
// ---------------------------------------------------------------------------

describe('Property 4: 端点 URL 构建正确性', () => {
  // Feature: embed-service, Property 4: 端点 URL 构建正确性
  // Validates: Requirements 3.3, 3.6

  it('with any baseUrl, endpoint is always ${baseUrl.trimEnd("/")}/v1/embeddings', () => {
    fc.assert(
      fc.property(baseUrlArb, (baseUrl) => {
        const endpoint = EmbeddingClient.resolveEndpoint('any-provider', baseUrl);
        const expected = `${baseUrl.replace(/\/+$/, '')}/v1/embeddings`;
        expect(endpoint).toBe(expected);
      }),
      { numRuns: 200 },
    );
  });

  it('trailing slashes on baseUrl are stripped before appending /v1/embeddings', () => {
    fc.assert(
      fc.property(baseUrlWithTrailingSlashesArb, (baseUrl) => {
        const endpoint = EmbeddingClient.resolveEndpoint('any-provider', baseUrl);
        // Must end with /v1/embeddings
        expect(endpoint.endsWith('/v1/embeddings')).toBe(true);
        // The part before /v1/embeddings must not end with a slash
        const beforePath = endpoint.slice(0, endpoint.length - '/v1/embeddings'.length);
        expect(beforePath.endsWith('/')).toBe(false);
      }),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 5: 未知 provider 无 baseUrl 总是返回参数错误
// ---------------------------------------------------------------------------

describe('Property 5: 未知 provider 无 baseUrl 总是返回参数错误', () => {
  // Feature: embed-service, Property 5: 未知 provider 无 baseUrl 总是返回参数错误
  // Validates: Requirements 3.5

  it('unknown provider without baseUrl always throws XDBError(PARAMETER_ERROR)', () => {
    fc.assert(
      fc.property(unknownProviderArb, (provider) => {
        try {
          EmbeddingClient.resolveEndpoint(provider);
          expect.unreachable('Expected XDBError to be thrown');
        } catch (e) {
          expect(e).toBeInstanceOf(XDBError);
          expect((e as XDBError).exitCode).toBe(PARAMETER_ERROR);
        }
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 6: HTTP 错误状态码总是返回错误
// ---------------------------------------------------------------------------

describe('Property 6: HTTP 错误状态码总是返回错误', () => {
  // Feature: embed-service, Property 6: HTTP 错误状态码总是返回错误
  // Validates: Requirements 3.7

  it('any 4xx or 5xx status code always causes XDBError(RUNTIME_ERROR)', async () => {
    await fc.assert(
      fc.asyncProperty(httpErrorStatusArb, async (status) => {
        globalThis.fetch = vi.fn().mockResolvedValue({
          ok: false,
          status,
          statusText: 'Error',
          text: async () => `{"error":"test error"}`,
        } as unknown as Response);

        const client = new EmbeddingClient({
          provider: 'openai',
          apiKey: 'sk-test',
          model: 'text-embedding-3-small',
        });

        try {
          await client.embed({ texts: ['hi'], model: 'text-embedding-3-small' });
          expect.unreachable('Expected XDBError to be thrown');
        } catch (e) {
          expect(e).toBeInstanceOf(XDBError);
          expect((e as XDBError).exitCode).toBe(RUNTIME_ERROR);
          expect((e as XDBError).message).toContain(String(status));
        }
      }),
      { numRuns: 50 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 7: API 响应按 index 排序
// ---------------------------------------------------------------------------

describe('Property 7: API 响应按 index 排序', () => {
  // Feature: embed-service, Property 7: API 响应按 index 排序
  // Validates: Requirements 3.9

  it('embeddings are returned in input order regardless of API response order', async () => {
    const embeddingVecArb = fc.array(
      fc.double({ noNaN: true, noDefaultInfinity: true }).map((v) => (Object.is(v, -0) ? 0 : v)),
      { minLength: 1, maxLength: 5 },
    );

    await fc.assert(
      fc.asyncProperty(
        fc.array(embeddingVecArb, { minLength: 1, maxLength: 8 }),
        async (embeddings) => {
          globalThis.fetch = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => makeShuffledResponse(embeddings),
          } as unknown as Response);

          const client = new EmbeddingClient({
            provider: 'openai',
            apiKey: 'sk-test',
            model: 'text-embedding-3-small',
          });

          const result = await client.embed({
            texts: embeddings.map((_, i) => `text-${i}`),
            model: 'text-embedding-3-small',
          });

          expect(result.embeddings).toHaveLength(embeddings.length);
          for (let i = 0; i < embeddings.length; i++) {
            expect(result.embeddings[i]).toEqual(embeddings[i]);
          }
        },
      ),
      { numRuns: 50 },
    );
  });
});
