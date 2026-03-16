/**
 * Feature: embed-service
 * Properties 11, 12: embed-io 属性测试
 *
 * Validates: Requirements 6.4, 6.5, 6.6
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { parseBatchInput, formatEmbeddingOutput } from '../../src/embed-io.js';
import { XDBError } from '../../src/errors.js';
import type { EmbeddingResponse } from '../../src/embedding-client.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hexToVector(hexArr: string[]): number[] {
  const result: number[] = new Array(hexArr.length);
  const buf = new ArrayBuffer(4);
  const view = new DataView(buf);
  for (let i = 0; i < hexArr.length; i++) {
    const h = hexArr[i]!;
    for (let b = 0; b < 4; b++) {
      view.setUint8(b, parseInt(h.substring(b * 2, b * 2 + 2), 16));
    }
    result[i] = view.getFloat32(0, false);
  }
  return result;
}

function f32(n: number): number {
  const buf = new Float32Array(1);
  buf[0] = n;
  return buf[0]!;
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

const finiteFloat = fc
  .double({ noNaN: true, noDefaultInfinity: true })
  .map((v) => (Object.is(v, -0) ? 0 : v));

const embeddingVec = fc.array(finiteFloat, { minLength: 1, maxLength: 20 });
const tokenCount = fc.nat({ max: 100_000 });

const modelName = fc
  .array(
    fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-_.'.split('')),
    { minLength: 1, maxLength: 40 },
  )
  .map((chars) => chars.join(''));

const embeddingResponseArb: fc.Arbitrary<EmbeddingResponse> = fc
  .tuple(
    fc.array(embeddingVec, { minLength: 1, maxLength: 10 }),
    modelName,
    tokenCount,
    tokenCount,
  )
  .map(([embeddings, model, promptTokens, totalTokens]) => ({
    embeddings,
    model,
    usage: { promptTokens, totalTokens },
  }));

// ---------------------------------------------------------------------------
// Property 11: 批量 JSON 解析有效性
// ---------------------------------------------------------------------------

describe('Property 11: 批量 JSON 解析有效性', () => {
  // Feature: embed-service, Property 11: 批量 JSON 解析有效性
  // Validates: Requirements 6.6

  it('valid JSON string arrays are parsed without loss or addition', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string(), { minLength: 0, maxLength: 50 }),
        (strings) => {
          const raw = JSON.stringify(strings);
          const result = parseBatchInput(raw);
          expect(result).toHaveLength(strings.length);
          expect(result).toEqual(strings);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('invalid JSON strings always cause XDBError', () => {
    const invalidJsonArb = fc.string({ minLength: 1 }).filter((s) => {
      try {
        JSON.parse(s);
        return false;
      } catch {
        return true;
      }
    });

    fc.assert(
      fc.property(invalidJsonArb, (raw) => {
        expect(() => parseBatchInput(raw)).toThrow(XDBError);
      }),
      { numRuns: 100 },
    );
  });

  it('valid JSON but not an array always causes XDBError', () => {
    const nonArrayJsonArb = fc.oneof(
      fc.double({ noNaN: true, noDefaultInfinity: true }).map((n) => JSON.stringify(n)),
      fc.string().map((s) => JSON.stringify(s)),
      fc.boolean().map((b) => JSON.stringify(b)),
      fc.constant('null'),
      fc.dictionary(fc.string({ minLength: 1, maxLength: 10 }), fc.string()).map((o) =>
        JSON.stringify(o),
      ),
    );

    fc.assert(
      fc.property(nonArrayJsonArb, (raw) => {
        expect(() => parseBatchInput(raw)).toThrow(XDBError);
      }),
      { numRuns: 100 },
    );
  });

  it('array with non-string elements always causes XDBError', () => {
    const nonStringElement = fc.oneof(
      fc.integer(),
      fc.double({ noNaN: true, noDefaultInfinity: true }),
      fc.boolean(),
      fc.constant(null),
    );

    const mixedArrayArb = fc
      .tuple(
        fc.array(fc.string(), { minLength: 0, maxLength: 5 }),
        nonStringElement,
        fc.array(fc.string(), { minLength: 0, maxLength: 5 }),
      )
      .map(([before, bad, after]) => JSON.stringify([...before, bad, ...after]));

    fc.assert(
      fc.property(mixedArrayArb, (raw) => {
        expect(() => parseBatchInput(raw)).toThrow(XDBError);
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 12: formatEmbeddingOutput JSON 结构完整性
// ---------------------------------------------------------------------------

describe('Property 12: formatEmbeddingOutput JSON 结构完整性', () => {
  // Feature: embed-service, Property 12: formatEmbeddingOutput JSON 结构完整性
  // Validates: Requirements 6.4, 6.5

  it('single mode: output is valid JSON with `embedding` (hex), `model`, and `usage`', () => {
    fc.assert(
      fc.property(embeddingResponseArb, (response) => {
        const output = formatEmbeddingOutput(response, { json: true, batch: false });
        const parsed = JSON.parse(output);

        expect(parsed).toHaveProperty('embedding');
        expect(Array.isArray(parsed.embedding)).toBe(true);
        for (const h of parsed.embedding) {
          expect(typeof h).toBe('string');
          expect(h).toMatch(/^[0-9a-f]{8}$/);
        }
        expect(parsed).not.toHaveProperty('embeddings');
        expect(parsed).toHaveProperty('model');
        expect(parsed).toHaveProperty('usage');
      }),
      { numRuns: 100 },
    );
  });

  it('batch mode: output is valid JSON with `embeddings` (array of hex arrays), `model`, and `usage`', () => {
    fc.assert(
      fc.property(embeddingResponseArb, (response) => {
        const output = formatEmbeddingOutput(response, { json: true, batch: true });
        const parsed = JSON.parse(output);

        expect(parsed).toHaveProperty('embeddings');
        expect(Array.isArray(parsed.embeddings)).toBe(true);
        for (const arr of parsed.embeddings) {
          expect(Array.isArray(arr)).toBe(true);
          for (const h of arr) {
            expect(typeof h).toBe('string');
            expect(h).toMatch(/^[0-9a-f]{8}$/);
          }
        }
        expect(parsed).not.toHaveProperty('embedding');
        expect(parsed).toHaveProperty('model');
        expect(parsed).toHaveProperty('usage');
      }),
      { numRuns: 100 },
    );
  });

  it('usage fields use snake_case (prompt_tokens, total_tokens)', () => {
    fc.assert(
      fc.property(embeddingResponseArb, (response) => {
        for (const batch of [true, false]) {
          const output = formatEmbeddingOutput(response, { json: true, batch });
          const parsed = JSON.parse(output);
          expect(parsed.usage).toHaveProperty('prompt_tokens');
          expect(parsed.usage).toHaveProperty('total_tokens');
          expect(parsed.usage).not.toHaveProperty('promptTokens');
          expect(parsed.usage).not.toHaveProperty('totalTokens');
        }
      }),
      { numRuns: 100 },
    );
  });

  it('hex decodes back to float32 of original values', () => {
    fc.assert(
      fc.property(embeddingResponseArb, (response) => {
        const singleOutput = formatEmbeddingOutput(response, { json: true, batch: false });
        const single = JSON.parse(singleOutput);
        const decodedSingle = hexToVector(single.embedding);
        const expectedSingle = response.embeddings[0]!.map(f32);
        expect(decodedSingle).toEqual(expectedSingle);

        const batchOutput = formatEmbeddingOutput(response, { json: true, batch: true });
        const batch = JSON.parse(batchOutput);
        for (let i = 0; i < response.embeddings.length; i++) {
          const decoded = hexToVector(batch.embeddings[i]);
          const expected = response.embeddings[i]!.map(f32);
          expect(decoded).toEqual(expected);
        }
      }),
      { numRuns: 100 },
    );
  });
});
