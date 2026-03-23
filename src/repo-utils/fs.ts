/**
 * fs.ts — node:fs wrapper，自动将 POSIX 路径转换为 OS 原生路径。
 *
 * ## 为什么需要这个模块？
 *
 * 代码内部统一使用 POSIX 风格路径（/c/Users/...）。
 * 但 Windows 上的 Node.js fs API 只认原生路径（C:\Users\...）。
 * 直接把 POSIX 路径传给 node:fs 会得到 ENOENT 错误。
 *
 * 本模块在每次调用前自动执行 path.toNative()，消除这个边界。
 *
 * ## 使用规则
 *
 * ✅ 所有文件读写操作都应通过本模块，而不是直接 import node:fs / node:fs/promises
 * ✅ 传入的路径可以是 POSIX 风格（/c/Users/...）或 Windows 风格（C:\Users\...），
 *    本模块都能正确处理
 * ❌ 不要直接 import { readFile } from 'node:fs/promises' 再传入 POSIX 路径，
 *    在 Windows 上会 ENOENT
 *
 * Source of truth: pai/src/repo-utils/fs.ts
 * 其他 repo 从 pai 同步，不要单独修改。
 */

import * as nodeFs from 'node:fs';
import * as nodeFsP from 'node:fs/promises';
import { path } from './path.js';

// 简写：将路径转为 OS 原生格式
const n = path.toNative.bind(path);

// ── Sync ─────────────────────────────────────────────────────

export function existsSync(p: string): boolean {
  return nodeFs.existsSync(n(p));
}

export function mkdirSync(p: string, opts?: nodeFs.MakeDirectoryOptions): string | undefined {
  return nodeFs.mkdirSync(n(p), opts);
}

export function mkdtempSync(prefix: string): string {
  return path.toPosixPath(nodeFs.mkdtempSync(n(prefix)));
}

export function readFileSync(p: string, encoding: BufferEncoding): string;
export function readFileSync(p: string): Buffer;
export function readFileSync(p: string, encoding?: BufferEncoding): string | Buffer {
  return encoding ? nodeFs.readFileSync(n(p), encoding) : nodeFs.readFileSync(n(p));
}

export function writeFileSync(p: string, data: string, encoding?: BufferEncoding): void {
  nodeFs.writeFileSync(n(p), data, encoding);
}

export function appendFileSync(p: string, data: string, encoding?: BufferEncoding): void {
  nodeFs.appendFileSync(n(p), data, encoding);
}

export function renameSync(oldPath: string, newPath: string): void {
  nodeFs.renameSync(n(oldPath), n(newPath));
}

export function openSync(p: string, flags: number): number {
  return nodeFs.openSync(n(p), flags);
}

export const writeSync = nodeFs.writeSync;
export const closeSync = nodeFs.closeSync;
export const constants = nodeFs.constants;

// ── Async (promises) ─────────────────────────────────────────

export async function mkdir(p: string, opts?: nodeFs.MakeDirectoryOptions): Promise<string | undefined> {
  return nodeFsP.mkdir(n(p), opts);
}

export async function mkdtemp(prefix: string): Promise<string> {
  return path.toPosixPath(await nodeFsP.mkdtemp(n(prefix)));
}

export async function rm(p: string, opts?: nodeFs.RmOptions): Promise<void> {
  return nodeFsP.rm(n(p), opts);
}

export async function readFile(p: string, encoding: BufferEncoding): Promise<string>;
export async function readFile(p: string): Promise<Buffer>;
export async function readFile(p: string, encoding?: BufferEncoding): Promise<string | Buffer> {
  return encoding ? nodeFsP.readFile(n(p), encoding) : nodeFsP.readFile(n(p));
}

export async function writeFile(p: string, data: string, options?: BufferEncoding | (nodeFs.ObjectEncodingOptions & { mode?: nodeFs.Mode; flag?: string })): Promise<void> {
  return nodeFsP.writeFile(n(p), data, options);
}

export async function stat(p: string): Promise<nodeFs.Stats> {
  return nodeFsP.stat(n(p));
}

export async function readdir(p: string): Promise<string[]> {
  return nodeFsP.readdir(n(p));
}

export async function unlink(p: string): Promise<void> {
  return nodeFsP.unlink(n(p));
}
