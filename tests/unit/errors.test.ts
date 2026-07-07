import { describe, it, expect } from 'vitest';
import {
  MacpSdkError,
  MacpTransportError,
  MacpAckError,
  MacpSessionError,
  MacpTimeoutError,
  MacpRetryError,
  MacpIdentityMismatchError,
  type AckFailure,
} from '../../src/errors';

describe('Error classes', () => {
  it('MacpSdkError is base class', () => {
    const err = new MacpSdkError('test');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('MacpSdkError');
    expect(err.message).toBe('test');
  });

  it('MacpTransportError extends MacpSdkError', () => {
    const err = new MacpTransportError('transport fail');
    expect(err).toBeInstanceOf(MacpSdkError);
    expect(err.name).toBe('MacpTransportError');
    expect(err.code).toBeUndefined();
  });

  it('MacpTransportError carries an optional gRPC status code', () => {
    const err = new MacpTransportError('lag', 'RESOURCE_EXHAUSTED');
    expect(err.code).toBe('RESOURCE_EXHAUSTED');
  });

  it('MacpAckError formats message from ack', () => {
    const err = new MacpAckError({
      ok: false,
      error: { code: 'SESSION_NOT_FOUND', message: 'no such session' },
    });
    expect(err).toBeInstanceOf(MacpSdkError);
    expect(err.name).toBe('MacpAckError');
    expect(err.message).toContain('SESSION_NOT_FOUND');
    expect(err.message).toContain('no such session');
    expect(err.ack.ok).toBe(false);
  });

  it('MacpAckError handles missing error fields', () => {
    const err = new MacpAckError({ ok: false });
    expect(err.message).toContain('UNKNOWN');
    expect(err.message).toContain('runtime returned nack');
  });

  it('MacpSessionError extends MacpSdkError', () => {
    const err = new MacpSessionError('session not started');
    expect(err).toBeInstanceOf(MacpSdkError);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(MacpTransportError);
    expect(err.name).toBe('MacpSessionError');
    expect(err.message).toBe('session not started');
  });

  it('MacpTimeoutError extends MacpTransportError', () => {
    const err = new MacpTimeoutError('operation timed out');
    expect(err).toBeInstanceOf(MacpTransportError);
    expect(err).toBeInstanceOf(MacpSdkError);
    expect(err.name).toBe('MacpTimeoutError');
    expect(err.message).toBe('operation timed out');
  });

  it('MacpRetryError extends MacpTransportError', () => {
    const err = new MacpRetryError('retries exhausted after 3 attempts');
    expect(err).toBeInstanceOf(MacpTransportError);
    expect(err).toBeInstanceOf(MacpSdkError);
    expect(err.name).toBe('MacpRetryError');
    expect(err.message).toBe('retries exhausted after 3 attempts');
  });

  it('MacpIdentityMismatchError extends MacpSdkError and exposes both senders', () => {
    const err = new MacpIdentityMismatchError('alice', 'mallory');
    expect(err).toBeInstanceOf(MacpSdkError);
    expect(err).not.toBeInstanceOf(MacpTransportError);
    expect(err.name).toBe('MacpIdentityMismatchError');
    expect(err.expectedSender).toBe('alice');
    expect(err.actualSender).toBe('mallory');
    expect(err.message).toContain('alice');
    expect(err.message).toContain('mallory');
  });

  describe('MacpAckError.failure.reasons', () => {
    it('parses reasons from details buffer', () => {
      const details = Buffer.from(JSON.stringify({ reasons: ['policy mismatch', 'missing field'] }));
      const err = new MacpAckError({
        ok: false,
        error: { code: 'POLICY_DENIED', message: 'denied', details },
      });
      expect(err.failure.reasons).toEqual(['policy mismatch', 'missing field']);
    });

    it('returns empty array when no details', () => {
      const err = new MacpAckError({
        ok: false,
        error: { code: 'POLICY_DENIED', message: 'denied' },
      });
      expect(err.failure.reasons).toEqual([]);
    });

    it('returns empty array on malformed JSON', () => {
      const err = new MacpAckError({
        ok: false,
        error: { code: 'POLICY_DENIED', message: 'denied', details: Buffer.from('not json') },
      });
      expect(err.failure.reasons).toEqual([]);
    });

    it('returns empty array when reasons is not an array', () => {
      const details = Buffer.from(JSON.stringify({ reasons: 'not-array' }));
      const err = new MacpAckError({
        ok: false,
        error: { code: 'POLICY_DENIED', message: 'denied', details },
      });
      expect(err.failure.reasons).toEqual([]);
    });
  });

  describe('MacpAckError.failure', () => {
    it('populates the structured failure shape from the ACK error', () => {
      const details = Buffer.from(JSON.stringify({ reasons: ['r1', 'r2'] }));
      const err = new MacpAckError({
        ok: false,
        messageId: 'm-1',
        sessionId: 's-1',
        error: { code: 'POLICY_DENIED', message: 'denied', details },
      });
      const failure: AckFailure = err.failure;
      expect(failure.code).toBe('POLICY_DENIED');
      expect(failure.message).toBe('denied');
      expect(failure.sessionId).toBe('s-1');
      expect(failure.messageId).toBe('m-1');
      expect(failure.reasons).toEqual(['r1', 'r2']);
    });

    it('falls back to gRPC trailing metadata for reasons when details absent', () => {
      const trailing = Buffer.from(JSON.stringify({ reasons: ['tenant mismatch'] }));
      const err = new MacpAckError({ ok: false, error: { code: 'POLICY_DENIED', message: 'denied' } }, [
        { key: 'macp-error-details-bin', value: trailing },
      ]);
      expect(err.failure.reasons).toEqual(['tenant mismatch']);
    });

    it('defaults code/message to sentinels when ack.error absent', () => {
      const err = new MacpAckError({ ok: false });
      expect(err.failure.code).toBe('UNKNOWN');
      expect(err.failure.message).toBe('runtime returned nack');
      expect(err.failure.sessionId).toBe('');
      expect(err.failure.messageId).toBe('');
      expect(err.failure.reasons).toEqual([]);
    });

    it('prefers ack-level IDs over nested error IDs when both are present', () => {
      const err = new MacpAckError({
        ok: false,
        sessionId: 'from-ack',
        messageId: 'm-ack',
        error: { code: 'X', message: 'y', sessionId: 'from-error', messageId: 'm-error' },
      });
      expect(err.failure.sessionId).toBe('from-ack');
      expect(err.failure.messageId).toBe('m-ack');
    });
  });
});
