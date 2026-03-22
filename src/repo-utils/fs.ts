/**
 * fs.ts — thin wrapper around node:fs that auto-converts POSIX paths to native.
 *
 * All our code uses POSIX-style paths internally (/c/Users/...).
 * Node.js fs APIs on Windows need native paths (C:\Users\...).
 * This module re-exports the fs functions we use, with path.toNative() applied.
 *
 * Source of truth: pai/src/repo-utils/fs.ts
 */

import * as nodeFs from 'node:fs';
import * as nodeFsP from 'node:fs/promises';
import { path } from './path.js';

const n = path.toNative.bind(path);

// ── Sync ─────────────────────────────────────────────────────

export function existsSync(p: string): boolean {
  return nodeFs.existsSync(n(p));
}

export function mkdirSync(p: string, opts?: nodeFs.MakeDirectoryOptions): string | undefined {
  return nodeFs.mkdirSync(n(p), opts);
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
