# xdb 使用指南

`xdb` 是一个意图驱动的数据中心 CLI，为 AI Agent 和 CLI 工具链设计。内部透明整合 LanceDB（向量）与 SQLite（关系/全文检索），调用者只需声明意图。

## 安装

```bash
npm install
npm run build
npm link   # 全局安装 xdb 命令
```

向量化功能依赖 [pai] 命令。请确保 `pai` 已安装并配置了 embedding provider：

```bash
pai model default --embed-provider openai --embed-model text-embedding-3-small
```

## 文本向量化

### `xdb embed`

直接调用已配置的 embedding provider 对文本进行向量化，输出向量数据。

```bash
# 单条文本
xdb embed "how to compress files"

# 从 stdin
echo "database optimization" | xdb embed

# 从文件
xdb embed --input-file document.txt

# 批量模式（输入为 JSON 字符串数组）
xdb embed --batch '["hello","world","foo"]'

# JSON 输出（含模型和用量信息）
xdb embed "hello" --json
```

**选项：**
- `--batch` — 批量模式，输入为 JSON 字符串数组
- `--json` — JSON 格式输出（含 model、usage 元数据）
- `--input-file <path>` — 从文件读取输入

**输入来源**（三选一，互斥）：
1. 位置参数：`xdb embed "text"`
2. stdin：`echo "text" | xdb embed`
3. 文件：`xdb embed --input-file file.txt`

**输出格式：**

纯文本（默认）— 每行一个 hex 编码向量数组：
```
["3f800000","bf800000",...]
```

JSON 模式（`--json`）— 单条：
```json
{"embedding":["3f800000",...],"model":"text-embedding-3-small","usage":{"prompt_tokens":2,"total_tokens":2}}
```

JSON 模式（`--json --batch`）— 批量：
```json
{"embeddings":[["3f800000",...],["3f000000",...]],"model":"text-embedding-3-small","usage":{"prompt_tokens":4,"total_tokens":4}}
```

向量以 float32 hex 编码（每个维度 8 位十六进制字符串），精度无损且比 JSON 数字数组更紧凑。

若输入文本超出模型 token 上限，会自动截断并在 stderr 输出警告。

embedding provider 和模型通过 `pai` 配置：

```bash
pai model default --embed-provider openai --embed-model text-embedding-3-small
```

## 集合管理

### 创建集合

每个集合需要指定一个 policy，决定底层引擎组合和数据处理方式：

```bash
# 混合模式：向量 + 全文检索（最常用）
xdb col init my-docs --policy hybrid/knowledge-base

# 纯关系模式：结构化日志
xdb col init logs --policy relational/structured-logs

# 纯向量模式：特征存储
xdb col init features --policy vector/feature-store

# 简单键值对
xdb col init cache --policy relational/simple-kv
```

policy 可以只写主类型，自动使用默认子类型：

```bash
xdb col init my-docs --policy hybrid    # 等同于 hybrid/knowledge-base
xdb col init logs --policy relational   # 等同于 relational/structured-logs
```

自定义 policy 参数（覆盖默认字段配置）：

```bash
xdb col init my-col --policy hybrid/knowledge-base \
  --params '{"fields":{"title":{"findCaps":["match"]}}}'
```

### 查看集合

```bash
xdb col list
```

输出 JSONL，每行一个集合信息：

```json
{"name":"my-docs","policy":"hybrid/knowledge-base","recordCount":42,"sizeBytes":102400,"embeddingDimension":1536}
```

### 查看集合详情

```bash
xdb col info my-docs
```

输出集合的完整信息，包括 policy 快照、字段配置、记录数等：

```
name:       my-docs
createdAt:  2025-01-15T10:30:00.000Z
policy:     hybrid/knowledge-base
engines:    hybrid
autoIndex:  true
records:    42
size:       100.0 KB
embedDim:   1536
fields:
  content  findCaps=[similar, match]
```

也支持 `--json` 输出：

```bash
xdb col info my-docs --json
```

### 删除集合

```bash
xdb col rm my-docs
```

物理删除集合目录及所有索引文件。

## 写入数据

### 单条写入

```bash
# 通过位置参数传入 JSON
xdb put my-docs '{"id":"doc1","content":"How to use tar for compression"}'

# 通过 stdin 传入
echo '{"content":"Git branching strategies"}' | xdb put my-docs
```

- `id` 字段可选，缺省时自动生成 UUID
- 相同 `id` 的记录会被 upsert（更新已有记录）
- `hybrid/knowledge-base` policy 下，`content` 字段会自动向量化并建立全文索引

### 批量写入

```bash
# JSONL 格式，每行一个 JSON 对象
cat data.jsonl | xdb put my-docs --batch
```

`--batch` 模式会：
- 开启 SQLite 事务
- 批量调用 `pai embed --batch` 进行向量化
- 输出写入统计到 stdout

```json
{"inserted":95,"updated":5,"errors":0}
```

## 检索数据

### 语义搜索（--similar）

基于向量相似度检索，需要集合 policy 包含 `similar` 能力的字段：

```bash
xdb find my-docs "how to compress files" --similar
xdb find my-docs "网络调试工具" --similar --limit 5
```

也可以通过 stdin 传入查询文本：

```bash
echo "database optimization" | xdb find my-docs --similar
```

### 全文检索（--match）

基于 SQLite FTS5 的关键词匹配：

```bash
xdb find my-docs "tar compression" --match
```

### 条件过滤（--where）

SQL WHERE 子句，作用于 SQLite 的 records 表：

```bash
xdb find my-docs --where "json_extract(data, '$.category') = 'network'"
xdb find my-docs --where "json_extract(data, '$.priority') > 5" --limit 20
```

### 组合查询

`--match` 和 `--where` 可以组合使用：

```bash
xdb find my-docs "compression" --match --where "json_extract(data, '$.category') = 'archive'"
```

### 输出格式

所有检索结果以 JSONL 输出，每行包含原始数据和系统元数据：

```json
{"id":"doc1","content":"How to use tar...","category":"archive","_score":0.95,"_engine":"lancedb"}
{"id":"doc2","content":"Gzip compression...","category":"archive","_score":0.87,"_engine":"lancedb"}
```

- `_score`: 相关度分数（语义搜索为 `1/(1+distance)`，全文检索为 FTS5 rank）
- `_engine`: 结果来源引擎（`lancedb` 或 `sqlite`）

## Policy 详解

### 查看可用 Policy

```bash
xdb policy list
```

输出所有内置 policy 的详细信息：

```
hybrid/knowledge-base
  engines:    LanceDB + SQLite
  fields:     content [similar, match]
  autoIndex:  yes
relational/structured-logs
  engines:    SQLite
  fields:     (none)
  autoIndex:  yes
relational/simple-kv
  engines:    SQLite
  fields:     (none)
  autoIndex:  no
vector/feature-store
  engines:    LanceDB
  fields:     tensor [similar]
  autoIndex:  no
```

也支持 `--json` 输出：

```bash
xdb policy list --json
```

### Policy 对照表

| Policy | 向量化字段 | 全文检索 | 自动索引 | 适用场景 |
|--------|-----------|---------|---------|---------|
| `hybrid/knowledge-base` | `content` | `content` | 是 | 文档、知识库、命令索引 |
| `relational/structured-logs` | — | — | 是 | 日志、事件、结构化数据 |
| `relational/simple-kv` | — | — | 否 | 缓存、配置、键值对 |
| `vector/feature-store` | `tensor` | — | 否 | ML 特征向量、嵌入存储 |

policy 决定了：
- 哪些字段会被向量化（通过 `pai embed`）
- 哪些字段会建立全文索引（FTS5）
- `find` 命令支持哪些搜索意图（`--similar`、`--match`）

## 存储结构

```
~/.local/share/xdb/
└── collections/
    └── my-docs/
        ├── collection_meta.json   # Policy 快照 + 元数据
        ├── vector.lance/          # LanceDB 向量数据
        └── relational.db          # SQLite 关系数据 + FTS
```

每个集合完全自包含，可以直接复制目录进行迁移。

### 在脚本中使用

```bash
# 写入并查询
echo '{"id":"note1","content":"Remember to update DNS records"}' | xdb put notes
xdb find notes "DNS" --match | jq '.[].content'

# 批量导入 CSV（转换为 JSONL）
cat data.csv | python3 -c "
import csv, json, sys
for row in csv.DictReader(sys.stdin):
    print(json.dumps(row))
" | xdb put my-data --batch
```

### 在 LLM Agent 中使用

xdb 的 JSONL 输入输出设计天然适合 Agent 调用：

```bash
# Agent 存储知识
xdb put knowledge '{"id":"fact-1","content":"The speed of light is 299792458 m/s","category":"physics"}'

# Agent 检索知识
xdb find knowledge "light speed" --similar --limit 1
```

## 退出码

| 退出码 | 含义 |
|--------|------|
| 0 | 成功 |
| 2 | 参数错误 / 集合不存在 / 能力不匹配 |
| 1 | 运行时错误（引擎故障、pai 调用失败等） |

## 注意事项

- 向量化依赖 `pai embed`，首次写入含向量字段的数据时会记录 embedding 维度，后续写入必须使用相同维度的模型
- 更换 embedding 模型需要删除并重建集合
- `--where` 子句直接作用于 SQLite，使用 `json_extract(data, '$.field')` 访问 JSON 字段