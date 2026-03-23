# repo-utils

跨 repo 共通工具。**source of truth 为 `pai repo` 的 `src/repo-utils/`**，其他 repo 从这里 `cp` 同步，不要单独修改。

如果 cwd 在 pai repo 根路径下，则拷贝命令应为:
```bash
cp -r ./src/repo-utils ../<other-repo>/src/repo-utils
```
如果 cwd 在别的 repo 的路径下，则拷贝(到cwd 所在的 repo)命令应为:
```bash
cp -r ../pai/src/repo-utils ./src/repo-utils
```

---

## 开发环境说明

本工程的目标运行环境包括: linux/mac/windows，均假设系统已安装了 Bash。
本工程的开发环境是 **Windows 原生 Node.js + MSYS2/Git Bash**，这个组合下存在两个"路径世界"同时运行：

| 世界 | 进程 | 路径格式 |
|------|------|----------|
| Windows | Node.js、node:fs、child_process | `C:\Users\foo\bar` |
| POSIX | bash、sh -c 执行的命令、MSYS2 工具 | `/c/Users/foo/bar` |

**代码内部统一使用 POSIX 风格路径**，只在与 Node.js 原生 API 交互时才转换为 Windows 路径。

---

## 路径使用规则（必读）

### ✅ 正确做法

```ts
import { path } from './repo-utils/path.js'
import { readFile, writeFile, existsSync } from './repo-utils/fs.js'
import { execCommand } from './repo-utils/os.js'
import { homedir } from 'node:os'

// os.homedir() 返回 Windows 路径，立即转换
const home = path.toPosixPath(homedir())  // C:\Users\foo → /c/Users/foo

// 路径拼接用 repo-utils/path
const filePath = path.join(home, '.theclaw', 'config.yaml')  // /c/Users/foo/.theclaw/config.yaml

// 文件读写用 repo-utils/fs（内部自动 toNative）
const content = await readFile(filePath, 'utf8')

// 调用外部命令用 execCommand，路径保持 POSIX 风格
await execCommand('thread', ['push', '--thread', filePath, '--content', 'hello'])
```

### ❌ 常见错误

```ts
// ❌ node:path 在 Windows 上产生反斜杠
import { join } from 'node:path'
join('/c/Users/foo', 'bar')  // → \c\Users\foo\bar （错误）

// ❌ 直接用 node:fs 读取 POSIX 路径，Windows 上 ENOENT
import { readFile } from 'node:fs/promises'
await readFile('/c/Users/foo/bar.txt', 'utf8')  // → ENOENT

// ❌ 传给 sh -c 的路径不要 toNative()，bash 不认反斜杠
await execCommand('thread', ['push', '--thread', path.toNative(filePath)])  // → 路径错误
```

---

## 文件说明

### `path.ts`

POSIX 风格路径工具，替代 `node:path`。

- `path.join(...parts)` — 路径拼接，始终返回 POSIX 路径
- `path.toPosixPath(p)` — 转为 POSIX 风格（反斜杠→正斜杠，`C:/` → `/c/`）
- `path.toNative(p)` — 转回 OS 原生路径（仅在需要传给 node:fs 等原生 API 时使用）
- `path.resolve(p, cwd?)` — 解析为绝对 POSIX 路径，支持 `~` 展开
- `path.normalize / basename / dirname / extname / relative / isAbsolute` — 同 node:path，但输出 POSIX 风格

### `fs.ts`

`node:fs` 的薄封装，自动在调用前执行 `path.toNative()`。

- 接受 POSIX 路径，内部转换为 Windows 原生路径再调用 node:fs
- 导出与 node:fs / node:fs/promises 同名的函数：`readFile`、`writeFile`、`mkdir`、`existsSync`、`readdir`、`stat`、`unlink` 等
- **所有文件 IO 都应通过本模块**，不要直接 import node:fs

### `os.ts`

跨平台命令执行工具。

- `execCommand(cmd, args, timeoutMs?, maxBufferMB?)` — 执行命令并捕获输出。Windows 上通过 `sh -c` 调用（而非 cmd.exe），参数用 POSIX 单引号转义，支持 JSON 等含特殊字符的参数。**args 里的路径保持 POSIX 风格，不要 toNative()**。
- `spawnCommand(cmd, args, stdin?, ...)` — 带 stdin 管道的命令执行。Windows 上使用 `shell: true`（cmd.exe），不适合传递含特殊字符的参数。
- `commandExists(name)` — 检查命令是否在 PATH 中，使用 `which`（不用 `where`）。
- `execShell(command, timeoutMs?)` — 执行完整 shell 命令字符串，适合需要管道/重定向的场景。

### `logger.ts`

文件日志工具。

- `createFileLogger(dir, name)` — 写入文件的异步 logger（fire-and-forget）
- `createForegroundLogger()` — 输出到 stdout 的 logger
- `createStderrLogger()` — 输出到 stderr 的 logger

### `help.ts`

Commander `--verbose` 帮助扩展。

- `installVerboseHelp(program)` — 为 commander program 添加 `--verbose` 选项，显示详细帮助
