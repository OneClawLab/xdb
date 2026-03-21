# xdb

Intent-driven data collection management CLI for AI agents. Transparently combines LanceDB (vector) and SQLite (relational/FTS) behind a unified interface.

## Features

- Dual-engine architecture: LanceDB for vector search, SQLite for metadata and full-text search
- Policy-based collections — declare intent, not implementation
- Automatic embedding via `pai embed` (no manual vector management)
- JSONL input/output for machine-to-machine workflows
- Upsert semantics with auto-generated UUIDs
- Embedding dimension tracking and consistency validation

## Install

### From npm

```bash
npm install -g @theclawlab/xdb
```

### From source

```bash
npm install
npm run build
npm link
```

Requires [pai] installed for embedding support.

## Quick Start

```bash
# Create a collection with hybrid (vector + FTS) policy
xdb col init my-docs --policy hybrid/knowledge-base

# Write data (embedding happens automatically via pai)
echo '{"id":"doc1","content":"How to compress files with tar"}' | xdb put my-docs

# Semantic search
xdb find my-docs "compress files" --similar

# Full-text search
xdb find my-docs "tar" --match

# SQL filtering
xdb find my-docs --where "json_extract(data, '$.category') = 'archive'"

# Batch write (JSONL via stdin)
cat records.jsonl | xdb put my-docs --batch
```

## Commands

| Command | Description |
|---------|-------------|
| `xdb put <collection> [json]` | Write data (single JSON arg or JSONL via stdin) |
| `xdb find <collection> [query]` | Search with `--similar`, `--match`, or `--where` |
| `xdb embed [text]` | Generate text embeddings via configured pai provider |
| `xdb col init <name> --policy <p>` | Create a collection with a policy |
| `xdb col list` | List collections with stats |
| `xdb col info <name>` | Show collection details |
| `xdb col rm <name>` | Delete a collection |
| `xdb policy list` | List available policies |
| `xdb config` | Manage xdb configuration |

## Policies

| Policy | Vector | FTS | Engine |
|--------|--------|-----|--------|
| `hybrid/knowledge-base` | `content` | yes | LanceDB + SQLite |
| `relational/structured-logs` | — | — | SQLite |
| `relational/simple-kv` | — | — | SQLite |
| `vector/feature-store` | `tensor` | — | LanceDB |

## Storage

```
~/.local/share/xdb/
└── collections/
    └── <name>/
        ├── collection_meta.json
        ├── vector.lance/
        └── relational.db
```

## Documentation

- **[USAGE.md](USAGE.md)** — Full usage guide with all providers, options, and examples
