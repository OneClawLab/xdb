import { createWriteStream } from 'node:fs';
import { path } from './path.js';
import { mkdirSync, readFileSync, renameSync } from './fs.js';

export type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug(message: string): void;
  close(): Promise<void>;
}

export function formatLogLine(level: LogLevel, message: string): string {
  return `[${new Date().toISOString()}] [${level}] ${message}`;
}

// return format: YYYYMMDD-hhmmss (don't change)
export function formatRotationTimestamp(date: Date): string {
  const pad = (n: number, len = 2) => String(n).padStart(len, '0');
  const Y = date.getUTCFullYear();
  const M = pad(date.getUTCMonth() + 1);
  const D = pad(date.getUTCDate());
  const h = pad(date.getUTCHours());
  const m = pad(date.getUTCMinutes());
  const s = pad(date.getUTCSeconds());
  return `${Y}${M}${D}-${h}${m}${s}`;
}

function countLines(filePath: string): number {
  try {
    const content = readFileSync(filePath, 'utf8');
    if (content.length === 0) return 0;
    const lines = content.split('\n');
    return lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw err;
  }
}

/**
 * Creates a file-based Logger that writes to <logDir>/<logName>.log.
 * Rotation policy:
 *   - Always rotates on startup if the log file exists and is non-empty.
 *   - Also rotates mid-session when line count exceeds maxLines (default 10000).
 */
export async function createFileLogger(
  logDir: string,
  logName: string,
  maxLines = 10000,
): Promise<Logger> {
  const logFile = path.join(logDir, `${logName}.log`);

  mkdirSync(logDir, { recursive: true });

  // Rotate on startup if file exists and is non-empty, or if maxLines exceeded
  const lineCount = countLines(logFile);
  if (lineCount > 0) {
    const ts = formatRotationTimestamp(new Date());
    renameSync(logFile, path.join(logDir, `${logName}-${ts}.log`));
  }

  let stream = createWriteStream(path.toNative(logFile), { flags: 'a', encoding: 'utf8' });
  await new Promise<void>((resolve, reject) => {
    stream.on('open', () => resolve());
    stream.on('error', reject);
  });

  let currentLines = 0;

  function rotate(): void {
    const ts = formatRotationTimestamp(new Date());
    stream.end();
    renameSync(logFile, path.join(logDir, `${logName}-${ts}.log`));
    stream = createWriteStream(path.toNative(logFile), { flags: 'a', encoding: 'utf8' });
    currentLines = 0;
  }

  function writeLine(level: LogLevel, message: string): void {
    if (currentLines >= maxLines) rotate();
    stream.write(formatLogLine(level, message) + '\n');
    currentLines++;
  }

  return {
    info(message) { writeLine('INFO', message); },
    warn(message) { writeLine('WARN', message); },
    error(message) { writeLine('ERROR', message); },
    debug(message) { writeLine('DEBUG', message); },
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        stream.end((err?: Error | null) => { if (err) reject(err); else resolve(); });
      });
    },
  };
}

/**
 * Creates a Logger that writes to both stdout/stderr and a log file.
 * INFO/WARN/DEBUG → stdout, ERROR → stderr.
 */
export async function createForegroundLogger(
  logDir: string,
  logName: string,
  maxLines = 10000,
): Promise<Logger> {
  const fileLogger = await createFileLogger(logDir, logName, maxLines);

  function writeLine(level: LogLevel, message: string): void {
    const line = formatLogLine(level, message);
    (level === 'ERROR' ? process.stderr : process.stdout).write(line + '\n');
    fileLogger[level.toLowerCase() as 'info' | 'warn' | 'error' | 'debug'](message);
  }

  return {
    info(message) { writeLine('INFO', message); },
    warn(message) { writeLine('WARN', message); },
    error(message) { writeLine('ERROR', message); },
    debug(message) { writeLine('DEBUG', message); },
    close: () => fileLogger.close(),
  };
}

/**
 * Creates a stderr-only Logger. close() is a no-op.
 */
export function createStderrLogger(): Logger {
  function writeLine(level: LogLevel, message: string): void {
    process.stderr.write(formatLogLine(level, message) + '\n');
  }
  return {
    info(message) { writeLine('INFO', message); },
    warn(message) { writeLine('WARN', message); },
    error(message) { writeLine('ERROR', message); },
    debug(message) { writeLine('DEBUG', message); },
    close: () => Promise.resolve(),
  };
}

/**
 * Creates a fire-and-forget Logger that writes asynchronously to <logDir>/<logName>.log.
 * Log I/O errors are silently swallowed — suitable for background daemons where
 * logging failures must never crash the main process.
 * close() is a no-op (writes are not awaited).
 */
export function createFireAndForgetLogger(
  logDir: string,
  logName: string,
  maxLines = 10000,
): Logger {
  let loggerPromise: Promise<Logger> | null = null;

  function getLogger(): Promise<Logger> {
    if (!loggerPromise) {
      loggerPromise = createFileLogger(logDir, logName, maxLines).catch(() => createStderrLogger());
    }
    return loggerPromise;
  }

  function write(level: LogLevel, message: string): void {
    getLogger().then(logger => logger[level.toLowerCase() as 'info' | 'warn' | 'error' | 'debug'](message)).catch(() => {});
  }

  return {
    info(message) { write('INFO', message); },
    warn(message) { write('WARN', message); },
    error(message) { write('ERROR', message); },
    debug(message) { write('DEBUG', message); },
    close: () => Promise.resolve(),
  };
}
