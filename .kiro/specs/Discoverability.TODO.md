# xdb 可发现性整改清单

基于 ProgressiveDiscovery.md 规范逐项检查。

## 高优先级 (MUST 违规)

### 1. 缺少 `--help --verbose` 支持
- 规范要求: MUST 支持 `--help --verbose` 输出当前命令层级的完整信息
- 现状: 使用 commander 默认 --help，不支持 --verbose
- 影响: 所有层级（xdb, xdb col, xdb col init, xdb put, xdb find）
- 整改: 自定义 help 处理逻辑

### 2. USAGE 缺少 examples
- 规范要求: MUST 有 examples
- 现状: `--help` 输出中没有 examples（USAGE.md 有，但 --help 没有）
- 影响: 所有命令和子命令
- 整改: 在各命令的 help text 中添加 examples

### 3. 退出码不符合规范
- 规范要求: MUST 遵循 0=成功, 1=一般错误, 2=参数/用法错误
- 现状: xdb 定义 PARAMETER_ERROR=1, RUNTIME_ERROR=2，与规范相反（规范要求参数错误=2）
- 整改: 将 PARAMETER_ERROR 改为 2，RUNTIME_ERROR 改为 1。同时更新 USAGE.md 中的退出码表

### 4. 自动 --help 时退出码应为 2
- 规范要求: 因参数错误触发自动 --help 时退出码 MUST 为 2
- 现状: `xdb col` 无参数时显示 help 但退出码为 1（应为 0 或 2 取决于语义）。`xdb put` 缺少参数时 commander 报错退出码为 1
- 整改: 无参数自动显示 help 时退出码为 0；参数错误时退出码为 2

### 5. `xdb put` 缺少参数时未显示 --help
- 规范要求: 没有参数就无意义的命令 MUST 自动显示 --help
- 现状: `xdb put`（不带 collection）输出 "error: missing required argument 'collection'" 但不显示 help
- 整改: 配置 `.showHelpAfterError(true)` 或自定义处理

### 6. 环境与前置依赖未在 --help 中说明
- 规范要求: 如果依赖外部服务，MUST 在 USAGE 中说明
- 现状: xdb 的向量化功能依赖 `pai embed`，但 --help 中完全没有提及
- 整改: 在主命令 help 中提示向量化功能需要 pai 命令

### 7. stdin/管道支持未在 --help 中标注
- 规范要求: 如果支持 stdin，MUST 在 USAGE 中标注
- 现状: `xdb put` 和 `xdb find` 都支持 stdin，但 --help 中没有提及
- 整改: 在 put 和 find 的 help text 中标注 stdin 支持

### 8. 机器可读输出说明不足
- 规范要求: 如果支持 --json，MUST 在 USAGE 中说明输出格式
- 现状: --json 作为 option 列出了，但没有说明输出格式（JSONL vs JSON array）
- 整改: 说明 find --json 输出 JSONL，col list --json 输出 JSON array，put --json 输出统计 JSON

### 9. 子命令规范 — col 子命令的 USAGE
- 规范要求: 每个子命令 MUST 有独立的 USAGE，遵循相同规范
- 现状: `xdb col init --help` 等子命令有基本 help，但缺少 examples 和详细说明
- 整改: 为 col init / col list / col rm 各自添加 examples

## 中优先级 (SHOULD 违规)

### 10. 错误输出缺少修复建议
- 规范要求: 错误信息 SHOULD 包含"什么错了"+"怎么修"
- 现状: 错误信息只有 "Error: xxx"，大部分没有修复建议
- 示例: "Error: Collection 'xxx' not found" 应补充 "Run `xdb col list` to see available collections."
- 整改: 审查所有 XDBError 抛出点，补充修复建议

### 11. --json 模式下错误未以 JSON 输出
- 规范要求: `--json` 模式下错误 MUST 也以 JSON 格式输出
- 现状: 错误始终是纯文本到 stderr
- 整改: handleError 检测是否处于 --json 模式，是则输出 JSON 格式错误

### 12. 配置/数据路径未在 --help 中提及
- 规范要求: SHOULD 告诉使用者数据在哪里
- 现状: 数据存储在 `~/.local/share/xdb/`，USAGE.md 中有但 --help 中没有
- 整改: 在主命令 help 中注明数据目录

### 13. 幂等性标注
- 规范要求: SHOULD 标注操作是否幂等
- 现状: `xdb put` 对相同 id 是 upsert（幂等），但未在 help 中标注
- 整改: 在 put 的 help 中说明 upsert 行为

### 14. --version 硬编码
- 现状: `program.version('0.1.0')` 硬编码，未从 package.json 读取
- 整改: 改为从 package.json 动态读取，与 pai/cmds 保持一致

## 低优先级 (MAY / 建议)

### 15. --version 输出过于简单
- 现状: 只输出 `0.1.0`
- 建议: 加上命令名，如 `xdb 0.1.0`

### 16. examples 格式统一
- 规范要求: SHOULD 使用 `$` 前缀并附带注释
- 整改: 随高优先级 #2 一起处理

### 17. USAGE.md 与 --help 的关联
- 建议: 在 --help 末尾引用 USAGE.md

### 18. col rm 缺少确认/--dry-run
- 规范要求: 不可逆操作 SHOULD 提供 --dry-run
- 现状: `xdb col rm` 直接物理删除，无确认无 dry-run
- 建议: 考虑添加 `--dry-run` 或至少在 help 中标注此操作不可逆
