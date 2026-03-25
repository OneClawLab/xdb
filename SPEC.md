# xdb - data collection management CLI command

An intent-driven data store CLI for AI Agents and M2M toolchains. Callers declare *what* they want (similar search, exact match, full-text, hybrid) — not *how* (vector DB, SQL). Internally hybridizes LanceDB (vector) and SQLite (relational/FTS) behind collection policies.

## 决策记录

1. **意图驱动**：调用者声明"我要找相似的"或"我要精确匹配"，而不指定"查询向量库"或"查询 SQL"。xdb 根据 collection policy 自动选择引擎。
2. **引擎混合**：内部透明整合 LanceDB（Vector）与 SQLite（Relational/FTS5）。通过 Policy 决定数据流向，调用者无需感知。
3. **Hybrid 默认**：`hybrid` policy 的集合在有 query 时自动使用混合检索（RRF 融合），无需显式传 `--hybrid`。
4. **机器友好**：强制标准 JSON/JSONL 输入输出，无交互式冗余。
5. **自包含 Collection**：每个 Collection 包含其独立的 Policy 快照，确保数据可移植。清理时直接删除目录即可。
6. **Embedding 配置复用 `pai`**：embedding provider 和模型从 `pai` 配置读取（`defaultEmbedProvider` / `defaultEmbedModel`），不重复配置。

## 1. Role

- **Data Storage**: Persist structured and unstructured data with automatic indexing.
- **Hybrid Search**: Semantic similarity (vector), keyword match (FTS5), and metadata filtering (SQL) — unified behind a single `find` command.
- **Embedding**: Expose vectorization as a standalone `embed` subcommand.
- **Collection Management**: Initialize, list, and remove self-contained data collections.

## 2. Tech Stack & Project Structure

遵循 `pai` repo 约定：

- **TypeScript + ESM** (Node 20+)
- **构建**: tsup (ESM, shebang banner)
- **测试**: vitest (unit, pbt, fixtures)
- **CLI 解析**: commander
- **Vector**: LanceDB
- **Relational/FTS**: SQLite (better-sqlite3)

## 3. Data Directory Layout

```
~/.local/share/xdb/
├── default.json               # Global config (API keys, default policy definitions)
└── collections/
    └── [collection_name]/
        ├── collection_meta.json # Policy snapshot at init time
        ├── vector.lance/        # LanceDB data directory
        └── relational.db        # SQLite database (metadata + FTS)
```

## 4. Collection Policies

策略定义了底层引擎的组合方式，存储于全局配置中。

| Policy | Vector Field | Relational Index | FTS5 | Engine Combination |
|--------|-------------|-----------------|------|-------------------|
| `knowledge-base` | `content` | Auto-detect | On | LanceDB + SQLite |
| `structured-logs` | None | All fields | Off | SQLite only |
| `feature-store` | `tensor` | `id` only | Off | LanceDB only |
| `simple-kv` | None | `key` | Off | SQLite only |

## 5. Data Protocol

### 5.1 Write Format

```json
{
  "id": "optional-unique-string",
  "content": "Main text content for semantic search",
  "metadata": {
    "author": "someone",
    "timestamp": 123456789
  },
  "any_other_field": "..."
}
```

### 5.2 Query Response (JSONL)

Each line is an independent result object:

```json
{"id":"...","content":"...","_score":0.985,"_engine":"lancedb"}
```

Hybrid search includes additional score detail:

```json
{"id":"...","content":"...","_score":0.0324,"_engine":"hybrid","_scores":{"vector":0.95,"fts":0.87,"final":0.0324,"sources":["vector","fts"],"rank":{"vector":1,"fts":2}}}
```

## 6. CLI Commands

### 6.1 Core Operations

#### `xdb put <collection>`

Write data to a collection.

**Input**: Single JSON string or JSONL via `stdin`.

**Args**:
- `--batch` (optional — enable batch mode; opens SQLite transaction, optimizes LanceDB writes)

**Behavior**: 自动根据 `id` 字段执行 `upsert`。若无 `id` 则自动生成 UUID。

#### `xdb find <collection> [query-text]`

Search a collection.

**Args**:
- `-H, --hybrid` — hybrid search: runs both vector and FTS, merges results via Reciprocal Rank Fusion (RRF). **Default behavior for `hybrid` policy collections when a query is provided.**
- `-s, --similar` — semantic similarity search only; reads query from `stdin` if `query-text` is empty
- `-m, --match` — keyword full-text search (FTS5) only
- `-w, --where` — SQL WHERE clause fragment for metadata filtering; can be combined with any search mode as a pre-filter
- `-l, --limit` — max results (default 10)

**Routing logic**:
1. `--similar` → vector search only (LanceDB)
2. `--match` → FTS only (SQLite)
3. `--hybrid` or (hybrid policy + query present, no explicit flag) → hybrid RRF fusion
4. `--where` only (no query) → structured filter (SQLite preferred, LanceDB fallback)

**Hybrid fallback**: if only one engine is available, `--hybrid` degrades gracefully:
- vector only → `--similar`
- FTS only → `--match`

**Output**: JSONL to stdout. Each line includes original data plus:
- `_score`: relevance score (cosine similarity for vector, FTS5 rank for match, RRF score for hybrid)
- `_engine`: source engine (`lancedb`, `sqlite`, or `hybrid`)
- `_scores` (hybrid only): per-engine scores and ranks `{ vector, fts, final, sources, rank }`

#### `xdb embed [text]`

Vectorize text using the configured embedding provider.

**Args**:
- `--batch` — batch mode; input is a JSON string array, each element vectorized independently
- `--json` — JSON output including model and usage metadata
- `--input-file <path>` — read input from file

**Input sources** (mutually exclusive): positional arg, stdin, `--input-file`.

**Output**: 向量以 float32 hex 编码（每维度 8 位十六进制字符串）。
- Plain text mode: one hex array per line, `["3f800000","bf800000",...]`
- JSON single: `{ "embedding": [...], "model": "...", "usage": { ... } }`
- JSON batch: `{ "embeddings": [[...], ...], "model": "...", "usage": { ... } }`

**截断行为**: 若输入超出模型 token 上限，自动截断并在 stderr 输出警告（含原始 token 数、截断后 token 数、模型上限）。

**配置来源**: embedding provider 和模型从 `pai` 配置读取（`defaultEmbedProvider` / `defaultEmbedModel`）。

### 6.2 Collection Management

#### `xdb col init <name>`

Initialize a new collection.

**Args**:
- `--policy <policy-name>` (required — one of the preset policies)
- `--params '{"model": "..."}'` (optional — override policy defaults, e.g. specify a different embedding model)

#### `xdb col list`

List all collections with stats (record count, disk usage, policy).

#### `xdb col rm <name>`

Physically delete a collection and all its index files.

## 7. Output Format

### 7.1 stdout / stderr Contract

- `stdout`: Command result data (JSONL search results, embed output, collection list).
- `stderr`: Progress, debug, error, and warning messages.

### 7.2 Human / Machine Readability

- Default output is machine-friendly (JSONL for `find`, hex arrays for `embed`).
- `--json` provides additional metadata wrapping where applicable.

## 8. Error Handling & Exit Codes

### 8.1 Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | Logic error (collection not found, query returned no results, etc.) |
| `2` | Usage/argument error (missing required args, invalid policy, etc.) |

### 8.2 Error Output

- Default: human-readable error to `stderr`.
- `--json` mode: `{"error": "...", "suggestion": "..."}`

## 9. Logging

xdb 作为无状态 CLI 工具，不维护独立日志文件。错误和警告输出到 stderr。

## 10. Evolutionary Path

1. **Phase 1 (Done)**: 实现基于 SQLite 和 LanceDB 的本地存储。支持 `put --batch` 和 `find --similar`。
2. **Phase 2 (Done)**: 实现 Hybrid Search (RRF)，将相似度结果与关键词结果合并排序。`hybrid` policy 下自动启用，支持 `--hybrid` 显式调用和单引擎降级。
3. **Phase 3 (Scaling)**: 引入 `xdb col snapshot` 和 `xdb col restore`，支持数据集的快速迁移和备份。

## 11. Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| (None) | xdb reads embedding config from `pai` config file | `~/.config/pai/default.json` |
