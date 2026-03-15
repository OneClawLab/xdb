import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Embedder, hexToVector } from '../../src/embedder.js';
import { XDBError, RUNTIME_ERROR } from '../../src/errors.js';

// Mock os-utils so we don't need the real `pai` command
vi.mock('../../src/os-utils.js', () => ({
  spawnCommand: vi.fn(),
  IS_WIN32: false,
  BASE_SPAWN_OPTIONS: {},
  commandExists: vi.fn(),
  execCommand: vi.fn(),
}));

import { spawnCommand } from '../../src/os-utils.js';

const mockSpawn = vi.mocked(spawnCommand);

/**
 * Encode a number[] vector as a hex string array of float32 values (big-endian).
 * Mirror of pai's vectorToHex for test data generation.
 */
function vectorToHex(vec: number[]): string[] {
  const buf = new ArrayBuffer(4);
  const view = new DataView(buf);
  const result: string[] = new Array(vec.length);
  for (let i = 0; i < vec.length; i++) {
    view.setFloat32(0, vec[i], false);
    let hex = '';
    for (let b = 0; b < 4; b++) {
      const byte = view.getUint8(b);
      hex += (byte < 16 ? '0' : '') + byte.toString(16);
    }
    result[i] = hex;
  }
  return result;
}

/** Helper to make the mocked spawnCommand resolve with given stdout */
function mockPaiOutput(stdout: string) {
  mockSpawn.mockResolvedValue({ stdout, stderr: '' });
}

/** Helper to make the mocked spawnCommand reject with an error */
function mockPaiError(error: Error) {
  mockSpawn.mockRejectedValue(error);
}

describe('hexToVector', () => {
  it('should decode a hex string array back to number[]', () => {
    const original = [0.1, 0.2, 0.3];
    const hex = vectorToHex(original);
    expect(Array.isArray(hex)).toBe(true);
    expect(hex).toHaveLength(3);
    const decoded = hexToVector(hex);
    expect(decoded).toHaveLength(3);
    const f32 = new Float32Array(original);
    for (let i = 0; i < decoded.length; i++) {
      expect(decoded[i]).toBe(f32[i]);
    }
  });

  it('should handle empty array', () => {
    expect(hexToVector([])).toEqual([]);
  });
});

describe('Embedder', () => {
  let embedder: Embedder;

  beforeEach(() => {
    vi.clearAllMocks();
    embedder = new Embedder();
  });

  describe('embed(text)', () => {
    it('should call pai embed --json with the text and return the embedding', async () => {
      const vector = [0.1, 0.2, 0.3];
      const hex = vectorToHex(vector);
      mockPaiOutput(JSON.stringify({ embedding: hex }));

      const result = await embedder.embed('hello world');

      const expected = Array.from(new Float32Array(vector));
      expect(result).toEqual(expected);
      expect(mockSpawn).toHaveBeenCalledWith(
        'pai',
        ['embed', '--json'],
        'hello world',
        0,
        32,
      );
    });

    it('should handle high-dimensional vectors', async () => {
      const vector = Array.from({ length: 384 }, (_, i) => i * 0.001);
      const hex = vectorToHex(vector);
      mockPaiOutput(JSON.stringify({ embedding: hex }));

      const result = await embedder.embed('test');
      expect(result).toHaveLength(384);
    });
  });

  describe('embedBatch(texts)', () => {
    it('should call pai embed --batch --json --input-file with a temp file and return embeddings', async () => {
      const embeddings = [
        [0.1, 0.2, 0.3],
        [0.4, 0.5, 0.6],
      ];
      const hexEmbeddings = embeddings.map(vectorToHex);
      mockPaiOutput(JSON.stringify({ embeddings: hexEmbeddings }));

      const result = await embedder.embedBatch(['hello', 'world']);

      expect(result).toHaveLength(2);
      for (let i = 0; i < embeddings.length; i++) {
        const expected = Array.from(new Float32Array(embeddings[i]));
        expect(result[i]).toEqual(expected);
      }
      // Should use --input-file (not inline JSON) to avoid CLI length limits
      expect(mockSpawn).toHaveBeenCalledWith(
        'pai',
        expect.arrayContaining(['embed', '--batch', '--json', '--input-file', expect.any(String)]),
        undefined,
        0,
        32,
      );
    });

    it('should handle single-item batch', async () => {
      const embeddings = [[0.1, 0.2]];
      mockPaiOutput(JSON.stringify({ embeddings: embeddings.map(vectorToHex) }));

      const result = await embedder.embedBatch(['single']);
      expect(result).toHaveLength(1);
    });

    it('should handle empty batch', async () => {
      mockPaiOutput(JSON.stringify({ embeddings: [] }));

      const result = await embedder.embedBatch([]);
      expect(result).toEqual([]);
    });
  });

  describe('error handling', () => {
    it('should throw XDBError with RUNTIME_ERROR when pai command fails', async () => {
      mockPaiError(new Error('Command failed: exit code 1'));

      await expect(embedder.embed('test')).rejects.toThrow(XDBError);
      await expect(embedder.embed('test')).rejects.toMatchObject({
        exitCode: RUNTIME_ERROR,
      });
    });

    it('should throw XDBError when pai command is not found', async () => {
      const err = new Error('spawn pai ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      mockPaiError(err);

      await expect(embedder.embed('test')).rejects.toThrow(XDBError);
      await expect(embedder.embed('test')).rejects.toMatchObject({
        exitCode: RUNTIME_ERROR,
      });
    });

    it('should include descriptive message in error', async () => {
      mockPaiError(new Error('spawn pai ENOENT'));

      try {
        await embedder.embed('test');
        expect.fail('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(XDBError);
        expect((e as XDBError).message).toContain('pai embed failed');
      }
    });

    it('should throw XDBError for batch errors too', async () => {
      mockPaiError(new Error('timeout'));

      await expect(embedder.embedBatch(['a', 'b'])).rejects.toThrow(XDBError);
      await expect(embedder.embedBatch(['a', 'b'])).rejects.toMatchObject({
        exitCode: RUNTIME_ERROR,
      });
    });
  });
});
