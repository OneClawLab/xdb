import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  XDBError,
  PARAMETER_ERROR,
  CAPABILITY_ERROR,
  RUNTIME_ERROR,
  outputError,
  handleError,
} from './errors.js';

describe('Error type constants', () => {
  it('PARAMETER_ERROR should be 1', () => {
    expect(PARAMETER_ERROR).toBe(1);
  });

  it('CAPABILITY_ERROR should be 1', () => {
    expect(CAPABILITY_ERROR).toBe(1);
  });

  it('RUNTIME_ERROR should be 2', () => {
    expect(RUNTIME_ERROR).toBe(2);
  });
});

describe('XDBError', () => {
  it('should store exitCode and message', () => {
    const err = new XDBError(PARAMETER_ERROR, 'missing --policy');
    expect(err.exitCode).toBe(1);
    expect(err.message).toBe('missing --policy');
    expect(err.name).toBe('XDBError');
  });

  it('should be an instance of Error', () => {
    const err = new XDBError(RUNTIME_ERROR, 'io failure');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(XDBError);
  });
});

describe('outputError', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should write formatted message to stderr', () => {
    const writeSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const err = new XDBError(PARAMETER_ERROR, 'collection not found');
    outputError(err);
    expect(writeSpy).toHaveBeenCalledWith('Error: collection not found\n');
  });
});

describe('handleError', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should output XDBError and exit with its exitCode', () => {
    const writeSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    const err = new XDBError(PARAMETER_ERROR, 'bad param');
    handleError(err);

    expect(writeSpy).toHaveBeenCalledWith('Error: bad param\n');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('should treat plain Error as RUNTIME_ERROR', () => {
    const writeSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    handleError(new Error('unexpected'));

    expect(writeSpy).toHaveBeenCalledWith('Error: unexpected\n');
    expect(exitSpy).toHaveBeenCalledWith(RUNTIME_ERROR);
  });

  it('should treat non-Error values as RUNTIME_ERROR', () => {
    const writeSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    handleError('string error');

    expect(writeSpy).toHaveBeenCalledWith('Error: string error\n');
    expect(exitSpy).toHaveBeenCalledWith(RUNTIME_ERROR);
  });
});
