# 需求文档：xdb 核心功能 (Phase 1)

## 简介

`xdb` 是一个意图驱动的数据中枢 CLI 工具，面向 AI Agent 和 M2M 场景。调用者通过声明意图（语义查找、精确匹配、全文检索）来操作数据，而无需关心底层引擎细节。Phase 1 实现基于 SQLite 和 LanceDB 的本地双引擎存储，支持集合管理、数据写入（含批量模式）、以及多种检索方式。所有输入输出均采用标准 JSON/JSONL 格式，确保机器友好。

## 术语表

- **XDB_CLI**: `xdb` 命令行工具的顶层入口，负责解析子命令并分发执行
- **Collection**: 数据集合，包含独立的 Policy 快照、向量索引和关系数据库
- **Policy**: 预设策略，采用 `main/minor` 两段式命名。`main` 为引擎类型（`hybrid`/`relational`/`vector`），`minor` 为场景名称（可省略，使用默认值）。策略通过字段的 `findCaps` 声明检索能力
- **FindCaps**: 字段检索能力声明，可选值为 `similar`（语义检索，需向量化）和 `match`（全文检索，需 FTS5 索引）。`where` 过滤为隐式支持，所有存入引擎的字段均可用于条件过滤
- **Collection_Manager**: 集合管理模块，负责集合的初始化、列举和删除
- **Data_Writer**: 数据写入模块，负责将 JSON 数据写入对应引擎（LanceDB 和/或 SQLite）
- **Data_Finder**: 数据检索模块，负责根据意图将查询路由到对应引擎并返回结果
- **LanceDB_Engine**: LanceDB 向量引擎，负责向量索引的存储和语义检索
- **SQLite_Engine**: SQLite 关系引擎，负责元数据索引、全文检索 (FTS5) 和结构化过滤
- **Policy_Registry**: 策略注册表，存储所有预设策略的定义
- **Collection_Meta**: 集合元信息文件 (`collection_meta.json`)，包含实例化时的 Policy 快照
- **Upsert**: 写入操作语义，若记录 `id` 已存在则更新，否则插入新记录

## 需求

### 需求 1：集合初始化

**用户故事：** 作为开发者，我希望通过 `xdb col init` 命令创建新的数据集合，以便为不同用途的数据提供隔离的存储空间。

#### 验收标准

1. WHEN 用户执行 `xdb col init <name> --policy <policy-name>` 时，THE Collection_Manager SHALL 在 `~/.local/share/xdb/collections/<name>/` 下创建集合目录结构，并将 Policy 快照写入 `collection_meta.json`
2. WHEN 用户指定 `--params` 参数时，THE Collection_Manager SHALL 将自定义参数合并到 Policy 快照中，覆盖 Policy 的默认值
3. IF 用户未指定 `--policy` 参数，THEN THE XDB_CLI SHALL 返回参数错误（退出码 1）并在 stderr 输出描述性错误信息
4. IF 指定的 Policy 名称不存在于 Policy_Registry 中，THEN THE Collection_Manager SHALL 返回参数错误（退出码 1）并在 stderr 输出可用策略列表（按 `main/minor` 格式）
5. IF 同名集合已存在，THEN THE Collection_Manager SHALL 返回错误（退出码 1）并在 stderr 提示集合已存在

### 需求 2：集合列举

**用户故事：** 作为开发者，我希望通过 `xdb col list` 命令查看所有已创建的集合及其统计信息，以便了解当前数据存储状态。

#### 验收标准

1. WHEN 用户执行 `xdb col list` 时，THE Collection_Manager SHALL 以 JSONL 格式输出所有集合的信息，每行包含集合名称、所属策略、数据条数和物理占用大小
2. WHEN 不存在任何集合时，THE Collection_Manager SHALL 输出空结果（无输出行）

### 需求 3：集合删除

**用户故事：** 作为开发者，我希望通过 `xdb col rm` 命令删除不再需要的集合，以便释放存储空间。

#### 验收标准

1. WHEN 用户执行 `xdb col rm <name>` 时，THE Collection_Manager SHALL 物理删除该集合的整个目录（包括 LanceDB 数据、SQLite 数据库和元信息文件）
2. IF 指定的集合不存在，THEN THE Collection_Manager SHALL 返回错误（退出码 1）并在 stderr 提示集合不存在

### 需求 4：数据写入

**用户故事：** 作为开发者，我希望通过 `xdb put` 命令将数据写入集合，以便存储和索引我的数据。

#### 验收标准

1. WHEN 用户执行 `xdb put <collection>` 并通过位置参数提供单个 JSON 字符串时，THE Data_Writer SHALL 解析该 JSON 并将数据写入集合对应的引擎
2. WHEN 用户通过 stdin 管道传入 JSONL 数据时，THE Data_Writer SHALL 逐行解析并写入每条记录
3. WHEN 写入的 JSON 数据包含 `id` 字段时，THE Data_Writer SHALL 执行 upsert 操作（已存在则更新，不存在则插入）
4. WHEN 写入的 JSON 数据不包含 `id` 字段时，THE Data_Writer SHALL 自动生成 UUID 作为记录的 `id`
5. THE Data_Writer SHALL 根据集合的 Policy 字段配置决定数据流向：将具有 `similar` findCaps 的字段写入 LanceDB_Engine 进行向量化，将其余字段写入 SQLite_Engine 进行关系索引
6. IF 输入的 JSON 格式不合法，THEN THE Data_Writer SHALL 返回参数错误（退出码 1）并在 stderr 输出描述性错误信息
7. IF 指定的集合不存在，THEN THE XDB_CLI SHALL 返回错误（退出码 1）并在 stderr 提示集合不存在

### 需求 5：批量写入

**用户故事：** 作为开发者，我希望通过 `--batch` 模式高效地批量写入大量数据，以便在数据导入场景中获得更好的性能。

#### 验收标准

1. WHEN 用户指定 `xdb put <collection> --batch` 并通过 stdin 传入 JSONL 数据时，THE Data_Writer SHALL 开启 SQLite 事务并优化 LanceDB 批量写入
2. WHEN 批量写入完成时，THE Data_Writer SHALL 以 JSON 格式输出写入统计信息（插入条数、更新条数、错误条数）到 stdout
3. IF 批量写入过程中某条记录解析失败，THEN THE Data_Writer SHALL 跳过该记录、在 stderr 输出警告信息，并继续处理后续记录

### 需求 6：语义检索

**用户故事：** 作为开发者，我希望通过 `xdb find --similar` 进行语义相似度检索，以便找到与查询文本语义相近的数据。

#### 验收标准

1. WHEN 用户执行 `xdb find <collection> <query-text> --similar` 时，THE Data_Finder SHALL 通过 Embedder 调用 `pai embed` 将查询文本转换为向量，并在 LanceDB_Engine 中执行最近邻检索，返回完整的原始记录数据
2. WHEN 用户未提供 `query-text` 但指定了 `--similar` 时，THE Data_Finder SHALL 从 stdin 读取查询文本
3. THE Data_Finder SHALL 以 JSONL 格式输出检索结果，每行包含原始数据及 `_score` 和 `_engine` 系统元数据字段
4. THE Data_Finder SHALL 默认返回最多 10 条结果，用户可通过 `--limit` 参数覆盖
5. IF 集合的 Policy 中没有任何字段声明 `similar` findCaps（如 `relational/*` 策略），THEN THE Data_Finder SHALL 返回错误（退出码 1）并提示该集合不支持语义检索

### 需求 7：全文检索

**用户故事：** 作为开发者，我希望通过 `xdb find --match` 进行关键词全文检索，以便通过关键词快速定位数据。

#### 验收标准

1. WHEN 用户执行 `xdb find <collection> <query-text> --match` 时，THE Data_Finder SHALL 在 SQLite_Engine 的 FTS5 索引中执行全文检索
2. THE Data_Finder SHALL 以 JSONL 格式输出检索结果，每行包含原始数据及 `_score` 和 `_engine` 系统元数据字段
3. THE Data_Finder SHALL 默认返回最多 10 条结果，用户可通过 `--limit` 参数覆盖
4. IF 集合的 Policy 中没有任何字段声明 `match` findCaps（如 `vector/*`、`relational/simple-kv` 策略），THEN THE Data_Finder SHALL 返回错误（退出码 1）并提示该集合不支持全文检索

### 需求 8：结构化过滤

**用户故事：** 作为开发者，我希望通过 `--where` 参数对数据进行结构化条件过滤，以便精确筛选符合条件的记录。

#### 验收标准

1. WHEN 用户指定 `--where` 参数时，THE Data_Finder SHALL 将 SQL 片段作为 WHERE 子句应用到 SQLite_Engine 查询中
2. WHEN `--where` 与 `--similar` 组合使用时，THE Data_Finder SHALL 在 LanceDB_Engine 中应用原生预过滤（pre-filter），再执行向量检索；若集合同时包含 SQLite_Engine，则在 SQLite_Engine 中也应用过滤条件
3. WHEN `--where` 与 `--match` 组合使用时，THE Data_Finder SHALL 在 SQLite_Engine 中同时应用 FTS5 检索和 WHERE 条件过滤
4. WHEN 单独使用 `--where`（不带 `--similar` 或 `--match`）时，THE Data_Finder SHALL 直接在 SQLite_Engine 中执行条件查询
5. IF `--where` 参数包含非法 SQL 片段，THEN THE Data_Finder SHALL 返回参数错误（退出码 1）并在 stderr 输出描述性错误信息
6. IF 集合的 Policy 引擎组合为仅 LanceDB 且单独使用 `--where`（不带 `--similar`），THEN THE Data_Finder SHALL 将过滤条件转换为 LanceDB 原生过滤表达式执行查询

### 需求 9：预设策略系统

**用户故事：** 作为开发者，我希望系统提供基于引擎类型的两段式策略命名（`main/minor`），并通过 `findCaps` 统一声明字段的检索能力，以便直观地选择引擎组合并灵活适配各种数据存储场景。

#### 验收标准

1. THE Policy_Registry SHALL 采用 `main/minor` 两段式策略命名，其中 `main` 为引擎类型（`hybrid`、`relational`、`vector`），`minor` 为场景名称
2. WHEN 用户省略 `minor` 部分（如 `--policy hybrid`）时，THE Policy_Registry SHALL 使用该 `main` 类型的默认场景
3. THE Policy_Registry SHALL 通过 `fields` 配置声明每个字段的检索能力（`findCaps`），其中 `similar` 表示语义检索（需向量化）、`match` 表示全文检索（需 FTS5 索引）
4. THE Policy_Registry SHALL 将所有存入引擎的字段隐式支持 `where` 条件过滤，无需显式声明
5. THE Policy_Registry SHALL 内置以下预设策略：
   - `hybrid/knowledge-base`（`hybrid` 的默认场景）：`content` 字段 findCaps 为 `[similar, match]`，其余字段自动索引，引擎组合为 LanceDB + SQLite
   - `relational/structured-logs`（`relational` 的默认场景）：无 `similar`/`match` 字段，全部字段为关系索引，引擎组合为仅 SQLite
   - `relational/simple-kv`：无 `similar`/`match` 字段，`key` 为关系索引字段，引擎组合为仅 SQLite
   - `vector/feature-store`（`vector` 的默认场景）：`tensor` 字段 findCaps 为 `[similar]`，引擎组合为仅 LanceDB，存储完整记录并支持原生过滤
6. WHEN `main` 为 `hybrid` 时，THE Policy_Registry SHALL 确保引擎组合包含 LanceDB 和 SQLite
7. WHEN `main` 为 `relational` 时，THE Policy_Registry SHALL 确保引擎组合仅包含 SQLite
8. WHEN `main` 为 `vector` 时，THE Policy_Registry SHALL 确保引擎组合仅包含 LanceDB
9. THE Policy_Registry SHALL 允许通过 `--params` 覆盖策略的字段配置（`fields`），以便自定义哪些字段具备 `similar` 或 `match` 能力
10. WHEN 用户通过 `--params` 覆盖字段配置时，THE Collection_Manager SHALL 将覆盖后的完整配置写入 Policy 快照
11. IF 用户通过 `--params` 指定的字段 findCaps 与 `main` 引擎类型冲突（如在 `relational` 策略下声明 `similar`，或在 `vector` 策略下声明 `match`），THEN THE Collection_Manager SHALL 返回参数错误（退出码 1）并在 stderr 提示 findCaps 与引擎类型不兼容

### 需求 10：数据协议与序列化

**用户故事：** 作为开发者，我希望数据的输入输出遵循统一的 JSON/JSONL 协议，以便在自动化流程中可靠地解析和处理数据。

#### 验收标准

1. THE Data_Writer SHALL 接受符合数据协议的 JSON 对象作为写入输入，包含可选的 `id`、`content`、`metadata` 及任意扩展字段
2. THE Data_Finder SHALL 以 JSONL 格式输出查询结果，每行为一个独立的 JSON 对象，包含原始数据字段及 `_score`、`_engine` 系统元数据
3. THE XDB_CLI SHALL 将所有错误信息输出到 stderr，将数据结果输出到 stdout，确保 stdout/stderr 分离
4. FOR ALL 合法的 JSON 输入数据，写入后再通过精确查询读取，THE Data_Finder SHALL 返回与原始输入等价的数据（round-trip 一致性）

### 需求 11：物理目录与配置管理

**用户故事：** 作为开发者，我希望 xdb 的数据和配置存储在标准目录下，以便管理和备份。

#### 验收标准

1. THE XDB_CLI SHALL 使用 `~/.local/share/xdb/` 作为默认数据根目录
2. THE XDB_CLI SHALL 在数据根目录下维护 `config.json` 全局配置文件，存储 API Key 和 Policy 定义
3. WHEN 数据根目录不存在时，THE XDB_CLI SHALL 在首次操作时自动创建目录结构
4. THE Collection_Manager SHALL 为每个集合在 `collections/<name>/` 下维护独立的目录，包含 `collection_meta.json`、`vector.lance/`（如适用）和 `relational.db`（如适用）
