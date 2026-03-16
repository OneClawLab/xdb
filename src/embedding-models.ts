/**
 * Embedding model token limits and text truncation utilities.
 */

/**
 * Built-in maximum token limits for common embedding models.
 */
export const EMBEDDING_MODEL_LIMITS: Record<string, number> = {
  // OpenAI
  'text-embedding-3-small': 8191,
  'text-embedding-3-large': 8191,
  'text-embedding-ada-002': 8191,
  // Google
  'text-embedding-004': 2048,
  // Cohere
  'embed-english-v3.0': 512,
  'embed-multilingual-v3.0': 512,
  'embed-english-light-v3.0': 512,
  'embed-multilingual-light-v3.0': 512,
};

/** Characters per token estimate */
const CHARS_PER_TOKEN = 4;

export interface TruncateResult {
  text: string;
  truncated: boolean;
  originalTokens: number;
}

/**
 * Estimate token count using simple character-level approximation (1 token ≈ 4 characters).
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Truncate text to fit within a model's token limit.
 *
 * - If the model is not in EMBEDDING_MODEL_LIMITS, returns the original text unchanged.
 * - Uses simple character-level estimation (1 token ≈ 4 characters).
 */
export function truncateText(text: string, model: string): TruncateResult {
  const limit = EMBEDDING_MODEL_LIMITS[model];
  const originalTokens = estimateTokens(text);

  // Unknown model — skip truncation
  if (limit === undefined) {
    return { text, truncated: false, originalTokens };
  }

  // Within limit — no truncation needed
  if (originalTokens <= limit) {
    return { text, truncated: false, originalTokens };
  }

  // Truncate: limit * CHARS_PER_TOKEN characters
  const maxChars = limit * CHARS_PER_TOKEN;
  return {
    text: text.slice(0, maxChars),
    truncated: true,
    originalTokens,
  };
}
