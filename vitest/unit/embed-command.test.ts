import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { executeEmbed } from '../../src/commands/embed.js';
import { XDBError, PARAMETER_ERROR, RUNTIME_ERROR } from '../../src/errors.js';
import type { XdbConfigManager } from '../../src/config-manager.js';
import type { EmbeddingClientConfig, EmbeddingResponse } from '../../src/embedding-client.js';

const baseEmbedConfig = {
  provider: 'openai',
  model: 'text-embedding-3-small',
  apiKey: 'sk-test',
  providerConfig: { name: 'openai' },
};

const baseEmbedResponse: EmbeddingResponse = {
  embeddings: [[0.1, 0.2, 0.3]],
  model: 'text-embedding-3-small',
  usage: { promptTokens: 2, totalTokens: 2 },
};

function makeManager(overrides?: Partial<typeof baseEmbedConfig>): XdbConfigManager {
  return {
    resolveEmbedConfig: vi.fn().mockResolvedValue({ ...baseEmbedConfig, ...overrides }),
  } as unknown as XdbConfigManager;
}

function makeClientFactory(mockEmbed: ReturnType<typeof vi.fn>) {
  return (_config: EmbeddingClientConfig) => ({ embed: mockEmbed });
}

describe('executeEmbed', () => {
  let stdoutOutput: string;
  let stderrOutput: string;
  let mockClientEmbed: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    stdoutOutput = '';
    stderrOutput = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutOutput += String(chunk);
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrOutput += String(chunk);
      return true;
    });
    mockClientEmbed = vi.fn().mockResolvedValue({ ...baseEmbedResponse });
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('single text embedding', () => {
    it('embeds text from positional argument', async () => {
      const manager = makeManager();
      await executeEmbed('hello world', {}, manager, makeClientFactory(mockClientEmbed));

      expect(mockClientEmbed).toHaveBeenCalledWith({
        texts: ['hello world'],
        model: 'text-embedding-3-small',
      });
      const parsed: string[] = JSON.parse(stdoutOutput.trim());
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toHaveLength(3);
      for (const h of parsed) {
        expect(h).toMatch(/^[0-9a-f]{8}$/);
      }
    });

    it('outputs hex-encoded vector in plain mode', async () => {
      const manager = makeManager();
      await executeEmbed('test', {}, manager, makeClientFactory(mockClientEmbed));

      const parsed = JSON.parse(stdoutOutput.trim());
      expect(Array.isArray(parsed)).toBe(true);
    });
  });

  describe('--json output mode', () => {
    it('outputs JSON with embedding field for single text', async () => {
      const manager = makeManager();
      await executeEmbed('hello', { json: true }, manager, makeClientFactory(mockClientEmbed));

      const parsed = JSON.parse(stdoutOutput.trim());
      expect(parsed).toHaveProperty('embedding');
      expect(Array.isArray(parsed.embedding)).toBe(true);
      for (const h of parsed.embedding) {
        expect(h).toMatch(/^[0-9a-f]{8}$/);
      }
      expect(parsed).toHaveProperty('model', 'text-embedding-3-small');
      expect(parsed).toHaveProperty('usage');
    });

    it('outputs JSON with embeddings field for batch', async () => {
      mockClientEmbed.mockResolvedValue({
        embeddings: [[0.1], [0.2]],
        model: 'text-embedding-3-small',
        usage: { promptTokens: 4, totalTokens: 4 },
      });

      const manager = makeManager();
      await executeEmbed('["a","b"]', { json: true, batch: true }, manager, makeClientFactory(mockClientEmbed));

      const parsed = JSON.parse(stdoutOutput.trim());
      expect(parsed).toHaveProperty('embeddings');
      expect(parsed).not.toHaveProperty('embedding');
    });
  });

  describe('--batch mode', () => {
    it('parses JSON string array and embeds all texts', async () => {
      mockClientEmbed.mockResolvedValue({
        embeddings: [[0.1, 0.2], [0.3, 0.4]],
        model: 'text-embedding-3-small',
        usage: { promptTokens: 4, totalTokens: 4 },
      });

      const manager = makeManager();
      await executeEmbed('["hello","world"]', { batch: true }, manager, makeClientFactory(mockClientEmbed));

      expect(mockClientEmbed).toHaveBeenCalledWith({
        texts: ['hello', 'world'],
        model: 'text-embedding-3-small',
      });
      const lines = stdoutOutput.trim().split('\n');
      expect(lines).toHaveLength(2);
    });

    it('throws XDBError(PARAMETER_ERROR) for invalid batch JSON', async () => {
      const manager = makeManager();
      await expect(
        executeEmbed('not json', { batch: true }, manager, makeClientFactory(mockClientEmbed)),
      ).rejects.toMatchObject({ exitCode: PARAMETER_ERROR });
    });
  });

  describe('text truncation warnings', () => {
    it('outputs plain warning when text is truncated', async () => {
      const longText = 'a'.repeat(40000);
      const manager = makeManager();
      await executeEmbed(longText, {}, manager, makeClientFactory(mockClientEmbed));

      expect(stderrOutput).toContain('[Warning]');
      expect(stderrOutput).toContain('truncated');
    });

    it('outputs JSON warning in --json mode when text is truncated', async () => {
      const longText = 'a'.repeat(40000);
      const manager = makeManager();
      await executeEmbed(longText, { json: true }, manager, makeClientFactory(mockClientEmbed));

      const warningLine = stderrOutput.trim().split('\n').find((l) => l.includes('"type":"warning"'));
      expect(warningLine).toBeDefined();
      const parsed = JSON.parse(warningLine!);
      expect(parsed.type).toBe('warning');
      expect(parsed.data).toHaveProperty('originalTokens');
      expect(parsed.data).toHaveProperty('truncatedTokens');
    });

    it('does not warn for short text', async () => {
      const manager = makeManager();
      await executeEmbed('short text', {}, manager, makeClientFactory(mockClientEmbed));

      const truncationWarnings = stderrOutput.split('\n').filter((l) =>
        l.includes('[Warning]') && l.includes('truncated'),
      );
      expect(truncationWarnings).toHaveLength(0);
    });
  });

  describe('error handling', () => {
    it('throws XDBError(PARAMETER_ERROR) when no input provided', async () => {
      const manager = makeManager();
      await expect(
        executeEmbed(undefined, {}, manager, makeClientFactory(mockClientEmbed)),
      ).rejects.toMatchObject({ exitCode: PARAMETER_ERROR });
    });

    it('throws XDBError(PARAMETER_ERROR) when provider not configured', async () => {
      const manager = {
        resolveEmbedConfig: vi.fn().mockRejectedValue(
          new XDBError(PARAMETER_ERROR, 'No embed provider configured'),
        ),
      } as unknown as XdbConfigManager;

      await expect(
        executeEmbed('hello', {}, manager, makeClientFactory(mockClientEmbed)),
      ).rejects.toMatchObject({ exitCode: PARAMETER_ERROR });
    });

    it('throws XDBError(RUNTIME_ERROR) on API/network error', async () => {
      mockClientEmbed.mockRejectedValue(new XDBError(RUNTIME_ERROR, 'Network error'));
      const manager = makeManager();

      await expect(
        executeEmbed('hello', {}, manager, makeClientFactory(mockClientEmbed)),
      ).rejects.toMatchObject({ exitCode: RUNTIME_ERROR });
    });

    it('error message goes to stderr not stdout (via handleError in action)', async () => {
      const manager = {
        resolveEmbedConfig: vi.fn().mockRejectedValue(
          new XDBError(PARAMETER_ERROR, 'No embed provider configured'),
        ),
      } as unknown as XdbConfigManager;

      try {
        await executeEmbed('hello', {}, manager, makeClientFactory(mockClientEmbed));
        expect.fail('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(XDBError);
        expect((e as XDBError).message).toContain('No embed provider');
      }
      expect(stdoutOutput).toBe('');
    });
  });

  describe('--input-file', () => {
    it('reads text from file', async () => {
      const { writeFile, mkdtemp, rm } = await import('node:fs/promises');
      const { join } = await import('node:path');
      const { tmpdir } = await import('node:os');

      const dir = await mkdtemp(join(tmpdir(), 'xdb-embed-test-'));
      const filePath = join(dir, 'input.txt');
      await writeFile(filePath, 'file content here', 'utf-8');

      const manager = makeManager();
      try {
        await executeEmbed(undefined, { inputFile: filePath }, manager, makeClientFactory(mockClientEmbed));
      } finally {
        await rm(dir, { recursive: true, force: true });
      }

      expect(mockClientEmbed).toHaveBeenCalledWith({
        texts: ['file content here'],
        model: 'text-embedding-3-small',
      });
    });
  });
});
