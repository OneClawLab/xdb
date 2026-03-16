# 实现计划：xdb embed 服务

## 概述

将 pai 的向量化服务功能移植到 xdb，使 xdb 独立处理向量计算。核心步骤：复制 pai 模块 → 新增配置管理 → 替换 Embedder → 新增 CLI 命令。

## 任务

- [x] 1. 复制 pai 核心模块到 xdb
  - [x] 1.1 复制 `pai/src/embedding-client.ts` 到 `xdb/src/embedding-client.ts`
    - 将 `PAIError` 替换为 `XDBError`
    - 将 `ExitCode.PARAMETER_ERROR` 替换为 `PARAMETER_ERROR`（值为 2）
    - 将 `ExitCode.RUNTIME_ERROR` 替换为 `RUNTIME_ERROR`（值为 1）
    - 将 `ExitCode.API_ERROR` 替换为 `RUNTIME_ERROR`（xdb 无独立 API 错误码）
    - 保留 `EmbeddingClient`、`EmbeddingRequest`、`EmbeddingResponse`、`EmbeddingClientConfig` 接口不变
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9_
  - [x] 1.2 复制 `pai/src/embed-io.ts` 到 `xdb/src/embed-io.ts`
    - 将 `PAIError` 替换为 `XDBError`，`ExitCode.PARAMETER_ERROR` 替换为 `PARAMETER_ERROR`
    - 保留 `vectorToHex`、`parseBatchInput`、`formatEmbeddingOutput` 函数不变
    - _Requirements: 6.3, 6.4, 6.5, 6.6_
  - [x] 1.3 复制 `pai/src/embedding-models.ts` 到 `xdb/src/embedding-models.ts`
    - 无需修改（无错误类型依赖）
    - _Requirements: 6.1, 6.2_

- [x] 2. 实现 XdbConfigManager
  - [x] 2.1 创建 `xdb/src/config-manager.ts`，实现 `XdbConfigManager` 类
    - 定义 `XdbProviderConfig`（name, apiKey?, baseUrl?, api?）和 `XdbConfig`（defaultEmbedProvider?, defaultEmbedModel?, providers[]）接口
    - 实现 `load(): Promise<XdbConfig>`，配置文件不存在时返回空默认配置
    - 实现 `save(config: XdbConfig): Promise<void>`，自动创建目录
    - 实现 `resolveApiKey(providerName: string): Promise<string>`，优先级：`XDB_<PROVIDER>_API_KEY` 环境变量 > 配置文件 apiKey
    - 实现 `resolveEmbedConfig()`，未配置时抛出 `XDBError(PARAMETER_ERROR, ...)`
    - 默认配置路径：`~/config/xdb/default.json`（支持构造函数注入自定义路径）
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 4.1, 4.2, 4.3_
  - [x]* 2.2 为 XdbConfigManager 编写单元测试（`vitest/unit/config-manager.test.ts`）
    - 测试：配置文件不存在返回默认配置
    - 测试：目录自动创建
    - 测试：非法 JSON 返回错误
    - 测试：凭证解析优先级（环境变量 > 配置文件）
    - 测试：未配置 provider/model 时 resolveEmbedConfig 抛出错误
    - _Requirements: 1.5, 1.6, 1.7, 4.1, 4.2, 4.3_
  - [x]* 2.3 为 XdbConfigManager 编写属性测试（`vitest/pbt/embed-config-roundtrip.pbt.test.ts`）
    - **Property 1: XdbConfig 序列化 round-trip**
    - **Property 2: 非法 JSON 配置文件总是返回错误**
    - **Property 3: embed 配置写入 round-trip**
    - **Property 8: 凭证解析优先级**
    - **Validates: Requirements 1.2, 1.3, 1.4, 1.6, 2.1, 2.3, 2.4, 4.1, 4.2**

- [x] 3. 替换 Embedder 实现
  - [x] 3.1 重写 `xdb/src/embedder.ts`，将 `Embedder` 类改为直接调用 `EmbeddingClient`
    - 移除 `spawnCommand('pai', ...)` 调用和 `hexToVector` 解码
    - 构造函数接受可选的 `XdbConfigManager` 参数（便于测试注入）
    - `embed(text)` 调用 `EmbeddingClient.embed({ texts: [text], model })`，返回 `embeddings[0]`（`number[]`）
    - `embedBatch(texts)` 调用 `EmbeddingClient.embed({ texts, model })`，返回 `embeddings`（`number[][]`）
    - 错误统一包装为 `XDBError(RUNTIME_ERROR, ...)`
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6_
  - [x]* 3.2 更新 `vitest/unit/embedder.test.ts`，替换 pai spawn mock 为 EmbeddingClient mock
    - 移除对 `os-utils.spawnCommand` 的 mock
    - mock `EmbeddingClient`，验证 embed/embedBatch 直接返回 `number[]`/`number[][]`
    - 验证错误正确传播为 `XDBError`
    - _Requirements: 5.1, 5.2, 5.5_
  - [x]* 3.3 为 Embedder 编写属性测试（`vitest/pbt/embedder.pbt.test.ts`）
    - **Property 9: embedBatch 输出长度与输入一致**
    - **Property 10: Internal_Embedder 返回 number[] 而非 string[]**
    - **Validates: Requirements 5.2, 5.5**

- [x] 4. 为复制的模块补充测试
  - [x]* 4.1 移植 `vitest/unit/embedding-client.test.ts`（参考 pai `unit/embedding-client.test.ts`）
    - 替换 `PAIError`/`ExitCode` 为 `XDBError`/xdb 错误码
    - 覆盖：OpenAI 端点调用、Azure 端点、请求头、响应排序、HTTP 错误、网络错误
    - _Requirements: 3.1, 3.2, 3.3, 3.6, 3.7, 3.8, 3.9_
  - [x]* 4.2 移植 `vitest/pbt/embedding-client.pbt.test.ts`（参考 pai `pbt/baseurl-endpoint.pbt.test.ts`）
    - **Property 4: 端点 URL 构建正确性**
    - **Property 5: 未知 provider 无 baseUrl 总是返回参数错误**
    - **Property 6: HTTP 错误状态码总是返回错误**
    - **Property 7: API 响应按 index 排序**
    - **Validates: Requirements 3.3, 3.5, 3.6, 3.7, 3.9**
  - [x]* 4.3 移植 `vitest/pbt/embed-io.pbt.test.ts`（参考 pai `pbt/batch-json-parsing.pbt.test.ts` + `pbt/json-output.pbt.test.ts`）
    - **Property 11: 批量 JSON 解析有效性**
    - **Property 12: formatEmbeddingOutput JSON 结构完整性**
    - **Validates: Requirements 6.4, 6.5, 6.6**

- [x] 5. 实现 xdb config 命令
  - [x] 5.1 创建 `xdb/src/commands/config.ts`，注册 `config` 顶层命令和 `config embed` 子命令
    - `xdb config`（无子命令）：输出完整配置（embed 配置 + policy 列表），支持 `--json`
    - `xdb config embed --set-provider <name>`：更新 defaultEmbedProvider
    - `xdb config embed --set-model <model>`：更新 defaultEmbedModel
    - `xdb config embed --set-key <apiKey>`：写入当前 provider 的 apiKey（未配置 provider 时报错）
    - `xdb config embed --set-base-url <url>`：写入当前 provider 的 baseUrl（未配置 provider 时报错）
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7_
  - [x] 5.2 在 `xdb/src/cli.ts` 中注册 `config` 命令
    - _Requirements: 2.1_
  - [x] 5.3 在 `xdb/src/commands/policy.ts` 的 `list` 子命令中添加废弃提示
    - 输出 `[Deprecated] xdb policy list is deprecated. Use 'xdb config' instead.` 到 stderr
    - 仍然输出原有内容（向后兼容）
    - _Requirements: 2.8_
  - [x]* 5.4 为 config 命令编写单元测试（`vitest/unit/config-command.test.ts`）
    - 测试：`xdb config` 输出包含 embed 配置和 policy 列表
    - 测试：`xdb config --json` 输出合法 JSON，含 `embed` 和 `policies` 字段
    - 测试：`--set-key` 在无 provider 时报错
    - _Requirements: 2.1, 2.2, 2.7_

- [x] 6. 实现 xdb embed 命令
  - [x] 6.1 创建 `xdb/src/commands/embed.ts`，注册 `embed` 顶层命令
    - 支持位置参数 `[text]` 和 stdin 输入
    - 支持 `--batch`（JSON 字符串数组输入）、`--json`（JSON 格式输出）、`--input-file <path>`
    - 使用 `XdbConfigManager.resolveEmbedConfig()` 加载配置
    - 使用 `parseBatchInput`（来自 embed-io）解析批量输入
    - 使用 `truncateText`（来自 embedding-models）截断超长文本，截断时写 stderr 警告
    - 使用 `EmbeddingClient` 调用 API
    - 使用 `formatEmbeddingOutput`（来自 embed-io）格式化输出（hex 编码，与 pai embed 一致）
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 7.1, 7.2, 7.3, 7.4_
  - [x] 6.2 在 `xdb/src/cli.ts` 中注册 `embed` 命令
    - _Requirements: 6.1_
  - [x]* 6.3 移植 `vitest/unit/embed-command.test.ts`（参考 pai `unit/embed-command.test.ts`）
    - 替换 `ConfigurationManager` mock 为 `XdbConfigManager` mock
    - 替换 `PAIError`/`ExitCode` 为 `XDBError`/xdb 错误码
    - 覆盖：位置参数、stdin、--input-file、--batch、--json、截断警告、错误退出码
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7_

- [x] 7. 最终检查点
  - 确保所有测试通过，向用户确认是否有疑问。

## 说明

- 标有 `*` 的子任务为可选测试任务，可跳过以优先实现核心功能
- 每个属性测试需标注 `// Feature: embed-service, Property N: <property_text>`
- 复制 pai 模块时，仅替换错误类型，不修改业务逻辑
