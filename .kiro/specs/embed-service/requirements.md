# 需求文档：xdb embed 服务

## 简介

为 xdb 新增独立的向量化（Embedding）服务，使 xdb 能够自主完成文本到向量的转换，不再依赖外部 `pai embed` 命令。该服务包含三个部分：

1. **`xdb config`** — 显示 xdb 完整当前配置（嵌入服务配置 + 可用 policy 列表），并通过子命令管理嵌入服务的 provider/model；原 `xdb policy list` 功能迁移至此，`xdb policy list` 废弃
2. **`xdb embed`** — 对外暴露的嵌入命令，与 `pai embed` 行为保持一致
3. **内部嵌入接口** — 替换现有 `Embedder` 类（原来通过 `pai embed` CLI 调用），改为直接调用 Embedding API，将 `number[]` 结果高效传递给 lancedb

约束：
- pai 中的 embed 模型配置和 `pai embed` 命令继续保留，不做修改
- pai 中的以下模块可直接复制到 xdb（无需重新开发）：`EmbeddingClient`、`embed-io`（`parseBatchInput`、`formatEmbeddingOutput`、`vectorToHex`）、`embedding-models`（token 截断逻辑）
- xdb 的 `xdb embed` 命令行为与 `pai embed` 保持一致，包括输出格式（hex 编码向量）、`--batch`、`--json` 等选项

## 术语表

- **XDB_Config**: xdb 的配置对象，存储于 `~/config/xdb/default.json`
- **Config_Manager**: xdb 配置管理器，负责读写 XDB_Config
- **Embedding_Client**: 嵌入向量 API 客户端，直接调用 Provider 的 HTTP 端点（OpenAI 兼容格式）
- **Embed_Command**: `xdb embed` 子命令，接收文本输入并返回嵌入向量
- **Config_Embed_Command**: `xdb config embed` 子命令，管理嵌入服务的 provider/model 配置
- **Internal_Embedder**: xdb 内部嵌入接口，供 `put`/`find` 命令直接调用，返回 `number[]`
- **Embedding_Vector**: 嵌入向量，一个浮点数数组，表示文本的语义表示
- **Provider**: 提供 Embedding API 的服务商（如 openai、azure-openai 等）

## 需求

### 需求 1：xdb 配置文件

**用户故事：** 作为开发者，我希望 xdb 拥有独立的配置文件，以便管理嵌入服务的 provider 和 model，而不依赖 pai 的配置。

#### 验收标准

1. THE Config_Manager SHALL 从 `~/config/xdb/default.json` 读写 XDB_Config
2. THE XDB_Config SHALL 支持 `defaultEmbedProvider` 字段，用于指定默认的嵌入 Provider 名称
3. THE XDB_Config SHALL 支持 `defaultEmbedModel` 字段，用于指定默认的嵌入模型名称
4. THE XDB_Config SHALL 支持 `providers` 数组，每个 Provider 条目包含 `name`、`apiKey`（可选）、`baseUrl`（可选）、`api`（可选）字段
5. IF 配置文件不存在，THEN THE Config_Manager SHALL 返回空的默认配置（providers 为空数组，无默认 provider/model）
6. IF 配置文件存在但 JSON 格式不合法，THEN THE Config_Manager SHALL 返回运行时错误
7. THE Config_Manager SHALL 在写入配置时自动创建所需的目录结构

### 需求 2：xdb config 命令

**用户故事：** 作为开发者，我希望通过 `xdb config` 命令查看 xdb 的完整当前配置，并通过子命令管理嵌入服务的 provider 和 model。

#### 验收标准

1. WHEN 用户执行 `xdb config`（无子命令）时，THE Config_Command SHALL 输出完整当前配置，包括：当前嵌入配置（provider、model、baseUrl，apiKey 脱敏）以及所有可用 policy 列表（等同于原 `xdb policy list` 的输出）
2. WHEN 用户执行 `xdb config --json` 时，THE Config_Command SHALL 以 JSON 格式输出完整配置，包含 `embed` 对象和 `policies` 数组
3. WHEN 用户执行 `xdb config embed --set-provider <name>` 时，THE Config_Embed_Command SHALL 更新 XDB_Config 中的 `defaultEmbedProvider` 并持久化
4. WHEN 用户执行 `xdb config embed --set-model <model>` 时，THE Config_Embed_Command SHALL 更新 XDB_Config 中的 `defaultEmbedModel` 并持久化
5. WHEN 用户执行 `xdb config embed --set-key <apiKey>` 时，THE Config_Embed_Command SHALL 将 apiKey 写入当前 `defaultEmbedProvider` 对应的 provider 条目
6. WHEN 用户执行 `xdb config embed --set-base-url <url>` 时，THE Config_Embed_Command SHALL 将 baseUrl 写入当前 `defaultEmbedProvider` 对应的 provider 条目
7. IF 执行 `--set-key` 或 `--set-base-url` 时未配置 `defaultEmbedProvider`，THEN THE Config_Embed_Command SHALL 返回参数错误并提示用户先设置 provider
8. THE Config_Command SHALL 废弃 `xdb policy list` 命令（保留命令但输出废弃提示，并将用户重定向到 `xdb config`）

### 需求 3：Embedding API 客户端

**用户故事：** 作为开发者，我希望 xdb 内置 Embedding API 客户端，以便直接调用 Provider 的 HTTP 端点完成向量计算。

#### 验收标准

1. THE Embedding_Client SHALL 支持 OpenAI 兼容的嵌入 API 端点（`POST /v1/embeddings`）
2. WHEN 调用嵌入 API 时，THE Embedding_Client SHALL 使用 Bearer Token 认证（非 Azure）或 api-key 头（Azure）
3. THE Embedding_Client SHALL 支持通过 `baseUrl` 配置自定义 API 端点
4. WHEN `baseUrl` 未配置且 provider 为 `openai` 时，THE Embedding_Client SHALL 使用默认端点 `https://api.openai.com/v1/embeddings`
5. WHEN `baseUrl` 未配置且 provider 不是已知 provider 时，THE Embedding_Client SHALL 返回参数错误，提示用户配置 baseUrl
6. THE Embedding_Client SHALL 支持 Azure OpenAI 端点格式：`{baseUrl}/openai/deployments/{model}/embeddings?api-version={version}`
7. WHEN API 返回 HTTP 错误（4xx/5xx）时，THE Embedding_Client SHALL 返回包含状态码和响应体的错误信息
8. WHEN 网络请求失败（超时、连接拒绝等）时，THE Embedding_Client SHALL 返回包含原因的运行时错误
9. THE Embedding_Client SHALL 按输入顺序返回嵌入向量（通过 response 中的 index 字段排序）

### 需求 4：凭证解析

**用户故事：** 作为开发者，我希望 xdb 能够灵活解析 API 凭证，以便在不同环境下使用不同的认证方式。

#### 验收标准

1. WHEN 解析 Provider 凭证时，THE Config_Manager SHALL 按以下优先级查找：环境变量 `XDB_<PROVIDER>_API_KEY` > XDB_Config 中的 `apiKey` 字段
2. WHEN 环境变量 `XDB_<PROVIDER>_API_KEY` 存在时，THE Config_Manager SHALL 使用该环境变量的值作为 API Key
3. IF 所有凭证来源均未找到有效 API Key，THEN THE Config_Manager SHALL 返回错误，提示用户配置凭证

### 需求 5：Internal_Embedder 接口

**用户故事：** 作为 xdb 内部模块，我希望有一个高效的嵌入接口，以便 `put` 和 `find` 命令在处理向量时直接获取 `number[]`，无需通过 CLI 进程间通信。

#### 验收标准

1. THE Internal_Embedder SHALL 提供 `embed(text: string): Promise<number[]>` 接口，直接返回浮点数向量
2. THE Internal_Embedder SHALL 提供 `embedBatch(texts: string[]): Promise<number[][]>` 接口，批量返回浮点数向量数组
3. WHEN 调用 `embed` 或 `embedBatch` 时，THE Internal_Embedder SHALL 从 XDB_Config 加载 provider 和 model 配置
4. IF XDB_Config 中未配置 `defaultEmbedProvider` 或 `defaultEmbedModel`，THEN THE Internal_Embedder SHALL 返回包含配置指引的错误
5. THE Internal_Embedder SHALL 直接返回 API 响应中的 `number[]`，不进行 hex 编码（与原 `pai embed` 的 hex 格式不同）
6. WHEN `put` 或 `find` 命令调用 Internal_Embedder 时，THE Internal_Embedder SHALL 替代原来通过 `spawnCommand('pai', ...)` 的调用方式

### 需求 6：xdb embed 命令

**用户故事：** 作为开发者，我希望通过 `xdb embed` 命令将文本转换为嵌入向量，行为与 `pai embed` 保持一致，以便在脚本中使用。

#### 验收标准

1. WHEN 用户通过命令行参数提供文本（如 `xdb embed "hello world"`），THE Embed_Command SHALL 调用 Embedding API 并将嵌入向量输出到 stdout
2. WHEN 用户通过 stdin 管道提供文本（如 `echo "hello" | xdb embed`），THE Embed_Command SHALL 读取 stdin 内容并返回对应的嵌入向量
3. WHEN 用户指定 `--batch` 标志时，THE Embed_Command SHALL 将输入解析为 JSON 字符串数组，对每条文本计算嵌入向量
4. WHEN 未指定 `--json` 标志时，THE Embed_Command SHALL 将嵌入向量以每行一个 JSON 数组的格式输出到 stdout
5. WHEN 指定 `--json` 标志时，THE Embed_Command SHALL 输出包含 `embedding`（单条）或 `embeddings`（批量）字段的 JSON 对象，以及 `model`、`usage` 元信息
6. IF 批量输入的 JSON 格式不合法或不是字符串数组，THEN THE Embed_Command SHALL 返回参数错误并在 stderr 输出描述性错误信息
7. IF 未配置 provider 或 model，THEN THE Embed_Command SHALL 返回参数错误并提示用户执行 `xdb config embed` 进行配置

### 需求 7：错误处理

**用户故事：** 作为开发者，我希望在出错时获得清晰的错误信息和正确的退出码，以便在脚本中正确处理异常。

#### 验收标准

1. IF 未配置 provider 或 model，THEN THE Embed_Command 和 Internal_Embedder SHALL 返回退出码 2 的参数错误
2. IF API 返回 HTTP 错误，THEN THE Embedding_Client SHALL 返回退出码 1 的运行时错误，并在 stderr 输出状态码和响应体
3. IF 网络请求失败，THEN THE Embedding_Client SHALL 返回退出码 1 的运行时错误，并在 stderr 输出失败原因
4. WHEN 发生错误时，THE Embed_Command SHALL 将错误信息写入 stderr，不写入 stdout
