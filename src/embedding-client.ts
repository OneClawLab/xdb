/**
 * Embedding API client for OpenAI-compatible endpoints.
 * Calls provider HTTP endpoints directly.
 */

import { XDBError, RUNTIME_ERROR, PARAMETER_ERROR } from './errors.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EmbeddingRequest {
  texts: string[];
  model: string;
}

export interface EmbeddingResponse {
  embeddings: number[][];
  model: string;
  usage: {
    promptTokens: number;
    totalTokens: number;
  };
}

export interface EmbeddingClientConfig {
  provider: string;
  apiKey: string;
  model: string;
  baseUrl?: string;
  providerOptions?: Record<string, any>;
  /** The API type, e.g. 'azure-openai-responses' */
  api?: string;
}

// ---------------------------------------------------------------------------
// Provider default base URLs
// ---------------------------------------------------------------------------

const PROVIDER_DEFAULT_BASE_URLS: Record<string, string> = {
  openai: 'https://api.openai.com',
};

// ---------------------------------------------------------------------------
// EmbeddingClient
// ---------------------------------------------------------------------------

export class EmbeddingClient {
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly isAzure: boolean;

  constructor(config: EmbeddingClientConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model;
    const apiType = config.api ?? config.provider;
    this.isAzure = apiType === 'azure-openai-responses' || apiType === 'azure-openai';
    this.endpoint = this.isAzure
      ? EmbeddingClient.resolveAzureEndpoint(config.baseUrl, config.model, config.providerOptions)
      : EmbeddingClient.resolveEndpoint(config.provider, config.baseUrl);
  }

  /**
   * Resolve the full embeddings API endpoint URL.
   * If baseUrl is provided, use it; otherwise fall back to the provider default.
   */
  static resolveEndpoint(provider: string, baseUrl?: string): string {
    const base =
      baseUrl ?? (Object.hasOwn(PROVIDER_DEFAULT_BASE_URLS, provider) ? PROVIDER_DEFAULT_BASE_URLS[provider] : undefined);
    if (!base) {
      throw new XDBError(
        PARAMETER_ERROR,
        `No base URL configured for provider "${provider}". Please specify a baseUrl.`,
      );
    }
    // Strip trailing slash before appending path
    return `${base.replace(/\/+$/, '')}/v1/embeddings`;
  }

  /**
   * Resolve the Azure OpenAI embeddings endpoint URL.
   * Azure format: {baseUrl}/openai/deployments/{deployment}/embeddings?api-version={version}
   */
  static resolveAzureEndpoint(baseUrl?: string, model?: string, providerOptions?: Record<string, any>): string {
    if (!baseUrl) {
      throw new XDBError(
        PARAMETER_ERROR,
        'Azure OpenAI requires a baseUrl. Please specify a baseUrl.',
      );
    }
    // For embeddings, use the model name as deployment name (embedding deployments
    // are typically named after the model). azureDeploymentName in providerOptions
    // usually refers to the chat model deployment, not the embedding one.
    const deployment = model ?? providerOptions?.azureDeploymentName;
    if (!deployment) {
      throw new XDBError(
        PARAMETER_ERROR,
        'Azure OpenAI requires a deployment name. Specify a model or set providerOptions.azureDeploymentName.',
      );
    }
    const apiVersion = providerOptions?.azureApiVersion;
    // If azureApiVersion looks invalid (e.g. "v1"), fall back to a known good default
    const resolvedVersion = (apiVersion && /^\d{4}-\d{2}-\d{2}/.test(apiVersion))
      ? apiVersion
      : '2024-06-01';
    // Strip any /openai/v1 or trailing path from baseUrl to get the resource root
    const resourceBase = baseUrl.replace(/\/openai\/v1\/?$/, '').replace(/\/+$/, '');
    return `${resourceBase}/openai/deployments/${deployment}/embeddings?api-version=${resolvedVersion}`;
  }

  /**
   * Call the embedding API for the given texts.
   */
  async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    const body = JSON.stringify({
      model: request.model,
      input: request.texts,
    });

    let response: Response;
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (this.isAzure) {
        headers['api-key'] = this.apiKey;
      } else {
        headers['Authorization'] = `Bearer ${this.apiKey}`;
      }

      response = await fetch(this.endpoint, {
        method: 'POST',
        headers,
        body,
      });
    } catch (err: unknown) {
      // Network-level errors (timeout, DNS, connection refused, etc.)
      const message = err instanceof Error ? err.message : String(err);
      throw new XDBError(
        RUNTIME_ERROR,
        `Network error calling embedding API: ${message}`,
      );
    }

    if (!response.ok) {
      let detail = '';
      try {
        const errorBody = await response.text();
        detail = errorBody;
      } catch {
        // ignore – we already have the status code
      }
      throw new XDBError(
        RUNTIME_ERROR,
        `Embedding API error (${response.status}): ${detail || response.statusText}`,
      );
    }

    // Parse successful response (OpenAI-compatible format)
    const json = (await response.json()) as {
      data: { embedding: number[]; index: number }[];
      model: string;
      usage: { prompt_tokens: number; total_tokens: number };
    };

    // Sort by index to guarantee order matches input order
    const sorted = [...json.data].sort((a, b) => a.index - b.index);

    return {
      embeddings: sorted.map((d) => d.embedding),
      model: json.model,
      usage: {
        promptTokens: json.usage.prompt_tokens,
        totalTokens: json.usage.total_tokens,
      },
    };
  }
}
