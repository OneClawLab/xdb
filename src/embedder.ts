import { execFile } from 'node:child_process';
import { XDBError, RUNTIME_ERROR } from './errors.js';

/**
 * Embedder wraps the local `pai embed` command to convert text into vectors.
 */
export class Embedder {
  /**
   * Embed a single text string into a vector.
   * Calls: pai embed --json <text>
   */
  async embed(text: string): Promise<number[]> {
    const stdout = await this.exec(['embed', '--json', text]);
    const parsed = JSON.parse(stdout);
    return parsed.embedding;
  }

  /**
   * Embed multiple texts in a single batch call.
   * Calls: pai embed --batch --json '<json-array>'
   * pai returns: { "embeddings": [[...], [...]], "model": "...", "usage": {...} }
   */
  async embedBatch(texts: string[]): Promise<number[][]> {
    const stdout = await this.exec(['embed', '--batch', '--json', JSON.stringify(texts)]);
    const parsed = JSON.parse(stdout);
    return parsed.embeddings;
  }

  private exec(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile('pai', args, (error, stdout) => {
        if (error) {
          reject(new XDBError(RUNTIME_ERROR, `pai embed failed: ${error.message}`));
          return;
        }
        resolve(stdout);
      });
    });
  }
}
