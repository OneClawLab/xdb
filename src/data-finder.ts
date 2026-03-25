import { PARAMETER_ERROR, XDBError } from './errors.js';
import type { Embedder } from './embedder.js';
import type { LanceDBEngine } from './engines/lancedb-engine.js';
import type { SQLiteEngine, SearchResult } from './engines/sqlite-engine.js';
import type { PolicyConfig } from './policy-registry.js';

export type { SearchResult };

export interface FindOptions {
  similar?: boolean;
  match?: boolean;
  hybrid?: boolean;
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
   * Routes to the appropriate engine(s) based on --similar/--match/--where/--hybrid.
   *
   * Default behavior for hybrid policy:
   *   - query present → hybrid (with optional --where filter)
   *   - --where only  → handleWhereOnly
   */
  async find(query: string | undefined, options: FindOptions): Promise<SearchResult[]> {
    const limit = options.limit ?? 10;

    if (options.similar) {
      return this.handleSimilar(query, options.where, limit);
    }

    if (options.match) {
      return this.handleMatch(query, options.where, limit);
    }

    // Explicit --hybrid, or auto-default when policy is hybrid and query is present
    if (options.hybrid || (query && this.isHybridPolicy())) {
      return this.handleHybrid(query, options.where, limit, !!options.hybrid);
    }

    if (options.where) {
      return this.handleWhereOnly(options.where, limit);
    }

    // No intent flags → parameter error
    throw new XDBError(PARAMETER_ERROR, 'No search intent specified. Use --similar, --match, --hybrid, or --where');
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

  /** Check if policy is hybrid (has both similar and match caps) */
  private isHybridPolicy(): boolean {
    return this.hasCap('similar') && this.hasCap('match');
  }

  /** Get field names that have 'similar' findCaps */
  private getSimilarFields(): string[] {
    return Object.entries(this.policy.fields)
      .filter(([, cfg]) => cfg.findCaps.includes('similar'))
      .map(([name]) => name);
  }

  /**
   * Hybrid search: run both vector and FTS, merge by id, rank with RRF.
   * Falls back gracefully when only one engine is available:
   *   - only LanceDB → --similar
   *   - only SQLite  → --match
   *   - no query     → --where only (if where is set), else error
   * explicit=true means user passed --hybrid explicitly (stricter error messages).
   */
  private async handleHybrid(query: string | undefined, where: string | undefined, limit: number, explicit: boolean): Promise<SearchResult[]> {
    const hasVector = this.hasCap('similar') && !!this.lanceEngine;
    const hasFts = this.hasCap('match') && !!this.sqliteEngine;

    // No query: fall through to where-only or error
    if (!query) {
      if (where) return this.handleWhereOnly(where, limit);
      throw new XDBError(PARAMETER_ERROR, 'Query text is required for hybrid search');
    }

    // Degraded modes
    if (hasVector && !hasFts) {
      if (explicit) {
        process.stderr.write('Warning: FTS not available, falling back to --similar\n');
      }
      return this.handleSimilar(query, where, limit);
    }
    if (hasFts && !hasVector) {
      if (explicit) {
        process.stderr.write('Warning: vector search not available, falling back to --match\n');
      }
      return this.handleMatch(query, where, limit);
    }
    if (!hasVector && !hasFts) {
      throw new XDBError(PARAMETER_ERROR, 'No search engine available for this collection');
    }

    // Full hybrid path
    const recallK = Math.max(limit * 3, 50);
    const RRF_K = 60;
    const W_VECTOR = 1.0;
    const W_FTS = 1.0;
    const BOTH_BONUS = 0.01;

    const similarField = this.getSimilarFields()[0]!;
    const column = `${similarField}_vector`;
    const vector = await this.embedder.embed(query);

    const [vectorResults, ftsResults] = await Promise.all([
      this.lanceEngine!.vectorSearch(vector, {
        limit: recallK,
        ...(where !== undefined ? { filter: where } : {}),
        column,
      }),
      where
        ? this.sqliteEngine!.ftsWhereSearch(query, where, recallK)
        : this.sqliteEngine!.ftsSearch(query, recallK),
    ]);

    // Build id → candidate map with per-engine ranks (1-based)
    const candidates = new Map<string, {
      data: Record<string, unknown>;
      vectorRank?: number;
      ftsRank?: number;
      vectorScore?: number | undefined;
      ftsScore?: number | undefined;
    }>();

    for (let i = 0; i < vectorResults.length; i++) {
      const r = vectorResults[i]!;
      const id = String(r.data.id ?? i);
      const entry: { data: Record<string, unknown>; vectorRank?: number; ftsRank?: number; vectorScore?: number | undefined; ftsScore?: number | undefined } = {
        data: r.data,
        vectorRank: i + 1,
      };
      if (r._score !== undefined) entry.vectorScore = r._score;
      candidates.set(id, entry);
    }

    for (let i = 0; i < ftsResults.length; i++) {
      const r = ftsResults[i]!;
      const id = String(r.data.id ?? `fts_${i}`);
      const existing = candidates.get(id);
      if (existing) {
        existing.ftsRank = i + 1;
        if (r._score !== undefined) existing.ftsScore = r._score;
      } else {
        const entry: { data: Record<string, unknown>; vectorRank?: number; ftsRank?: number; vectorScore?: number | undefined; ftsScore?: number | undefined } = {
          data: r.data,
          ftsRank: i + 1,
        };
        if (r._score !== undefined) entry.ftsScore = r._score;
        candidates.set(id, entry);
      }
    }

    // Compute RRF scores and sort
    const scored = Array.from(candidates.values()).map((c) => {
      const rrfVector = c.vectorRank !== undefined ? W_VECTOR / (RRF_K + c.vectorRank) : 0;
      const rrfFts = c.ftsRank !== undefined ? W_FTS / (RRF_K + c.ftsRank) : 0;
      const bonus = c.vectorRank !== undefined && c.ftsRank !== undefined ? BOTH_BONUS : 0;
      const final = rrfVector + rrfFts + bonus;

      const sources: Array<'vector' | 'fts'> = [];
      if (c.vectorRank !== undefined) sources.push('vector');
      if (c.ftsRank !== undefined) sources.push('fts');

      const result: SearchResult = {
        data: c.data,
        _score: final,
        _engine: 'hybrid',
        _scores: {
          ...(c.vectorScore !== undefined ? { vector: c.vectorScore } : {}),
          ...(c.ftsScore !== undefined ? { fts: c.ftsScore } : {}),
          final,
          sources,
          rank: {
            ...(c.vectorRank !== undefined ? { vector: c.vectorRank } : {}),
            ...(c.ftsRank !== undefined ? { fts: c.ftsRank } : {}),
          },
        },
      };
      return result;
    });

    scored.sort((a, b) => (b._score ?? 0) - (a._score ?? 0));
    return scored.slice(0, limit);
  }
}
