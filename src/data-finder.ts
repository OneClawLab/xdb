import { PARAMETER_ERROR, XDBError } from './errors.js';
import type { Embedder } from './embedder.js';
import type { LanceDBEngine } from './engines/lancedb-engine.js';
import type { SQLiteEngine, SearchResult } from './engines/sqlite-engine.js';
import type { PolicyConfig } from './policy-registry.js';

export type { SearchResult };

export interface FindOptions {
  similar?: boolean;
  match?: boolean;
  where?: string;
  limit: number;
}

export class DataFinder {
  constructor(
    private policy: PolicyConfig,
    private embedder: Embedder,
    private lanceEngine?: LanceDBEngine,
    private sqliteEngine?: SQLiteEngine,
  ) {}

  /**
   * Execute a search based on intent flags and return results.
   * Routes to the appropriate engine(s) based on --similar/--match/--where.
   */
  async find(query: string | undefined, options: FindOptions): Promise<SearchResult[]> {
    const limit = options.limit ?? 10;

    if (options.similar) {
      return this.handleSimilar(query, options.where, limit);
    }

    if (options.match) {
      return this.handleMatch(query, options.where, limit);
    }

    if (options.where) {
      return this.handleWhereOnly(options.where, limit);
    }

    // No intent flags → parameter error
    throw new XDBError(PARAMETER_ERROR, 'No search intent specified. Use --similar, --match, or --where');
  }

  /** --similar: vector search via LanceDB */
  private async handleSimilar(query: string | undefined, where: string | undefined, limit: number): Promise<SearchResult[]> {
    // Capability check: policy must have fields with 'similar' findCaps
    if (!this.hasCap('similar')) {
      throw new XDBError(PARAMETER_ERROR, 'This collection does not support semantic search (no fields with "similar" findCaps)');
    }

    if (!query) {
      throw new XDBError(PARAMETER_ERROR, 'Query text is required for --similar search');
    }

    // Determine the vector column name: first field with 'similar' cap + '_vector'
    const similarField = this.getSimilarFields()[0];
    const column = `${similarField}_vector`;

    const vector = await this.embedder.embed(query);
    return this.lanceEngine!.vectorSearch(vector, {
      limit,
      ...(where !== undefined ? { filter: where } : {}),
      column,
    });
  }

  /** --match: full-text search via SQLite FTS5 */
  private async handleMatch(query: string | undefined, where: string | undefined, limit: number): Promise<SearchResult[]> {
    // Capability check: policy must have fields with 'match' findCaps
    if (!this.hasCap('match')) {
      throw new XDBError(PARAMETER_ERROR, 'This collection does not support full-text search (no fields with "match" findCaps)');
    }

    if (!query) {
      throw new XDBError(PARAMETER_ERROR, 'Query text is required for --match search');
    }

    if (where) {
      return this.sqliteEngine!.ftsWhereSearch(query, where, limit);
    }
    return this.sqliteEngine!.ftsSearch(query, limit);
  }

  /** --where only (no --similar or --match): prefer SQLite, fallback to LanceDB */
  private async handleWhereOnly(where: string, limit: number): Promise<SearchResult[]> {
    if (this.sqliteEngine) {
      return this.sqliteEngine.whereSearch(where, limit);
    }

    // Only LanceDB available → convert to native filter
    if (this.lanceEngine) {
      return this.lanceEngine.filterSearch(where, limit);
    }

    throw new XDBError(PARAMETER_ERROR, 'No search engine available for this collection');
  }

  /** Check if the policy has any field with the given findCap */
  private hasCap(cap: 'similar' | 'match'): boolean {
    return Object.values(this.policy.fields).some((cfg) => cfg.findCaps.includes(cap));
  }

  /** Get field names that have 'similar' findCaps */
  private getSimilarFields(): string[] {
    return Object.entries(this.policy.fields)
      .filter(([, cfg]) => cfg.findCaps.includes('similar'))
      .map(([name]) => name);
  }
}
