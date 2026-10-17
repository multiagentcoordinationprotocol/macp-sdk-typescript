import { describe, it, expect } from 'vitest';
import {
  MacpSdkError,
  MacpTransportError,
  MacpAckError,
  MacpSessionError,
  MacpTimeoutError,
  MacpRetryError,
  MacpIdentityMismatchError,
  macpErrorCodeFromMetadata,
  parseErrorDetails,
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
    expect(err.macpErrorCode).toBeUndefined();
  });

  it('MacpTransportError carries an optional MACP registry code beside the status', () => {
    const err = new MacpTransportError('no such session', 'NOT_FOUND', 'SESSION_NOT_FOUND');
    expect(err.code).toBe('NOT_FOUND');
    expect(err.macpErrorCode).toBe('SESSION_NOT_FOUND');
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

  // Runtime 0.9.0 (S13): POLICY_DENIED details gain structured `denials` beside
  // the legacy `reasons` strings, and veto messages no longer embed participant ids.
  describe('structured POLICY_DENIED details (runtime 0.9.0)', () => {
    const details09 = {
      reasons: ['critical objection veto', 'quorum not met'],
      denials: [
        { code: 'veto', message: 'critical objection veto', participants: ['agent://x', 'agent://y'] },
        { code: 'quorum_not_met', message: 'quorum not met', participants: [] },
      ],
    };

    it('MacpAckError.failure.denials is parsed from ack.error.details', () => {
      const err = new MacpAckError({
        ok: false,
        error: { code: 'POLICY_DENIED', message: 'denied', details: Buffer.from(JSON.stringify(details09)) },
      });
      expect(err.failure.reasons).toEqual(['critical objection veto', 'quorum not met']);
      expect(err.failure.denials).toEqual(details09.denials);
    });

    it('MacpAckError.failure.denials falls back to macp-error-details-bin metadata', () => {
      const err = new MacpAckError({ ok: false, error: { code: 'POLICY_DENIED', message: 'denied' } }, [
        { key: 'macp-error-details-bin', value: Buffer.from(JSON.stringify(details09)) },
      ]);
      expect(err.failure.denials.map((d) => d.code)).toEqual(['veto', 'quorum_not_met']);
      expect(err.failure.denials[0].participants).toEqual(['agent://x', 'agent://y']);
    });

    it('a pre-0.9.0 reasons-only payload yields denials: []', () => {
      const err = new MacpAckError({
        ok: false,
        error: { code: 'POLICY_DENIED', message: 'denied', details: Buffer.from('{"reasons":["veto, from: a"]}') },
      });
      expect(err.failure.reasons).toEqual(['veto, from: a']);
      expect(err.failure.denials).toEqual([]);
    });

    it('a non-policy NACK has empty reasons and denials', () => {
      const err = new MacpAckError({ ok: false, error: { code: 'SESSION_NOT_OPEN', message: 'closed' } });
      expect(err.failure.denials).toEqual([]);
    });

    it('parseErrorDetails keeps unknown codes verbatim and defaults a missing code to unspecified', () => {
      const parsed = parseErrorDetails(
        JSON.stringify({
          reasons: ['a', 7],
          denials: [
            { code: 'vendor_custom', message: 'custom rule' },
            { message: 'no code', participants: ['agent://p', 3] },
            { code: 'veto' },
            null,
            'junk',
          ],
        }),
      );
      expect(parsed.reasons).toEqual(['a']);
      expect(parsed.denials).toEqual([
        { code: 'vendor_custom', message: 'custom rule', participants: [] },
        { code: 'unspecified', message: 'no code', participants: ['agent://p'] },
      ]);
    });

    it.each([
      ['undefined', undefined],
      ['null', null],
      ['empty buffer', Buffer.alloc(0)],
      ['non-JSON', 'not json'],
      ['JSON scalar', '42'],
      ['JSON null', 'null'],
    ])('parseErrorDetails never throws on %s input', (_label, input) => {
      expect(parseErrorDetails(input as never)).toEqual({ reasons: [], denials: [] });
    });

    it('parseErrorDetails accepts a Uint8Array (inline stream MACPError.details)', () => {
      const bytes = new Uint8Array(Buffer.from(JSON.stringify(details09)));
      expect(parseErrorDetails(bytes).denials).toHaveLength(2);
    });
  });

  describe('macpErrorCodeFromMetadata', () => {
    it('reads the macp-error-code key (string or Buffer value)', () => {
      expect(macpErrorCodeFromMetadata([{ key: 'macp-error-code', value: 'POLICY_DENIED' }])).toBe('POLICY_DENIED');
      expect(macpErrorCodeFromMetadata([{ key: 'macp-error-code', value: Buffer.from('FORBIDDEN') }])).toBe(
        'FORBIDDEN',
      );
    });

    it('returns undefined when absent or empty', () => {
      expect(macpErrorCodeFromMetadata(undefined)).toBeUndefined();
      expect(macpErrorCodeFromMetadata([{ key: 'other', value: 'x' }])).toBeUndefined();
      expect(macpErrorCodeFromMetadata([{ key: 'macp-error-code', value: '' }])).toBeUndefined();
    });
  });
});
