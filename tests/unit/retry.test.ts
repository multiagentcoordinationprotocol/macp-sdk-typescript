import { describe, it, expect, vi, beforeEach } from 'vitest';
import { retrySend, DEFAULT_RETRY_POLICY } from '../../src/retry';
import { MacpAckError, MacpRetryError, MacpTransportError } from '../../src/errors';
import type { Ack, Envelope } from '../../src/types';

function makeEnvelope(): Envelope {
  return {
    macpVersion: '1.0',
    mode: 'macp.mode.decision.v1',
    messageType: 'Proposal',
    messageId: 'msg-1',
    sessionId: 'session-1',
    sender: 'agent-a',
    timestampUnixMs: String(Date.now()),
    payload: Buffer.alloc(0),
  };
}

function makeAck(ok: boolean, code?: string, message?: string): Ack {
  if (ok) return { ok: true, messageId: 'msg-1', sessionId: 'session-1' };
  return { ok: false, error: { code: code ?? 'UNKNOWN', message: message ?? 'error' } };
}

function makeMockClient(responses: Array<Ack | Error>): any {
  let callIndex = 0;
  return {
    send: vi.fn().mockImplementation(async () => {
      const response = responses[callIndex++];
      if (response instanceof Error) throw response;
      if (!response.ok) throw new MacpAckError(response);
      return response;
    }),
  };
}

const FAST_POLICY = { backoffBase: 0.001, backoffMax: 0.001 };

describe('retrySend', () => {
  it('succeeds on first attempt without retry', async () => {
    const client = makeMockClient([makeAck(true)]);
    const envelope = makeEnvelope();

    const result = await retrySend(client, envelope);

    expect(result.ok).toBe(true);
    expect(client.send).toHaveBeenCalledOnce();
  });

  it('retries on MacpTransportError and succeeds', async () => {
    const client = makeMockClient([new MacpTransportError('connection reset'), makeAck(true)]);
    const result = await retrySend(client, makeEnvelope(), { policy: FAST_POLICY });

    expect(result.ok).toBe(true);
    expect(client.send).toHaveBeenCalledTimes(2);
  });

  it('retries on MacpAckError with retryable code', async () => {
    const client = makeMockClient([makeAck(false, 'RATE_LIMITED', 'slow down'), makeAck(true)]);
    const result = await retrySend(client, makeEnvelope(), { policy: FAST_POLICY });

    expect(result.ok).toBe(true);
    expect(client.send).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry on non-retryable MacpAckError', async () => {
    const client = makeMockClient([makeAck(false, 'INVALID_PAYLOAD', 'bad data')]);

    await expect(retrySend(client, makeEnvelope())).rejects.toThrow(MacpAckError);
    expect(client.send).toHaveBeenCalledOnce();
  });

  it('throws MacpRetryError after exhausting retries', async () => {
    const client = makeMockClient([
      new MacpTransportError('fail 1'),
      new MacpTransportError('fail 2'),
      new MacpTransportError('fail 3'),
      new MacpTransportError('fail 4'),
    ]);

    let caught: Error | undefined;
    try {
      await retrySend(client, makeEnvelope(), { policy: FAST_POLICY });
    } catch (err) {
      caught = err as Error;
    }

    expect(caught).toBeInstanceOf(MacpRetryError);
    expect(caught!.message).toBe('retries exhausted after 3 attempts');
    expect(client.send).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
  });

  it('respects custom maxRetries', async () => {
    const client = makeMockClient([new MacpTransportError('fail'), new MacpTransportError('fail'), makeAck(true)]);
    const result = await retrySend(client, makeEnvelope(), {
      policy: { maxRetries: 2, ...FAST_POLICY },
    });

    expect(result.ok).toBe(true);
    expect(client.send).toHaveBeenCalledTimes(3);
  });

  it('respects custom retryableCodes', async () => {
    const client = makeMockClient([makeAck(false, 'CUSTOM_ERROR', 'custom'), makeAck(true)]);
    const result = await retrySend(client, makeEnvelope(), {
      policy: { retryableCodes: new Set(['CUSTOM_ERROR']), ...FAST_POLICY },
    });

    expect(result.ok).toBe(true);
    expect(client.send).toHaveBeenCalledTimes(2);
  });

  it('rethrows unexpected errors without retrying', async () => {
    const client = makeMockClient([new TypeError('unexpected')]);

    await expect(retrySend(client, makeEnvelope())).rejects.toThrow(TypeError);
    expect(client.send).toHaveBeenCalledOnce();
  });

  it('passes auth option to client.send', async () => {
    const client = makeMockClient([makeAck(true)]);
    const envelope = makeEnvelope();
    const auth = { bearerToken: 'test-agent', senderHint: 'test-agent' };

    await retrySend(client, envelope, { auth });

    expect(client.send).toHaveBeenCalledWith(envelope, { auth, raiseOnNack: true });
  });
});

describe('DEFAULT_RETRY_POLICY', () => {
  it('has sensible defaults', () => {
    expect(DEFAULT_RETRY_POLICY.maxRetries).toBe(3);
    expect(DEFAULT_RETRY_POLICY.backoffBase).toBe(0.1);
    expect(DEFAULT_RETRY_POLICY.backoffMax).toBe(2.0);
    expect(DEFAULT_RETRY_POLICY.retryableCodes).toContain('RATE_LIMITED');
    expect(DEFAULT_RETRY_POLICY.retryableCodes).toContain('INTERNAL_ERROR');
  });

  // Cross-SDK parity: the retryable set must match exactly between TypeScript
  // and Python (python-sdk/src/macp_sdk/retry.py). FORBIDDEN, UNAUTHENTICATED,
  // and POLICY_DENIED must NOT be retryable — a well-meaning contributor
  // adding one of these on one side would desync the SDKs.
  it('retryableCodes matches exactly {RATE_LIMITED, INTERNAL_ERROR}', () => {
    const codes = [...DEFAULT_RETRY_POLICY.retryableCodes].sort();
    expect(codes).toEqual(['INTERNAL_ERROR', 'RATE_LIMITED']);
  });
});
