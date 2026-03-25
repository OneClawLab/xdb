# xdb find strategy — analysis & TODO

This note summarizes the current `xdb find` retrieval strategy (vector vs FTS), evaluates whether it is adequate, and proposes an implementation plan to improve hybrid retrieval.

## Current behavior (what it does today)

Source references:
- `src/data-finder.ts`
- `src/engines/lancedb-engine.ts`
- `src/engines/sqlite-engine.ts`
- default policy: `src/policy-registry.ts` (`hybrid/knowledge-base`)

### 1) Routing model: *either* vector *or* FTS

`xdb find` is intent-flag driven. It routes to exactly one engine based on flags:

- `--similar` → LanceDB vector search only
  - Query is embedded via `Embedder` (which calls `pai embed`).
  - Uses the *first* field in policy with `findCaps` including `similar`.
  - Vector column name = `${field}_vector`.
  - Score mapping: `_score = 1 - distance/2` (cosine distance in `[0,2]` → similarity `[0,1]`).

- `--match` → SQLite FTS5 only
  - Uses `records_fts MATCH ?`.
  - Score mapping: `_score = -fts.rank` (FTS rank is negative; negate to make “bigger is better”).

- `--where` only → structured filtering
  - Prefers SQLite `records WHERE ${filter}`; falls back to LanceDB `.query().where(filter)`.

### 2) What “hybrid” means today

Even if a collection uses `hybrid/knowledge-base` policy (content has both `similar` and `match` caps), **query-time is not hybrid**. The engines are both available, but `DataFinder.find()` chooses one.

So: today “hybrid” is about *storage/indexing* (LanceDB + SQLite), not *retrieval fusion*.

## Is the current strategy adequate?

### Good fit

- CLI users can explicitly choose the intent (`--similar` vs `--match`), which is simple and predictable.
- Implementation is minimal and the performance characteristics are clear.
- Results are easy to explain (each result is from one engine).

### Not a great fit

- Typical KB search expects **one query → best results**, without requiring the user/agent to decide “semantic vs keyword”.
- Recall suffers if you only do one type of retrieval:
  - Vector search is weak at strict term constraints (IDs, exact names, code symbols).
  - FTS is weak at paraphrases/synonyms.
- There is no result fusion / re-ranking, so hybrid collections can’t leverage both indexes.

## Improvement opportunities (ordered by impact)

1) **True hybrid retrieval (dual recall + fusion ranking)**
- Add `--hybrid` (or make it default when policy.main === `hybrid` and user didn’t specify flags).
- Execute both searches, merge by `id`, then compute `final_score`.

2) **Use rank-based fusion instead of raw FTS rank values**
- FTS5 rank magnitude is not stable; it’s hard to compare across queries.
- Prefer Reciprocal Rank Fusion (RRF) or normalized rank.

3) **Constrained hybrid modes**
- “Vector recall + FTS constraint” (must contain keyword).
- “FTS recall + vector rerank” (best when query includes rare tokens + semantic sorting).

4) **Multi-field support**
- Today vector search uses the first `similar` field. Hybrid KBs will often have title/content/tags.
- Add per-field weighting and multi-vector fusion.

5) **WHERE filter safety**
- SQLite `WHERE ${filter}` is string interpolation (injection / foot-gun risk).
- Prefer a structured filter DSL or at least strict validation/whitelisting.

---

## Implementation plan (concrete TODO)

### A. CLI/API surface

**Goal:** add a “hybrid” search mode while keeping existing flags stable.

Proposed changes:

- `xdb find <collection> <query> --hybrid`
  - Runs both vector and FTS.
  - Requires collection supports both `similar` and `match`.

Optional usability improvement:
- If policy is `hybrid` and user provides neither `--similar` nor `--match` nor `--where`, default to `--hybrid`.

### B. Data model: richer scores

Current `SearchResult`:

```ts
export interface SearchResult {
  data: Record<string, unknown>;
  _score?: number;
  _engine: 'lancedb' | 'sqlite';
}
```

Proposed extended result (backward compatible):

```ts
export interface SearchResult {
  data: Record<string, unknown>;
  _engine: 'lancedb' | 'sqlite' | 'hybrid';

  // Keep existing field for top-level ordering / display
  _score?: number;

  // Optional richer details for debugging and downstream re-ranking
  _scores?: {
    vector?: number; // normalized [0,1]
    fts?: number;    // normalized [0,1] or rank-based score
    final?: number;  // equals _score
    sources?: Array<'vector' | 'fts'>;
    rank?: { vector?: number; fts?: number };
  };
}
```

### C. Fusion algorithm: start with RRF (simple & robust)

Use Reciprocal Rank Fusion (RRF) to avoid dealing with unstable score magnitudes:

- Do two recalls:
  - vector: topK_v
  - fts: topK_f
- For each candidate doc id:

```text
rrf = wv * 1/(k + rank_v) + wf * 1/(k + rank_f) + bonus_if_both
```

Where:
- ranks are 1-based
- `k` is typically 60 (common IR heuristic)
- `wv/wf` default 1.0
- `bonus_if_both` default small (e.g. 0.01)

This yields a stable final score that is comparable within a query.

### D. Execution steps (in `DataFinder`)

1) Parse options:
- add `hybrid?: boolean`
- define `vectorK`, `ftsK` (default maybe `limit * 3` or fixed 50)

2) Implement `handleHybrid(query, where, limit)`:
- run vectorSearch with `limit = vectorK` and optional prefilter `where`
- run ftsSearch / ftsWhereSearch with `limit = ftsK` and optional filter `where`
- merge by `id` (assumes records have `id`)
- compute ranks per engine
- compute RRF final score
- output top `limit`

3) Decide engine availability:
- require both engines for hybrid (or allow degraded mode with warning).

### E. Engine support adjustments (minimal)

No engine changes are strictly required for RRF.

Optional improvements:
- SQLite: add a method that returns only ids + rank quickly, then fetch records by id.
- LanceDB: similarly, allow selecting only id + distance.

### F. Output / UX

- Human-readable output: show `id (score: X.XXXX)` as today.
- JSON output: include `_engine: 'hybrid'` and `_scores`.

### G. Tests

Add deterministic tests with a small synthetic dataset:

- Documents:
  - A: exact keyword match but low semantic similarity
  - B: high semantic similarity but no keyword match
  - C: both

Assertions:
- `--similar` returns B/C above A
- `--match` returns A/C above B
- `--hybrid` returns C first and then A/B depending on weights

---

## Proposed file-level TODO list

- [ ] `src/commands/find.ts`: add `--hybrid` flag; decide default behavior for hybrid policies.
- [ ] `src/data-finder.ts`: implement `handleHybrid()` and option parsing.
- [ ] `src/engines/sqlite-engine.ts`: (optional) add fast id fetch / rank helpers.
- [ ] `src/engines/lancedb-engine.ts`: (optional) add “id-only” query mode.
- [ ] `vitest/`: add tests for hybrid fusion.
- [ ] `USAGE.md`: document `--hybrid` and how scores are represented.

