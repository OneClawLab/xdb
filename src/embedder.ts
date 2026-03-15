import { execFile } from 'node:child_process';
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
   * Calls: pai embed --batch --json '<json-array>'
   * pai returns: { "embeddings": [["<hex>", ...], ...], ... }
   */
  async embedBatch(texts: string[]): Promise<number[][]> {
    const stdout = await this.exec(['embed', '--batch', '--json', JSON.stringify(texts)]);
    const parsed = JSON.parse(stdout);
    return (parsed.embeddings as string[][]).map(hexToVector);
  }

  private exec(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      // Use shell:true for Windows .cmd compatibility; quote args to prevent splitting
      const quoted = args.map(a => `"${a.replace(/"/g, '\\"')}"`);
      execFile('pai', quoted, { shell: true }, (error, stdout) => {
        if (error) {
          reject(new XDBError(RUNTIME_ERROR, `pai embed failed: ${error.message}`));
          return;
        }
        resolve(stdout);
      });
    });
  }
}

export { hexToVector };
