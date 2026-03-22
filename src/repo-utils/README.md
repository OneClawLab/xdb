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
| `path.ts` | POSIX 风格路径工具：`path`（含 `join`、`resolve`、`normalize`、`basename`、`dirname`、`extname`、`relative`、`isAbsolute`） |


## 同步方式

```bash
# 从 pai 同步到其他 repo（以 notifier 为例）
cp -r /path/to/pai/src/repo-utils /path/to/notifier/src/repo-utils
```

## path.ts 使用规范

所有 repo 内部路径操作必须使用 `path.ts` 提供的 `path` 对象，**禁止直接使用 `node:path`**。

原因：我们始终假定 bash 存在，内部路径统一使用 POSIX 风格（`/c/Users/...`），避免 Windows 盘符（`C:\`）混入导致路径拼接错误。

```ts
import { path } from './repo-utils/path.js'

// ✅ 正确
const dir = path.resolve(options.thread)   // 支持 ~、/c/Users/...、相对路径
const full = path.join(dir, 'logs')

// ❌ 禁止
import * as nodePath from 'node:path'
nodePath.resolve(options.thread)           // 不处理 /c/Users/... 风格路径
```

`path.resolve()` 的行为：
- `~` 开头 → 展开为 homedir
- `/c/Users/...` 等 POSIX 绝对路径 → 直接规范化（不会被 Node 误判为相对路径）
- 相对路径 → 相对于当前 cwd 解析
- Windows 反斜杠 → 自动转换为正斜杠，盘符 `C:` → `/c`
