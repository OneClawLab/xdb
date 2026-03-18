import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import type { SpawnOptions } from 'node:child_process';

// async version of execFile from node:child_process
const execFileAsync = promisify(execFile);

/**
 * Whether we are running on Windows.
 *
 * On Windows we always assume bash is available (Git Bash / MSYS2 / Cygwin / WSL2).
 * cmd.exe / PowerShell are NOT supported.
 *
 * Implications:
 *  - `which` works everywhere (bash built-in / coreutils), never use `where`.
 *  - npm-installed commands are .cmd wrappers on Windows; `shell: true` is
 *    required so Node can resolve them via the shell.
 */
const IS_WIN32 = process.platform === 'win32';

/**
 * Base spawn/execFile options that work correctly on all platforms.
 *
 * `shell: true` on Windows is required for npm-installed commands (.cmd wrappers).
 * On non-Windows it is unnecessary and slightly slower, so we leave it false.
 * `windowsHide: true` suppresses the console window flash on Windows.
 */
const BASE_SPAWN_OPTIONS: Pick<SpawnOptions, 'shell' | 'windowsHide'> = {
  shell: IS_WIN32,
  windowsHide: true,
};

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
 * @param command  - The command to run (must be on PATH).
 * @param args     - Argument list.
 * @param timeoutMs - Optional timeout in milliseconds (0 = no timeout).
 * @param maxBufferMB - Max stdout buffer in MB (default 1), will error if exceeded
 */
export async function execCommand(
  command: string,
  args: string[] = [],
  timeoutMs = 5000,
  maxBufferMB = 1
): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync(command, args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    maxBuffer: maxBufferMB * 1024 * 1024,
    windowsHide: true,
    shell: IS_WIN32,
  });
  return { stdout, stderr };
}

/**
 * Spawn an external command and pipe data through stdin/stdout.
 * Returns a promise that resolves with stdout, rejects on non-zero exit.
 *
 * @param command  - The command to run (must be on PATH).
 * @param args     - Argument list.
 * @param stdin    - Optional data to write to stdin.
 * @param timeoutMs - Optional timeout in milliseconds (0 = no timeout).
 * @param maxStdoutMB - Max stdout buffer in MB (default 1), will be truncated if exceeded
 * @param maxStderrMB - Max stderr buffer in MB (default 1), will be truncated if exceeded
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
      if (stdoutLen <= maxStdoutMB * 1024 * 1024) {
        stdoutChunks.push(chunk);
      }
    });
    proc.stderr!.on('data', (chunk: Buffer) => {
      stderrLen += chunk.length;
      if (stderrLen <= maxStderrMB * 1024 * 1024) {
        stderrChunks.push(chunk);
      }
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
