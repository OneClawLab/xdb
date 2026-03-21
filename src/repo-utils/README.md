# repo-utils

跨 repo 共享的通用工具代码。

## 规则

- **Source of truth 为 pai repo**：所有修改必须在此目录进行，然后同步到其他 repo。
- **其他 repo 直接复制使用**：将所需文件复制到对应 repo 的 `src/repo-utils/` 目录下，不需要修改。
- **测试代码只在 pai repo 维护**：`pai/vitest/unit/repo-utils-*.test.ts` 和 `pai/vitest/pbt/repo-utils-*.pbt.test.ts`，其他 repo 无需重复编写测试。
- **不含业务逻辑**：此目录只放与具体业务无关的通用工具。

## 文件说明

| 文件 | 说明 |
|------|------|
| `os.ts` | Shell 命令工具：`commandExists`、`execCommand`、`spawnCommand`、`execShell` |
| `logger.ts` | 文件日志工具：`createFileLogger`、`createForegroundLogger`、`createStderrLogger` |


## 同步方式

```bash
# 从 pai 同步到其他 repo（以 notifier 为例）
cp -r /path/to/pai/src/repo-utils /path/to/notifier/src/repo-utils
```
