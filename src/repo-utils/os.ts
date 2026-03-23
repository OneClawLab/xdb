/**
 * os.ts — cross-platform shell command utilities.
 *
 * ## 背景：Windows + MSYS2/Git Bash 环境下的命令执行问题
 *
 * 本工程假定 Windows 上已安装 Bash（MSYS2 / Git Bash / Cygwin）。
 * Node.js 进程本身是 Windows 原生进程（process.platform === 'win32'），
 * 但我们不使用 cmd.exe / PowerShell，原因如下：
 *
 *   1. npm link 安装的命令在 Windows 上是 .cmd wrapper，
 *      execFile('thread', [...]) 直接调用会找不到（没有 .cmd 后缀）。
 *
 *   2. cmd.exe 对参数里的引号处理与 POSIX shell 不同，
 *      JSON 内容（如 '{"text":"hello"}'）传入后会被破坏。
 *
 *   3. 部分命令（如 notifier）的 executor 用 sh -c 执行任务，
 *      命令字符串里的路径必须是 POSIX 风格（/c/Users/...），
 *      cmd.exe 无法识别这类路径。
 *
 * 解决方案：Windows 上统一通过 sh -c 调用命令，使用 POSIX 单引号转义参数。
 *
 * ## 路径注意事项
 *
 * execCommand 的 args 里如果包含路径，应传入 POSIX 风格路径（/c/Users/...）。
 * sh -c 能识别 POSIX 路径，但不能识别 Windows 反斜杠路径。
 * 不要在 args 里调用 path.toNative()，那会破坏路径。
 *
 * ## which vs where
 *
 * commandExists 使用 `which`（bash 内建 / coreutils），在所有平台都可用。
 * 不要用 `where`，那是 cmd.exe 的命令，在 bash 里不存在。
 */

import { exec, execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import type { SpawnOptions } from 'node:child_process';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

/**
 * Whether we are running on Windows.
 *
 * On Windows we always assume bash is available (Git Bash / MSYS2 / Cygwin).
 * cmd.exe / PowerShell are NOT supported.
 */
const IS_WIN32 = process.platform === 'win32';

/**
 * Check if a command exists in the system PATH.
 * Uses `which` on all platforms (bash is always available, even on Windows).
 * Never throws — returns false on any error.
 */
export async function commandExists(name: string): Promise<boolean> {
  try {
    await execFileAsync('which', [name], {
      encoding: 'utf8',
      timeout: 5000,
      shell: IS_WIN32,
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Execute an external command and capture its output.
 * Throws on non-zero exit code or timeout.
 *
 * @param command   - The command to run (must be on PATH).
 * @param args      - Argument list. Paths must be POSIX-style (/c/Users/...) —
 *                    do NOT call path.toNative() on them; sh cannot read Windows paths.
 * @param timeoutMs - Timeout in milliseconds (0 = no timeout). Default: 5000.
 * @param maxBufferMB - Max stdout/stderr buffer in MB. Default: 1.
 *
 * ## Windows 实现说明
 *
 * 使用 spawn('sh', ['-c', cmd]) 而非 execFile + cmd.exe，原因：
 *   - npm link 的命令是 .cmd wrapper，需要 shell 解析
 *   - cmd.exe 会破坏参数里含特殊字符的内容（JSON、引号等）
 *   - sh -c 能正确识别 POSIX 路径（/c/Users/...）
 *
 * 参数用 POSIX 单引号转义：每个 arg 包裹在单引号内，
 * arg 内部的单引号用 '\'' 转义（结束引号 + 字面单引号 + 重新开始引号）。
 */
export async function execCommand(
  command: string,
  args: string[] = [],
  timeoutMs = 5000,
  maxBufferMB = 1
): Promise<{ stdout: string; stderr: string }> {
  if (IS_WIN32) {
    const shArgs = args.map(a => `'${a.replace(/'/g, "'\\''")}'`);
    const shCmd = [command, ...shArgs].join(' ');
    return new Promise((resolve, reject) => {
      const proc = spawn('sh', ['-c', shCmd], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutLen = 0;
      let stderrLen = 0;
      const maxBytes = maxBufferMB * 1024 * 1024;

      proc.stdout!.on('data', (chunk: Buffer) => {
        stdoutLen += chunk.length;
        if (stdoutLen <= maxBytes) stdoutChunks.push(chunk);
      });
      proc.stderr!.on('data', (chunk: Buffer) => {
        stderrLen += chunk.length;
        if (stderrLen <= maxBytes) stderrChunks.push(chunk);
      });

      let timer: ReturnType<typeof setTimeout> | undefined;
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          proc.kill('SIGKILL');
          reject(new Error(`${command} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }

      proc.on('error', (err) => {
        if (timer) clearTimeout(timer);
        reject(err);
      });

      proc.on('close', (code) => {
        if (timer) clearTimeout(timer);
        const stdout = Buffer.concat(stdoutChunks).toString('utf8');
        const stderr = Buffer.concat(stderrChunks).toString('utf8');
        if (code === 0) {
          resolve({ stdout, stderr });
        } else {
          reject(new Error(`${command} exited with code ${code}: ${stderr}`));
        }
      });
    });
  }
  const { stdout, stderr } = await execFileAsync(command, args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    maxBuffer: maxBufferMB * 1024 * 1024,
    windowsHide: true,
    shell: false,
  });
  return { stdout, stderr };
}

/**
 * Spawn an external command and pipe data through stdin/stdout.
 * Returns a promise that resolves with stdout, rejects on non-zero exit.
 *
 * @param command     - The command to run (must be on PATH).
 * @param args        - Argument list.
 * @param stdin       - Optional data to write to stdin.
 * @param timeoutMs   - Timeout in milliseconds (0 = no timeout).
 * @param maxStdoutMB - Max stdout buffer in MB (default 1).
 * @param maxStderrMB - Max stderr buffer in MB (default 1).
 *
 * 注意：Windows 上使用 shell: true（cmd.exe）。
 * 如果需要传递含特殊字符的参数（如 JSON），请改用 execCommand。
 */
export function spawnCommand(
  command: string,
  args: string[],
  stdin?: string | Buffer,
  timeoutMs = 0,
  maxStdoutMB = 1,
  maxStderrMB = 1,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const opts: SpawnOptions = {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: IS_WIN32,
      windowsHide: true,
    };

    let timer: ReturnType<typeof setTimeout> | undefined;
    const proc = spawn(command, args, opts);

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutLen = 0;
    let stderrLen = 0;
    let killed = false;

    proc.stdout!.on('data', (chunk: Buffer) => {
      stdoutLen += chunk.length;
      if (stdoutLen <= maxStdoutMB * 1024 * 1024) stdoutChunks.push(chunk);
    });
    proc.stderr!.on('data', (chunk: Buffer) => {
      stderrLen += chunk.length;
      if (stderrLen <= maxStderrMB * 1024 * 1024) stderrChunks.push(chunk);
    });

    proc.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });

    proc.on('close', (code) => {
      if (timer) clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      if (code === 0 || (!killed && stdout.trim().length > 0)) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`${command} exited with code ${code}: ${stderr}`));
      }
    });

    if (stdin !== undefined) {
      proc.stdin!.write(stdin);
      proc.stdin!.end();
    }

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        killed = true;
        proc.kill('SIGKILL');
        reject(new Error(`${command} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }
  });
}

/**
 * Execute a full shell command string (e.g. "npm install -g foo@1.0.0").
 * Uses /bin/sh on Unix, the default shell on Windows.
 * Throws on non-zero exit code.
 *
 * 适用于需要 shell 特性（管道、重定向、glob）的场景。
 * 如果只是调用一个命令加参数，优先用 execCommand（更安全，参数不经过 shell 解析）。
 */
export async function execShell(
  command: string,
  timeoutMs = 60000,
): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execAsync(command, {
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
  });
  return { stdout, stderr };
}
