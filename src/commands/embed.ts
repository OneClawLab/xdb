import { readFile } from 'node:fs/promises';
import type { Command } from 'commander';
import { XdbConfigManager } from '../config-manager.js';
import { EmbeddingClient } from '../embedding-client.js';
import { parseBatchInput, formatEmbeddingOutput } from '../embed-io.js';
import { truncateText, EMBEDDING_MODEL_LIMITS } from '../embedding-models.js';
import { handleError, XDBError, PARAMETER_ERROR, RUNTIME_ERROR } from '../errors.js';

/** Read all data from stdin */
async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => { resolve(data); });
    process.stdin.on('error', (err) => {
      reject(new XDBError(RUNTIME_ERROR, `Failed to read from stdin: ${err.message}`));
    });
  });
}

export interface EmbedOptions {
  batch?: boolean;
  json?: boolean;
  inputFile?: string;
}

export type EmbeddingClientLike = {
  embed: (req: import('../embedding-client.js').EmbeddingRequest) => Promise<import('../embedding-client.js').EmbeddingResponse>;
};

/** Core embed logic, extracted for testability */
export async function executeEmbed(
  text: string | undefined,
  opts: EmbedOptions,
  manager: XdbConfigManager = new XdbConfigManager(),
  clientFactory?: (config: import('../embedding-client.js').EmbeddingClientConfig) => EmbeddingClientLike,
): Promise<void> {
  const { provider, model, providerConfig, apiKey } = await manager.resolveEmbedConfig();

  // Resolve input source
  const hasExplicitInput = text !== undefined || opts.inputFile !== undefined;
  const stdinAvailable = !process.stdin.isTTY && !hasExplicitInput;

  const sourceCount = [
    text !== undefined,
    stdinAvailable,
    opts.inputFile !== undefined,
  ].filter(Boolean).length;

  if (sourceCount > 1) {
    throw new XDBError(
      PARAMETER_ERROR,
      'Multiple input sources specified. Provide input via argument, stdin, or --input-file (only one).',
    );
  }

  let rawInput: string;
  if (text !== undefined) {
    rawInput = text;
  } else if (opts.inputFile) {
    try {
      rawInput = await readFile(opts.inputFile, 'utf-8');
    } catch (err) {
      throw new XDBError(
        RUNTIME_ERROR,
        `Failed to read input file: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } else if (stdinAvailable) {
    rawInput = await readStdin();
  } else {
    throw new XDBError(
      PARAMETER_ERROR,
      'No input text provided. Provide input via argument, stdin, or --input-file.',
    );
  }

  // Parse batch or single input
  let texts: string[];
  if (opts.batch) {
    texts = parseBatchInput(rawInput);
  } else {
    texts = [rawInput];
  }

  // Truncate texts that exceed model limits, warn to stderr
  texts = texts.map((t) => {
    const result = truncateText(t, model);
    if (result.truncated) {
      const truncatedTokens = Math.ceil(result.text.length / 4);
      const modelLimit = EMBEDDING_MODEL_LIMITS[model] ?? truncatedTokens;
      if (opts.json) {
        const warning = {
          type: 'warning',
          data: {
            message: `Input text truncated from ~${result.originalTokens} tokens to ${truncatedTokens} tokens (model limit: ${modelLimit})`,
            originalTokens: result.originalTokens,
            truncatedTokens,
          },
        };
        process.stderr.write(JSON.stringify(warning) + '\n');
      } else {
        process.stderr.write(
          `[Warning] Input text truncated from ~${result.originalTokens} tokens to ${truncatedTokens} tokens (model limit: ${modelLimit})\n`,
        );
      }
    }
    return result.text;
  });

  // Build client config
  const clientConfig: {
    provider: string;
    apiKey: string;
    model: string;
    baseUrl?: string;
    providerOptions?: Record<string, any>;
    api?: string;
  } = { provider, apiKey, model };

  if (providerConfig.baseUrl) {
    clientConfig.baseUrl = providerConfig.baseUrl;
  }
  if (providerConfig.api) {
    clientConfig.api = providerConfig.api;
  }

  const client = clientFactory ? clientFactory(clientConfig) : new EmbeddingClient(clientConfig);
  const response = await client.embed({ texts, model });

  // Format and write output
  const output = formatEmbeddingOutput(response, {
    json: opts.json ?? false,
    batch: opts.batch ?? false,
  });
  process.stdout.write(output + '\n');
}

export function registerEmbedCommand(program: Command): void {
  program
    .command('embed [text]')
    .description('Embed text using the configured embedding provider')
    .option('--batch', 'Parse input as a JSON string array for batch embedding')
    .option('--json', 'Output as JSON')
    .option('--input-file <path>', 'Read input from a file')
    .action(async (text: string | undefined, opts: { batch?: boolean; json?: boolean; inputFile?: string }) => {
      try {
        await executeEmbed(text, opts);
      } catch (err) {
        handleError(err);
      }
    });
}
