import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Embedder } from './embedder.js';
import { XDBError, RUNTIME_ERROR } from './errors.js';

// Mock child_process so we don't need the real `pai` command
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

import { execFile } from 'node:child_process';

const mockExecFile = vi.mocked(execFile);

/** Helper to make the mocked execFile resolve with given stdout */
function mockPaiOutput(stdout: string) {
  mockExecFile.mockImplementation((_cmd, _args, callback: any) => {
    callback(null, stdout, '');
    return {} as any;
  });
}

/** Helper to make the mocked execFile reject with an error */
function mockPaiError(error: Error) {
  mockExecFile.mockImplementation((_cmd, _args, callback: any) => {
    callback(error, '', '');
    return {} as any;
  });
}

describe('Embedder', () => {
  let embedder: Embedder;

  beforeEach(() => {
    vi.clearAllMocks();
    embedder = new Embedder();
  });

  describe('embed(text)', () => {
    it('should call pai embed --json with the text and return the embedding', async () => {
      const vector = [0.1, 0.2, 0.3];
      mockPaiOutput(JSON.stringify({ embedding: vector }));

      const result = await embedder.embed('hello world');

      expect(result).toEqual(vector);
      expect(mockExecFile).toHaveBeenCalledWith(
        'pai',
        ['embed', '--json', 'hello world'],
        expect.any(Function),
      );
    });

    it('should handle high-dimensional vectors', async () => {
      const vector = Array.from({ length: 384 }, (_, i) => i * 0.001);
      mockPaiOutput(JSON.stringify({ embedding: vector }));

      const result = await embedder.embed('test');
      expect(result).toEqual(vector);
      expect(result).toHaveLength(384);
    });
  });

  describe('embedBatch(texts)', () => {
    it('should call pai embed --batch --json with JSON array and return embeddings', async () => {
      const embeddings = [
        [0.1, 0.2, 0.3],
        [0.4, 0.5, 0.6],
      ];
      mockPaiOutput(JSON.stringify({ embeddings }));

      const result = await embedder.embedBatch(['hello', 'world']);

      expect(result).toEqual(embeddings);
      expect(mockExecFile).toHaveBeenCalledWith(
        'pai',
        ['embed', '--batch', '--json', JSON.stringify(['hello', 'world'])],
        expect.any(Function),
      );
    });

    it('should handle single-item batch', async () => {
      const embeddings = [[0.1, 0.2]];
      mockPaiOutput(JSON.stringify({ embeddings }));

      const result = await embedder.embedBatch(['single']);
      expect(result).toEqual(embeddings);
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
