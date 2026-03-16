/**
 * Batch input parsing and embedding output formatting for the embed command.
 */

import { XDBError, PARAMETER_ERROR } from './errors.js';
import type { EmbeddingResponse } from './embedding-client.js';

/**
 * Encode a float64 number[] vector as a hex string array of float32 values (big-endian).
 * Each float32 becomes one 8-char hex string, e.g. [0.5, -1.0] → ["3f000000", "bf800000"].
 * This is lossless at float32 precision and more compact than a JSON number array.
 */
export function vectorToHex(vec: number[]): string[] {
  const buf = new ArrayBuffer(4);
  const view = new DataView(buf);
  const result: string[] = new Array(vec.length);
  for (let i = 0; i < vec.length; i++) {
    view.setFloat32(0, vec[i]!, false); // big-endian
    let hex = '';
    for (let b = 0; b < 4; b++) {
      const byte = view.getUint8(b);
      hex += (byte < 16 ? '0' : '') + byte.toString(16);
    }
    result[i] = hex;
  }
  return result;
}

/**
 * Parse a raw string as a JSON string array for batch embedding.
 * Throws XDBError (exitCode PARAMETER_ERROR) if the JSON is invalid or not an array of strings.
 * Returns an empty array if the input is an empty JSON array.
 */
export function parseBatchInput(raw: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new XDBError(
      PARAMETER_ERROR,
      'Invalid batch input: not valid JSON',
    );
  }

  if (!Array.isArray(parsed)) {
    throw new XDBError(
      PARAMETER_ERROR,
      'Invalid batch input: expected a JSON array of strings',
    );
  }

  for (let i = 0; i < parsed.length; i++) {
    if (typeof parsed[i] !== 'string') {
      throw new XDBError(
        PARAMETER_ERROR,
        `Invalid batch input: element at index ${i} is not a string`,
      );
    }
  }

  return parsed as string[];
}

/**
 * Format an EmbeddingResponse for stdout output.
 *
 * Vectors are encoded as hex string arrays (each float32 → one 8-char hex string).
 * This preserves float32 precision exactly and is more compact than a JSON number array.
 *
 * Plain text mode (json=false):
 *   Single: one line with the hex array, e.g. ["3f800000","bf800000"]
 *   Batch:  one hex array per line
 *
 * JSON mode (json=true):
 *   Single: { "embedding": ["<hex>", ...], "model": "...", "usage": { ... } }
 *   Batch:  { "embeddings": [["<hex>", ...], ...], "model": "...", "usage": { ... } }
 */
export function formatEmbeddingOutput(
  result: EmbeddingResponse,
  options: { json: boolean; batch: boolean },
): string {
  if (!options.json) {
    // Plain text: each embedding as a hex string array on its own line
    return result.embeddings
      .map((emb) => JSON.stringify(vectorToHex(emb)))
      .join('\n');
  }

  // JSON mode
  const usage = {
    prompt_tokens: result.usage.promptTokens,
    total_tokens: result.usage.totalTokens,
  };

  if (options.batch) {
    return JSON.stringify({
      embeddings: result.embeddings.map((emb) => vectorToHex(emb)),
      model: result.model,
      usage,
    });
  }

  // Single mode – use "embedding" (singular) with the first vector
  return JSON.stringify({
    embedding: vectorToHex(result.embeddings[0]!),
    model: result.model,
    usage,
  });
}
