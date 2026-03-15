import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnCommand } from './os-utils.js';
import { XDBError, RUNTIME_ERROR } from './errors.js';

/**
 * Decode a hex string array (one 8-char hex per float32, big-endian) back to number[].
 */
function hexToVector(hexArr: string[]): number[] {
  const result: number[] = new Array(hexArr.length);
  const buf = new ArrayBuffer(4);
  const view = new DataView(buf);
  for (let i = 0; i < hexArr.length; i++) {
    const h = hexArr[i]!;
    for (let b = 0; b < 4; b++) {
      view.setUint8(b, parseInt(h.substring(b * 2, b * 2 + 2), 16));
    }
    result[i] = view.getFloat32(0, false); // big-endian
  }
  return result;
}

/**
 * Embedder wraps the local `pai embed` command to convert text into vectors.
 */
export class Embedder {
  /**
   * Embed a single text string into a vector.
   * Calls: pai embed --json <text>
   * pai returns: { "embedding": ["<hex>", ...], ... }
   */
  async embed(text: string): Promise<number[]> {
    const stdout = await this.exec(['embed', '--json', text]);
    const parsed = JSON.parse(stdout);
    return hexToVector(parsed.embedding);
  }

  /**
   * Embed multiple texts in a single batch call.
   * Uses --input-file to avoid Windows command-line length limits.
   * pai returns: { "embeddings": [["<hex>", ...], ...], ... }
   */
  async embedBatch(texts: string[]): Promise<number[][]> {
    const tmpFile = join(tmpdir(), `xdb-embed-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    try {
      await writeFile(tmpFile, JSON.stringify(texts), 'utf8');
      const stdout = await this.exec(['embed', '--batch', '--json', '--input-file', tmpFile]);
      const parsed = JSON.parse(stdout);
      return (parsed.embeddings as string[][]).map(hexToVector);
    } finally {
      await unlink(tmpFile).catch(() => { /* ignore cleanup errors */ });
    }
  }

  private async exec(args: string[]): Promise<string> {
    try {
      const { stdout } = await spawnCommand('pai', args, undefined, 0, 32);
      return stdout;
    } catch (error) {
      throw new XDBError(RUNTIME_ERROR, `pai embed failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

export { hexToVector };
