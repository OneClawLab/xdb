# 实现计划：xdb 核心功能 (Phase 1)

## 概述

将 xdb 设计文档转化为可执行的编码任务。采用 TypeScript + Node.js，使用 Commander.js 构建 CLI，`@lancedb/lancedb` 作为向量引擎，`better-sqlite3` 作为关系引擎，`pai embed` 作为向量化工具。测试使用 vitest + fast-check。

## Tasks

- [x] 1. 项目初始化与基础设施
  - [x] 1.1 初始化 TypeScript 项目结构
    - 创建 `package.json`、`tsconfig.json`、`tsup.config.ts`
    - 安装依赖：`commander`、`@lancedb/lancedb`、`better-sqlite3`、`uuid`
    - 安装开发依赖：`typescript`、`tsup`、`vitest`、`fast-check`、`@types/better-sqlite3`、`@types/uuid`
    - 创建 `src/cli.ts` 入口文件，注册 `col`、`put`、`find` 子命令骨架
    - _Requirements: 10.3_
  - [x] 1.2 实现错误处理基础模块 (`src/errors.ts`)
    - 定义 `XDBError` 类，包含 `exitCode` 和 `message`
    - 定义错误类型常量：`PARAMETER_ERROR(1)`、`RUNTIME_ERROR(2)`
    - 实现统一的错误输出函数（写入 stderr）
    - _Requirements: 10.3_

- [ ] 2. PolicyRegistry 与 CollectionManager
  - [x] 2.1 实现 PolicyRegistry (`src/policy-registry.ts`)
    - 定义 `PolicyConfig`、`FieldConfig` 接口
    - 实现内置策略定义（`hybrid/knowledge-base`、`relational/structured-logs`、`relational/simple-kv`、`vector/feature-store`）
    - 实现 `resolve(policyStr, params?)` 方法：解析 `main/minor` 格式，支持省略 minor
    - 实现 `validate(config)` 方法：验证 findCaps 与 main 引擎类型兼容性
    - 实现 `listPolicies()` 方法
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 9.8, 9.9, 9.11_
  - [x]* 2.2 编写 PolicyRegistry 属性测试
    - **Property 1: Policy 解析正确性** — 生成随机 main 类型，验证省略 minor 时解析结果等价于完整策略名
    - **Validates: Requirements 9.2**
    - **Property 2: findCaps 与引擎类型一致性** — 生成随机 PolicyConfig（含不兼容 findCaps），验证 validate 拒绝不兼容配置
    - **Validates: Requirements 9.11, 6.5, 7.4**
    - **Property 3: main 类型决定引擎组合** — 生成随机合法 PolicyConfig，验证引擎组合与 main 类型一致
    - **Validates: Requirements 9.6, 9.7, 9.8**
  - [x] 2.3 实现 CollectionManager (`src/collection-manager.ts`)
    - 实现 `init(name, policy)` 方法：创建目录结构，写入 `collection_meta.json`
    - 实现 `list()` 方法：扫描 collections 目录，读取每个集合的 meta 和统计信息
    - 实现 `remove(name)` 方法：递归删除集合目录
    - 实现 `load(name)` 和 `exists(name)` 辅助方法
    - _Requirements: 1.1, 1.2, 1.5, 2.1, 2.2, 3.1, 3.2, 11.3, 11.4_
  - [x]* 2.4 编写 CollectionManager 属性测试
    - **Property 4: params 覆盖后 Policy 快照正确性** — 生成随机策略和 params，验证合并后写入/读取一致
    - **Validates: Requirements 1.2, 9.9, 9.10**
    - **Property 5: 集合 init-then-rm round-trip** — 生成随机集合名和策略，验证创建后目录存在、删除后目录不存在
    - **Validates: Requirements 1.1, 3.1, 11.4**
    - **Property 6: col list 返回所有已创建集合** — 创建随机数量集合，验证 list 返回完整列表
    - **Validates: Requirements 2.1, 2.2**
    - **Property 14: CollectionMeta 序列化 round-trip** — 生成随机 CollectionMeta，验证序列化/反序列化一致
    - **Validates: Requirements 1.1, 9.10**

- [x] 3. 检查点 — 确保所有测试通过
  - 确保所有测试通过，如有问题请向用户确认。

- [ ] 4. 存储引擎实现
  - [x] 4.1 实现 SQLiteEngine (`src/engines/sqlite-engine.ts`)
    - 使用 `better-sqlite3` 打开/创建 `relational.db`
    - 实现 `initSchema(policy)` 方法：根据 Policy 创建 records 表和 FTS5 虚拟表
    - 实现 `upsert(records)` 和 `batchUpsert(records)` 方法（事务包裹）
    - 实现 `ftsSearch(query, limit)` 方法
    - 实现 `whereSearch(filter, limit)` 和 `ftsWhereSearch(query, filter, limit)` 方法
    - 实现 `countRows()` 和 `close()` 方法
    - _Requirements: 4.3, 4.5, 5.1, 7.1, 8.1, 8.3, 8.4_
  - [x] 4.2 实现 LanceDBEngine (`src/engines/lancedb-engine.ts`)
    - 使用 `@lancedb/lancedb` 连接到 `vector.lance/` 目录
    - 实现 `upsert(records)` 方法：写入含向量字段的记录
    - 实现 `vectorSearch(queryVector, options)` 方法：最近邻检索 + 可选预过滤
    - 实现 `filterSearch(filter, limit)` 方法：标量过滤查询
    - 实现 `countRows()` 和 `close()` 方法
    - _Requirements: 4.5, 6.1, 8.2, 8.6_
  - [x] 4.3 实现 Embedder (`src/embedder.ts`)
    - 通过 `child_process.execFile` 调用 `pai embed --json`
    - 实现 `embed(text)` 单条嵌入和 `embedBatch(texts)` 批量嵌入
    - 解析 `pai embed` 的 JSON 输出提取向量
    - 处理 `pai` 命令不存在或执行失败的错误
    - _Requirements: 6.1_

- [ ] 5. 数据写入与检索
  - [x] 5.1 实现 DataWriter (`src/data-writer.ts`)
    - 实现写入路由逻辑：根据 Policy findCaps 分发到对应引擎
    - 实现 `write(record)` 单条写入：自动生成 UUID、调用 Embedder 向量化、upsert
    - 实现 `writeBatch(records)` 批量写入：事务优化、容错处理、统计输出
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 5.1, 5.2, 5.3_
  - [x]* 5.2 编写 DataWriter 属性测试
    - **Property 7: 自动生成 UUID** — 生成随机无 id 记录，验证自动 id 为合法 UUID v4 且唯一
    - **Validates: Requirements 4.4**
    - **Property 8: Upsert 语义正确性** — 生成随机记录和更新数据，验证更新后只有一条最新记录
    - **Validates: Requirements 4.3**
    - **Property 9: 批量写入统计不变量** — 生成混合合法/非法 JSON 行，验证 inserted + updated + errors = 总行数
    - **Validates: Requirements 5.2, 5.3**
  - [x] 5.3 实现 DataFinder (`src/data-finder.ts`)
    - 实现查询路由逻辑：根据 `--similar`/`--match`/`--where` 分发到对应引擎
    - 实现 `find(query, options)` 方法：调用 Embedder 向量化查询文本、执行检索、格式化输出
    - 实现能力检查：验证集合 Policy 是否支持请求的检索类型
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 7.1, 7.2, 7.3, 7.4, 8.1, 8.2, 8.3, 8.4, 8.5, 8.6_
  - [x]* 5.4 编写 DataFinder 属性测试
    - **Property 10: 检索结果输出格式** — 生成随机 SearchResult，验证每行为合法 JSON 且包含 _score 和 _engine
    - **Validates: Requirements 6.3, 7.2, 10.2**
    - **Property 11: 检索结果数量不超过 limit** — 生成随机 limit 和数据集，验证结果数量约束
    - **Validates: Requirements 6.4, 7.3**
    - **Property 12: where 过滤结果满足条件** — 生成随机数据和简单 WHERE 条件，验证结果满足条件
    - **Validates: Requirements 8.4**

- [x] 6. 检查点 — 确保所有测试通过
  - 确保所有测试通过，如有问题请向用户确认。

- [ ] 7. CLI 命令接入与集成
  - [x] 7.1 实现 `col` 子命令 (`src/commands/col.ts`)
    - 接入 `col init`：解析 `--policy` 和 `--params`，调用 CollectionManager.init
    - 接入 `col list`：调用 CollectionManager.list，JSONL 输出到 stdout
    - 接入 `col rm`：调用 CollectionManager.remove
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 2.1, 2.2, 3.1, 3.2_
  - [x] 7.2 实现 `put` 命令 (`src/commands/put.ts`)
    - 解析位置参数 JSON 或 stdin JSONL 输入
    - 支持 `--batch` 模式
    - 调用 DataWriter 写入，输出统计信息
    - _Requirements: 4.1, 4.2, 4.6, 4.7, 5.1, 5.2, 5.3_
  - [x] 7.3 实现 `find` 命令 (`src/commands/find.ts`)
    - 解析 `--similar`/`--match`/`--where`/`--limit` 参数
    - 支持位置参数和 stdin 查询文本
    - 调用 DataFinder 检索，JSONL 输出到 stdout
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 7.1, 7.2, 7.3, 7.4, 8.1, 8.2, 8.3, 8.4, 8.5, 8.6_
  - [x]* 7.4 编写数据 round-trip 属性测试
    - **Property 13: 数据 round-trip 一致性** — 生成随机 JSON 数据，通过 DataWriter 写入后通过 DataFinder 读取，验证数据等价
    - **Validates: Requirements 10.4**

- [x] 8. 最终检查点 — 确保所有测试通过
  - 确保所有测试通过，如有问题请向用户确认。

## 备注

- 标记 `*` 的子任务为可选任务（属性测试），可跳过以加速 MVP 开发
- 每个任务引用了具体的需求编号以确保可追溯性
- 检查点任务用于阶段性验证
- 属性测试使用 fast-check，每个属性至少 100 次迭代
