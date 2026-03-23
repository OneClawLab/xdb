/**
 * path.ts — POSIX-style path utilities for cross-platform Node.js code.
 *
 * ## 背景：为什么不直接用 node:path？
 *
 * 本工程运行环境：Node.js (Windows 原生进程) + MSYS2/Git Bash。
 * 这个组合下存在两个"路径世界"：
 *
 *   - Windows 世界：Node.js 进程、node:fs、child_process 认识的路径
 *                   格式：C:\Users\foo\bar
 *   - POSIX 世界：  Bash、sh -c 执行的命令、MSYS2 工具认识的路径
 *                   格式：/c/Users/foo/bar
 *
 * node:path 在 Windows 上使用反斜杠分隔符，且不做盘符转换。
 * 如果用 node:path.join('/c/Users/foo', 'bar')，得到的是 \c\Users\foo\bar，
 * 这在两个世界里都是错的。
 *
 * ## 本模块的策略
 *
 * 代码内部统一使用 POSIX 风格路径（/c/Users/...）。
 * 所有 path.join / path.resolve 等操作都在 POSIX 空间完成。
 * 只在真正需要与 Node.js 原生 API 交互时，才调用 toNative() 转换。
 *
 * ## 使用规则（重要）
 *
 * ✅ 路径拼接、操作：始终用本模块的 path.join / path.resolve 等
 * ✅ os.homedir() 的返回值：立即用 path.toPosixPath() 转换，之后统一用 POSIX 路径
 * ✅ 传给 bash/sh -c 执行的命令里的路径：保持 POSIX 风格，不要 toNative()
 * ✅ 传给 Node.js fs API 的路径：用 repo-utils/fs.ts（它内部自动调用 toNative()）
 * ❌ 不要直接 import { join } from 'node:path'，在 Windows 上会产生反斜杠路径
 * ❌ 不要直接把 POSIX 路径传给 node:fs，在 Windows 上会 ENOENT
 */

import { homedir as _homedir } from 'node:os';
import * as nodePath from 'node:path';

const SEP = "/";
// 把连续的多个/转成一个/，但不影响协议头的://
const REGEX_SLASHES = /(?<!:)\/{2,}/g;

const PathUtils = {
  /**
   * 将任意路径转为 POSIX 风格。
   * - 反斜杠 → 正斜杠
   * - Windows 盘符 C:/ → /c/
   *
   * 常见用途：os.homedir() 在 Windows 返回 C:\Users\foo，
   * 调用后得到 /c/Users/foo，之后可以安全地用 path.join 拼接。
   */
  toPosixPath(p: string): string {
    return p
      .replace(/\\/g, SEP)
      .replace(/^([A-Za-z]):\//, (_, d: string) => `/${d.toLowerCase()}/`);
  },

  // 规范化路径，处理 "." 和 ".."
  normalize(p: string): string {
    p = this.toPosixPath(p);
    const isAbs = p.startsWith(SEP);
    const isDir = p.endsWith(SEP);
    const parts = p.split(SEP);
    const out: string[] = [];

    for (const part of parts) {
      if (part === "" || part === ".") continue;
      else if (part === "..") { if (out.length > 0) out.pop(); }
      else out.push(part);
    }

    let result = out.join(SEP);
    if (isAbs) result = SEP + result;
    if (result === "" && isAbs) result = SEP;
    if (isDir && result !== "" && !result.endsWith(SEP)) result += SEP;
    return result;
  },

  /**
   * 拼接路径片段，始终返回 POSIX 风格路径。
   * 替代 node:path.join —— 后者在 Windows 上产生反斜杠。
   *
   * 输入可以是 Windows 路径（会自动转换）：
   *   path.join('C:\\Users\\foo', 'bar') → '/c/Users/foo/bar'
   */
  join(...parts: string[]): string {
    let result = "";
    for (const part of parts) {
      if (!part) continue;
      const p = this.toPosixPath(part);
      if (p.startsWith(SEP)) result = p;
      else result = result ? (result.endsWith(SEP) ? result + p : result + SEP + p) : p;
    }
    return this.normalize(result);
  },

  isAbsolute(p: string): boolean {
    return p.startsWith(SEP);
  },

  /**
   * 将路径解析为绝对 POSIX 路径，类似 node:path.resolve()。
   * - 支持 ~ 展开为 homedir（POSIX 风格）
   * - 已是绝对路径则直接 normalize
   * - 相对路径则基于 cwd 解析
   */
  resolve(p: string, cwd?: string): string {
    p = this.toPosixPath(p);
    if (p.startsWith('~/') || p === '~') {
      p = this.toPosixPath(_homedir()) + p.slice(1);
    }
    if (this.isAbsolute(p)) return this.normalize(p);
    const base = this.toPosixPath(cwd ?? nodePath.resolve());
    return this.normalize(base + SEP + p);
  },

  relative(basePath: string, childPath: string): string {
    basePath = this.toPosixPath(basePath).replace(REGEX_SLASHES, SEP);
    childPath = this.toPosixPath(childPath).replace(REGEX_SLASHES, SEP);

    if (basePath.length > 1 && basePath.endsWith(SEP)) basePath = basePath.slice(0, -1);
    if (childPath.length > 1 && childPath.endsWith(SEP)) childPath = childPath.slice(0, -1);

    const baseParts = basePath.split(SEP).filter(p => p);
    const childParts = childPath.split(SEP).filter(p => p);

    let i = 0;
    while (i < baseParts.length && i < childParts.length && baseParts[i] === childParts[i]) i++;

    return childParts.slice(i).join(SEP);
  },

  basename(p: string, ext?: string): string {
    p = this.toPosixPath(p).replace(REGEX_SLASHES, SEP);
    if (p.length > 1 && p.endsWith(SEP)) p = p.slice(0, -1);
    const last = p.substring(p.lastIndexOf(SEP) + 1);
    if (ext && last.endsWith(ext)) return last.slice(0, -ext.length);
    return last;
  },

  dirname(p: string): string {
    p = this.toPosixPath(p).replace(REGEX_SLASHES, SEP);
    if (p.length > 1 && p.endsWith(SEP)) p = p.slice(0, -1);
    const i = p.lastIndexOf(SEP);
    if (i === -1) return "";
    if (i === 0) return SEP;
    return p.slice(0, i);
  },

  extname(p: string): string {
    const base = this.basename(p);
    const i = base.lastIndexOf(".");
    if (i <= 0) return "";
    return base.slice(i);
  },

  /**
   * 将 POSIX 风格路径转回 OS 原生格式。
   * - Windows：/c/Users/foo → C:\Users\foo
   * - POSIX：原样返回
   *
   * 使用场景：
   *   - 直接调用 node:fs（不经过 repo-utils/fs.ts）时
   *   - 传给 child_process.execFile / spawn 的文件路径参数时
   *   - 传给需要原生路径的第三方库时
   *
   * 注意：传给 bash/sh -c 执行的命令字符串里的路径，不要调用 toNative()，
   * 保持 POSIX 风格，否则 bash 无法识别 Windows 反斜杠路径。
   */
  toNative(p: string): string {
    if (process.platform !== 'win32') return p;
    return p
      .replace(/^\/([A-Za-z])(?=\/|$)/, (_, d: string) => `${d.toUpperCase()}:`)
      .replace(/\//g, '\\');
  },
};

export const path = PathUtils;
