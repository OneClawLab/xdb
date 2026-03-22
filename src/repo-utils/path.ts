// 非 Node.js 或 Node.js 环境下都能运行的简易 path 模块
// 简化的 POSIX 风格 path 模块
//  - 仅支持 "/" 分隔符
//  - 支持 . 和 .. 的处理

// 关于路径分隔符：
//  我们内部统一使用 POSIX "/" 分隔符（Git Bash 风格）。
//  Windows 盘符（如 C:）会被转换为 /c 风格。
//  输出的路径全部都是 POSIX 风格，以减少混淆。

import { homedir as _homedir } from 'node:os';
import * as nodePath from 'node:path';

const SEP = "/";
// 把连续的多个/转成一个/，但不影响协议头的://
const REGEX_SLASHES = /(?<!:)\/{2,}/g;

const PathUtils = {
  // 转为 POSIX 风格：反斜杠 → 正斜杠，Windows 盘符 C: → /c
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
   * Resolve a path to an absolute POSIX path, similar to path.resolve().
   * - Expands leading ~ to homedir
   * - If already absolute (starts with /), normalizes in place
   * - Otherwise resolves relative to cwd (converted to POSIX)
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
   * Convert a POSIX-style path back to the OS-native format.
   * On Windows (Git Bash): /c/foo → C:\foo
   * On POSIX systems: returns the path unchanged.
   * Use this before passing paths to Node.js fs / child_process / native addons.
   */
  toNative(p: string): string {
    if (process.platform !== 'win32') return p;
    return p
      .replace(/^\/([A-Za-z])(?=\/|$)/, (_, d: string) => `${d.toUpperCase()}:`)
      .replace(/\//g, '\\');
  },
};

export const path = PathUtils;
