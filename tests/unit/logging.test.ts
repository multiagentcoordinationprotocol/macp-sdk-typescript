import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetLoggingForTests, configureLogging, logger, type LogSink } from '../../src/logging';

describe('logging', () => {
  beforeEach(() => {
    _resetLoggingForTests();
  });

  afterEach(() => {
    _resetLoggingForTests();
  });

  it('routes logs through the configured sink', () => {
    const sink: LogSink = vi.fn();
    configureLogging({ level: 'debug', sink });
    logger.error('boom', { code: 'X' });
    logger.warn('uh oh');
    logger.info('hello');
    logger.debug('trace');
    expect(sink).toHaveBeenCalledTimes(4);
    expect(sink).toHaveBeenNthCalledWith(1, 'error', ['boom', { code: 'X' }]);
    expect(sink).toHaveBeenNthCalledWith(2, 'warn', ['uh oh']);
    expect(sink).toHaveBeenNthCalledWith(3, 'info', ['hello']);
    expect(sink).toHaveBeenNthCalledWith(4, 'debug', ['trace']);
  });

  it('gates by level — warn default suppresses info+debug', () => {
    const sink: LogSink = vi.fn();
    configureLogging({ level: 'warn', sink });
    logger.info('info-should-be-dropped');
    logger.debug('debug-should-be-dropped');
    logger.warn('warn-should-pass');
    logger.error('error-should-pass');
    expect(sink).toHaveBeenCalledTimes(2);
    expect(sink).toHaveBeenNthCalledWith(1, 'warn', ['warn-should-pass']);
    expect(sink).toHaveBeenNthCalledWith(2, 'error', ['error-should-pass']);
  });

  it('silent level suppresses every log', () => {
    const sink: LogSink = vi.fn();
    configureLogging({ level: 'silent', sink });
    logger.error('boom');
    logger.warn('hi');
    expect(sink).not.toHaveBeenCalled();
  });

  it('throws on unknown level', () => {
    expect(() => configureLogging({ level: 'chatty' as never })).toThrow(/unknown level/i);
  });

  it('changing only the level keeps the prior sink', () => {
    const sink: LogSink = vi.fn();
    configureLogging({ level: 'debug', sink });
    configureLogging({ level: 'error' });
    logger.warn('should be gated out at error level');
    logger.error('should pass');
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenCalledWith('error', ['should pass']);
  });

  it('_resetLoggingForTests is on the ./logging submodule but not on the package barrel (issue #109.3)', async () => {
    const submodule = await import('../../src/logging');
    expect('_resetLoggingForTests' in submodule).toBe(true);
    const barrel = await import('../../src/index');
    expect('_resetLoggingForTests' in barrel).toBe(false);
  });
});
