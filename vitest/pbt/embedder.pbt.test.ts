/**
 * Feature: embed-service
 * Properties 9, 10: Internal_Embedder 属性测试
 *
 * Validates: Requirements 5.2, 5.5
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fc from 'fast-check';
import { Embedder } from '../../src/embedder.js';
import type { XdbConfigManager } from '../../src/config-manager.js';

// ---------------------------------------------------------------------------
// Mock EmbeddingClient
// ---------------------------------------------------------------------------

const mockClientEmbed = vi.fn();
vi.mock('../../src/embedding-client.js', () => ({
  EmbeddingClient: vi.fn().mockImplementation(() => ({
    embed: mockClientEmbed,
  })),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfigManager(): XdbConfigManager {
  return {
    resolveEmbedConfig: vi.fn().mockResolvedValue({
      provider: 'openai',
      model: 'text-embedding-3-small',
      apiKey: 'sk-test',
      providerConfig: { name: 'openai' },
    }),
  } as unknown as XdbConfigManager;
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

const finiteFloat = fc
  .double({ noNaN: true, noDefaultInfinity: true })
  .map((v) => (Object.is(v, -0) ? 0 : v));

const embeddingVec = fc.array(finiteFloat, { minLength: 1, maxLength: 20 });

const nonEmptyStringArb = fc.string({ minLength: 1, maxLength: 100 });

// ---------------------------------------------------------------------------
// Property 9: embedBatch 输出长度与输入一致
// ---------------------------------------------------------------------------

describe('Property 9: embedBatch 输出长度与输入一致', () => {
  // Feature: embed-service, Property 9: embedBatch 输出长度与输入一致
  // Validates: Requirements 5.2

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('embedBatch returns number[][] with same length as input texts array', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(nonEmptyStringArb, { minLength: 0, maxLength: 20 }),
        async (texts) => {
          const embeddings = texts.map(() => [0.1, 0.2, 0.3]);
          mockClientEmbed.mockResolvedValue({
            embeddings,
            model: 'text-embedding-3-small',
            usage: { promptTokens: texts.length, totalTokens: texts.length },
          });

          const embedder = new Embedder(makeConfigManager());
          const result = await embedder.embedBatch(texts);

          expect(result).toHaveLength(texts.length);
        },
      ),
      { numRuns: 50 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 10: Internal_Embedder 返回 number[] 而非 string[]
// ---------------------------------------------------------------------------

describe('Property 10: Internal_Embedder 返回 number[] 而非 string[]', () => {
  // Feature: embed-service, Property 10: Internal_Embedder 返回 number[] 而非 string[]
  // Validates: Requirements 5.5

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('embed() returns array of numbers, not strings (no hex encoding)', async () => {
    await fc.assert(
      fc.asyncProperty(embeddingVec, async (vector) => {
        mockClientEmbed.mockResolvedValue({
          embeddings: [vector],
          model: 'text-embedding-3-small',
          usage: { promptTokens: 1, totalTokens: 1 },
        });

        const embedder = new Embedder(makeConfigManager());
        const result = await embedder.embed('test text');

        expect(Array.isArray(result)).toBe(true);
        for (const v of result) {
          expect(typeof v).toBe('number');
          expect(typeof v).not.toBe('string');
        }
      }),
      { numRuns: 50 },
    );
  });

  it('embedBatch() returns array of number arrays, not string arrays', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(embeddingVec, { minLength: 1, maxLength: 5 }),
        async (vectors) => {
          mockClientEmbed.mockResolvedValue({
            embeddings: vectors,
            model: 'text-embedding-3-small',
            usage: { promptTokens: vectors.length, totalTokens: vectors.length },
          });

          const texts = vectors.map((_, i) => `text-${i}`);
          const embedder = new Embedder(makeConfigManager());
          const result = await embedder.embedBatch(texts);

          for (const vec of result) {
            expect(Array.isArray(vec)).toBe(true);
            for (const v of vec) {
              expect(typeof v).toBe('number');
            }
          }
        },
      ),
      { numRuns: 50 },
    );
  });
});
