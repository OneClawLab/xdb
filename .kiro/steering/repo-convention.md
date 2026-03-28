---
inclusion: always
---

# Repo Convention

所有 repo 均为独立的 TypeScript ESM CLI 工具，遵循以下统一约定。

## 开发环境

- 默认 Shell 是 **bash**，永远不要使用 PowerShell 命令，直接写命令即可
- TypeScript 检查：`npx tsc --noEmit 2>&1`（不要直接调用 `tsc`）
- 有时调用太快会导致第一个字符被吃掉（如 `npm` 变成 `pm`），可以再试

## 项目结构

```
src/          源码（TypeScript）
  index.ts    CLI 入口
  commands/   子命令实现
  types.ts    共享类型定义
  repo-utils/ 跨 repo 共通工具（从 pai repo 复制，见下文）
dist/         构建产物（tsup 生成，不提交 git）
vitest/       测试文件
  unit/       单元测试（<module>.test.ts）
  pbt/        属性测试（<topic>.pbt.test.ts）
  integration/  （可选）
  fixtures/     （可选）
```

## 工具链

| 工具 | 用途 |
|------|------|
| `tsup` | 构建，输出 ESM，自动注入 shebang |
| `vitest` | 测试框架 |
| `commander` | CLI 参数解析 |
| `fast-check` | 属性测试（PBT） |
| `tsx` | 开发时直接运行 TS（部分 repo） |

## package.json scripts 约定

```json
{
  "build": "tsup",
  "dev": "tsup --watch",
  "test": "vitest run",
  "test:coverage": "vitest run --coverage",
  "release:local": "npm run build && npm link"
}
```

- `test` 脚本必须是单次运行（`vitest run`），不能是 watch 模式
- `release:local` 用于本地安装调试，不走 npm publish

## tsconfig.json 通用选项

```jsonc
{
  "compilerOptions": {
    "module": "nodenext",
    "target": "esnext",
    "types": ["node"],
    "strict": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "moduleDetection": "force",
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "skipLibCheck": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "resolveJsonModule": true
  }
}
```

## tsup.config.ts 通用配置

```ts
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  clean: true,
  sourcemap: true,
  dts: true,
  banner: { js: '#!/usr/bin/env node' },
})
```

- 只输出 ESM（`format: ['esm']`）
- `banner` 注入 shebang，确保 CLI 可直接执行
- `clean: true` 每次构建前清理 dist

## vitest.config.ts 通用配置

```ts
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    watch: false,
    testTimeout: 30000,
    fileParallelism: false,
    include: ['vitest/**/*.test.ts'],
  },
})
```

## CLI 入口约定（src/index.ts）

```ts
// 1. EPIPE 处理（管道断开时优雅退出）
process.stdout.on('error', (err) => { if (err.code === 'EPIPE') process.exit(0); throw err })
process.stderr.on('error', (err) => { if (err.code === 'EPIPE') process.exit(0); throw err })

// 2. exitOverride（让 commander 抛出异常而非直接 process.exit）
program.exitOverride()

// 3. 错误码约定
//    - 参数/用法错误 → exit 2
//    - 运行时错误   → exit 1
//    - commander 的 exitCode=1 参数错误需 remap 到 2

// 4. 版本号从 package.json 读取
const pkg = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf-8'))
program.version(pkg.version)
```

## 错误处理约定

- 自定义错误类继承 `Error`，携带 `exitCode` 字段（通常命名 `CliError`）
- 顶层 catch 统一处理：`CliError` 用其 `exitCode`，其他错误用 exit 1
- 错误信息写到 `stderr`，正常输出写到 `stdout`

### 错误码约定

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | Runtime error (local execution, API call, IO, etc.) |
| `2` | Argument or usage error |

### stdout / stderr Contract

- `stdout`: Command result data (search results, info output, list summary)
- `stderr`: Progress, debug, error, and warning messages

### Logging

**CLI Mode:**
- Errors and warnings output to stderr
- No log files written (unless explicitly requested via `--log-file`)

**Daemon Mode:**
- Log file: `$HOME/.local/share/<tool>/logs/<tool>.log`
- Auto-rotate when exceeding 10000 lines
- Format: `[TIMESTAMP] [LEVEL] message`

## import 路径

- 所有本地 import 必须带 `.js` 后缀（ESM + NodeNext 要求）
  ```ts
  import { foo } from './foo.js'   // ✅
  import { foo } from './foo'      // ❌
  ```

## repo-utils：跨 repo 共通工具

`src/repo-utils/` 目录存放与业务无关的通用工具代码，**source of truth 为 pai repo**。

### 规则

- 所有修改必须先在 `pai/src/repo-utils/` 进行，然后 `cp` 同步到其他 repo
- 其他 repo 直接复制使用，不需要修改
- **测试代码只在 pai repo 维护**（`pai/vitest/unit/repo-utils-*.test.ts`），其他 repo 无需重复编写
- 调用 shell 命令的函数统一放在 `repo-utils/os.ts`，不要在各 repo 单独实现

### 文件说明

| 文件 | 说明 |
|------|------|
| `os.ts` | Shell 命令工具：`commandExists`、`execCommand`、`spawnCommand`、`execShell` |
| `logger.ts` | 文件日志工具：`createFileLogger`、`createForegroundLogger`、`createStderrLogger` |
| `help.ts` | Commander `--verbose` 帮助扩展：`installVerboseHelp` |

### 同步方式

```bash
# 从 pai 同步到其他 repo（以 notifier 为例）
cp -r pai/src/repo-utils notifier/src/repo-utils
```

## 发布方式

- 本地开发：`npm run release:local`（build + npm link）
- 不使用 npm publish，各 repo 独立管理
