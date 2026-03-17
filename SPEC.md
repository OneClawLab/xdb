# CLI Specification: `xdb` (The Intent-Oriented Data Hub)

**Version:** 1.1.0
**Status:** Stable-Design
**Target:** AI Agents, CLI Toolchains, M2M (Machine-to-Machine)

## 1. 设计哲学 (Design Philosophy)

* **意图驱动 (Intent-Driven):** 调用者声明“我要找相似的”或“我要精确匹配”，而不指定“查询向量库”或“查询 SQL”。
* **引擎混合 (Engine Hybridization):** 内部透明整合 LanceDB (Vector) 与 SQLite (Relational/FTS)。
* **机器友好 (M2M Optimized):** 强制标准 JSON/JSONL 输入输出，无交互式冗余。
* **自包含 (Self-contained):** 每一个 Collection 包含其独立的 Policy 快照，确保数据可移植。

---

## 2. 存储架构 (Storage Architecture)

`xdb` 采用双引擎冗余存储架构，通过 Policy 决定数据流向：

* **LanceDB:** 负责 `vector` 索引。存储高维向量及其对应的原始文档片段。
* **SQLite:** 负责 `metadata` 索引与 `full-text` 索引 (FTS5)。处理结构化过滤。
* **Local FS:** 使用 JSON 存储 Collection 级别的 Meta 信息与 Policy 快照。

---

## 3. 命令定义 (Command Suite)

### 3.1 核心操作 (Core Operations)

#### `xdb put <collection>`

写入数据。

* **输入:** 单个 JSON 字符串或通过 `stdin` 传入 JSONL。
* **参数:**
* `--batch`: 启用批量模式。开启 SQLite 事务，优化 LanceDB 写入。


* **行为:** 自动根据 `id` 字段执行 `upsert`。若无 `id` 则自动生成 UUID。

#### `xdb find <collection> [query-text]`

检索数据。

* **参数:**
* `-s, --similar`: 语义查找。若 `query-text` 为空，则从 `stdin` 读取向量或文本。
* `-m, --match`: 关键词全文检索 (FTS5)。
* `-w, --where`: SQL 片段过滤（例如 `"status = 'active' AND priority > 5"`）。
* `-l, --limit`: 限制返回条数（默认 10）。


* **输出:** JSONL 格式，包含原始数据及系统元数据（如 `_score`, `_distance`）。

---

#### `xdb embed [text]`

直接调用已配置的 embedding provider 对文本进行向量化，输出向量数据。

* **参数:**
  * `--batch`: 批量模式，输入为 JSON 字符串数组，每个元素独立向量化。
  * `--json`: JSON 格式输出，包含 model 和 usage 元数据。
  * `--input-file <path>`: 从文件读取输入。

* **输入来源**（三选一，互斥）：位置参数、stdin、`--input-file`。

* **输出:** 向量以 float32 hex 编码（每维度 8 位十六进制字符串）。
  * 纯文本模式：每行一个 hex 数组，`["3f800000","bf800000",...]`
  * JSON 单条：`{ "embedding": [...], "model": "...", "usage": { ... } }`
  * JSON 批量：`{ "embeddings": [[...], ...], "model": "...", "usage": { ... } }`

* **截断行为:** 若输入超出模型 token 上限，自动截断并在 stderr 输出警告（含原始 token 数、截断后 token 数、模型上限）。

* **配置来源:** embedding provider 和模型从 `pai` 配置读取（`defaultEmbedProvider` / `defaultEmbedModel`）。

---

### 3.2 集合管理 (Collection Management)

#### `xdb col init <name>`

初始化集合。

* **参数:**
* `--policy <policy-name>`: 必选。指定预设的使用场景策略。
* `--params '{"model": "..."}'`: 覆盖 Policy 中的默认参数（如指定不同的 Embedding Model）。



#### `xdb col list`

列出所有集合及其统计信息（数据量、物理占用、所属策略）。

#### `xdb col rm <name>`

物理删除集合及其所有索引文件。

---

## 4. 预设策略 (Collection Policies)

策略定义了底层引擎的组合方式，存储于全局配置中。

| 策略 (Policy) | 向量化字段 | 关系索引字段 | FTS5 全文搜索 | 引擎组合 |
| --- | --- | --- | --- | --- |
| **`knowledge-base`** | `content` | 自动识别 | 开启 | LanceDB + SQLite |
| **`structured-logs`** | 无 | 全部 | 关闭 | SQLite |
| **`feature-store`** | `tensor` | 仅 `id` | 关闭 | LanceDB |
| **`simple-kv`** | 无 | `key` | 关闭 | SQLite |

---

## 5. 数据协议 (Data Protocol)

### 5.1 写入格式

```json
{
  "id": "optional-unique-string",
  "content": "主要文本内容，用于语义检索",
  "metadata": {
    "author": "someone",
    "timestamp": 123456789
  },
  "any_other_field": "..."
}

```

### 5.2 查询响应 (JSONL)

每一行是一个独立的结果对象：

```json
{
  "id": "...",
  "content": "...",
  "_score": 0.985, 
  "_engine": "lancedb",
  "metadata": { ... }
}

```

---

## 6. 物理目录结构 (Physical Layout)

```bash
~/.local/share/xdb/
├── default.json               # 全局 API Key, 默认 Policy 定义
└── collections/
    └── [collection_name]/
        ├── collection_meta.json # 实例化时的 Policy 快照
        ├── vector.lance/        # LanceDB 数据目录
        └── relational.db        # SQLite 数据库文件 (Meta + FTS)

```

---

## 7. 进化路径 (Evolutionary Path)

1. **Phase 1 (Immediate):** 实现基于 SQLite 和 LanceDB 的本地存储。支持 `put --batch` 和 `find --similar`。
2. **Phase 2 (Optimization):** 实现 **Hybrid Search (RRF)**，将相似度结果与关键词结果合并排序。
3. **Phase 3 (Scaling):** 引入 `xdb col snapshot` 和 `xdb col restore`，支持数据集的快速迁移和备份。
