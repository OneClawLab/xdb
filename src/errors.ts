// Error type constants with associated exit codes
export const PARAMETER_ERROR = 1;
export const CAPABILITY_ERROR = 1;
export const RUNTIME_ERROR = 2;

/**
 * Unified error class for xdb.
 * All errors carry an exit code and a descriptive message.
 */
export class XDBError extends Error {
  constructor(
    public readonly exitCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'XDBError';
  }
}

/**
 * Write a formatted error message to stderr.
 * Format: "Error: <descriptive message>\n"
 */
export function outputError(err: XDBError): void {
  process.stderr.write(`Error: ${err.message}\n`);
}

/**
 * Handle an error by writing it to stderr and exiting with the appropriate code.
 * If the error is not an XDBError, it is treated as a RUNTIME_ERROR.
 */
export function handleError(err: unknown): never {
  if (err instanceof XDBError) {
    outputError(err);
    process.exit(err.exitCode);
  }
  const message = err instanceof Error ? err.message : String(err);
  const xdbErr = new XDBError(RUNTIME_ERROR, message);
  outputError(xdbErr);
  process.exit(xdbErr.exitCode);
}
