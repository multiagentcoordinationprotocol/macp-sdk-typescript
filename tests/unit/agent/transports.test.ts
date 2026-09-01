import { describe, it, expect, vi } from 'vitest';
import { GrpcTransportAdapter, HttpTransportAdapter, type HttpPollingConfig } from '../../../src/agent/transports';
import type { Envelope } from '../../../src/types';
import { MODE_DECISION } from '../../../src/constants';
import { ProtoRegistry } from '../../../src/proto-registry';
import { DecisionProjection } from '../../../src/projections/decision';
import { MacpTransportError } from '../../../src/errors';

function makeEnvelope(overrides?: Partial<Envelope>): Envelope {
  return {
    macpVersion: '1.0',
    mode: MODE_DECISION,
    messageType: 'Proposal',
    messageId: 'msg-1',
    sessionId: 'session-1',
    sender: 'agent-a',
    timestampUnixMs: String(Date.now()),
    payload: Buffer.from(JSON.stringify({ proposalId: 'p1', option: 'deploy' })),
    ...overrides,
  };
}

function makeMockStream(envelopes: Envelope[] = []) {
  return {
    responses: async function* () {
      for (const e of envelopes) yield e;
    },
    sendSubscribe: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
  };
}

describe('GrpcTransportAdapter', () => {
  it('yields messages from the stream filtered by sessionId', async () => {
    const envelope1 = makeEnvelope({ sessionId: 'session-1' });
    const envelope2 = makeEnvelope({ sessionId: 'session-2', messageId: 'msg-2' });
    const envelope3 = makeEnvelope({ sessionId: 'session-1', messageId: 'msg-3', messageType: 'Vote' });

    const mockStream = makeMockStream([envelope1, envelope2, envelope3]);

    const mockClient = {
      openStream: vi.fn().mockReturnValue(mockStream),
      protoRegistry: {
        decodeKnownPayload: vi.fn((mode: string, mt: string, payload: Buffer) => {
          try {
            return JSON.parse(payload.toString('utf8'));
          } catch {
            return {};
          }
        }),
      },
    } as any;

    const adapter = new GrpcTransportAdapter(mockClient, 'session-1');
    const messages = [];
    for await (const msg of adapter.start()) {
      messages.push(msg);
    }

    expect(messages).toHaveLength(2);
    expect(messages[0].messageType).toBe('Proposal');
    expect(messages[0].sender).toBe('agent-a');
    expect(messages[0].seq).toBe(0);
    expect(messages[1].messageType).toBe('Vote');
    expect(messages[1].seq).toBe(1);
  });

  it('decodes payload using protoRegistry', async () => {
    const envelope = makeEnvelope();
    const decoded = { proposalId: 'p1', option: 'deploy' };

    const mockStream = makeMockStream([envelope]);

    const decodeKnown = vi.fn().mockReturnValue(decoded);
    const mockClient = {
      openStream: vi.fn().mockReturnValue(mockStream),
      protoRegistry: { decodeKnownPayload: decodeKnown },
    } as any;

    const adapter = new GrpcTransportAdapter(mockClient, 'session-1');
    const messages = [];
    for await (const msg of adapter.start()) {
      messages.push(msg);
    }

    expect(decodeKnown).toHaveBeenCalledWith(MODE_DECISION, 'Proposal', envelope.payload);
    expect(messages[0].payload).toEqual(decoded);
    expect(messages[0].proposalId).toBe('p1');
  });

  it('extracts proposalId from decoded payload', async () => {
    const envelope = makeEnvelope();
    const mockStream = makeMockStream([envelope]);

    const mockClient = {
      openStream: vi.fn().mockReturnValue(mockStream),
      protoRegistry: {
        decodeKnownPayload: vi.fn().mockReturnValue({ proposalId: 'p1' }),
      },
    } as any;

    const adapter = new GrpcTransportAdapter(mockClient, 'session-1');
    const messages = [];
    for await (const msg of adapter.start()) {
      messages.push(msg);
    }

    expect(messages[0].proposalId).toBe('p1');
  });

  it('preserves raw envelope on incoming message', async () => {
    const envelope = makeEnvelope();
    const mockStream = makeMockStream([envelope]);

    const mockClient = {
      openStream: vi.fn().mockReturnValue(mockStream),
      protoRegistry: { decodeKnownPayload: vi.fn().mockReturnValue({}) },
    } as any;

    const adapter = new GrpcTransportAdapter(mockClient, 'session-1');
    const messages = [];
    for await (const msg of adapter.start()) {
      messages.push(msg);
    }

    expect(messages[0].raw).toBe(envelope);
  });

  it('stop closes the stream', async () => {
    const mockStream = makeMockStream();

    const mockClient = {
      openStream: vi.fn().mockReturnValue(mockStream),
      protoRegistry: { decodeKnownPayload: vi.fn().mockReturnValue({}) },
    } as any;

    const adapter = new GrpcTransportAdapter(mockClient, 'session-1');
    // Consume the stream
    for await (const _ of adapter.start()) {
      // empty
    }
    await adapter.stop();
    expect(mockStream.close).toHaveBeenCalled();
  });

  // RFC-MACP-0006-A1: the adapter subscribes to the session on stream open so
  // the runtime replays accepted envelopes (SessionStart, Proposal, …) before
  // switching to live broadcast. Non-initiators rely on this replay path.
  it('subscribes to the session with sessionId before reading responses', async () => {
    const envelope = makeEnvelope({ sessionId: 'session-xyz' });
    const mockStream = makeMockStream([envelope]);
    const mockClient = {
      openStream: vi.fn().mockReturnValue(mockStream),
      protoRegistry: { decodeKnownPayload: vi.fn().mockReturnValue({}) },
    } as any;

    const adapter = new GrpcTransportAdapter(mockClient, 'session-xyz');
    for await (const _ of adapter.start()) {
      break;
    }

    expect(mockStream.sendSubscribe).toHaveBeenCalledTimes(1);
    // The adapter calls sendSubscribe(sessionId, this.lastSequence). A fresh
    // adapter's lastSequence is 0 (by construction), which MacpStream treats
    // as "replay everything" — so a fresh participant still sees full
    // history on its first subscribe.
    expect(mockStream.sendSubscribe).toHaveBeenCalledWith('session-xyz', 0);
    // subscribe must be sent before any envelope is yielded
    const subscribeOrder = mockStream.sendSubscribe.mock.invocationCallOrder[0];
    const decodeOrder = (mockClient.protoRegistry.decodeKnownPayload as any).mock.invocationCallOrder[0] ?? Infinity;
    expect(subscribeOrder).toBeLessThan(decodeOrder);
  });

  it('subscribes even when the stream produces no envelopes', async () => {
    // Empty replay + no live traffic must still result in exactly one subscribe
    // frame — the runtime needs it to register the consumer.
    const mockStream = makeMockStream();
    const mockClient = {
      openStream: vi.fn().mockReturnValue(mockStream),
      protoRegistry: { decodeKnownPayload: vi.fn().mockReturnValue({}) },
    } as any;

    const adapter = new GrpcTransportAdapter(mockClient, 'session-empty');
    for await (const _ of adapter.start()) {
      // unreachable
    }

    expect(mockStream.sendSubscribe).toHaveBeenCalledTimes(1);
    expect(mockStream.sendSubscribe).toHaveBeenCalledWith('session-empty', 0);
  });

  it('passes the auth option through to openStream', async () => {
    // The transport adapter must forward its constructor `auth` so the gRPC
    // metadata for the StreamSession call carries the right identity.
    const mockStream = makeMockStream();
    const openStream = vi.fn().mockReturnValue(mockStream);
    const mockClient = {
      openStream,
      protoRegistry: { decodeKnownPayload: vi.fn().mockReturnValue({}) },
    } as any;

    const auth = { authToken: 'tok', expectedSender: 'alice' } as any;
    const adapter = new GrpcTransportAdapter(mockClient, 'session-1', auth);
    for await (const _ of adapter.start()) {
      // empty
    }

    expect(openStream).toHaveBeenCalledTimes(1);
    expect(openStream).toHaveBeenCalledWith({ auth });
  });

  // RFC-MACP-0006 §3.2: a resuming client subscribes from its own cursor
  // instead of replaying the whole session. `start()` is the only reachable
  // "reconnect" in this SDK (there is no built-in retry loop) — a caller
  // calls it again, directly or after `stop()`.
  it('resumes from its own cursor on a second start() after stop()', async () => {
    const firstPass = [
      makeEnvelope({ sessionId: 'session-1', messageId: 'msg-1' }),
      makeEnvelope({ sessionId: 'session-1', messageId: 'msg-2' }),
    ];
    const secondPass = [makeEnvelope({ sessionId: 'session-1', messageId: 'msg-3' })];

    const mockStream1 = makeMockStream(firstPass);
    const mockStream2 = makeMockStream(secondPass);
    const openStream = vi.fn().mockReturnValueOnce(mockStream1).mockReturnValueOnce(mockStream2);
    const mockClient = {
      openStream,
      protoRegistry: { decodeKnownPayload: vi.fn().mockReturnValue({}) },
    } as any;

    const adapter = new GrpcTransportAdapter(mockClient, 'session-1');

    for await (const _ of adapter.start()) {
      // drain the first pass
    }
    await adapter.stop();

    expect(adapter.lastSequence).toBe(2);

    for await (const _ of adapter.start()) {
      // drain the second pass
    }

    // First subscribe is still a full replay (afterSequence = 0)...
    expect(mockStream1.sendSubscribe).toHaveBeenCalledWith('session-1', 0);
    // ...but the second subscribe resumes from the adapter's own cursor,
    // not from 0 and not from `seq`/`delivered`-as-raw-count.
    expect(mockStream2.sendSubscribe).toHaveBeenCalledWith('session-1', 2);
    expect(adapter.lastSequence).toBe(3);
  });

  // The direct RFC-MACP-0006 §3.2 Redelivery obligation: "a redelivery MUST
  // NOT advance the client's sequence position; only a distinct accepted
  // envelope does." Failure path: without the message_id guard this would be
  // 2, and the next resume would silently skip the second delivery's ordinal.
  it('a redelivered envelope (same messageId) does not advance the resume cursor', async () => {
    const envelope = makeEnvelope({ sessionId: 'session-1', messageId: 'msg-1' });
    const redelivery = makeEnvelope({ sessionId: 'session-1', messageId: 'msg-1' });
    const mockStream = makeMockStream([envelope, redelivery]);
    const mockClient = {
      openStream: vi.fn().mockReturnValue(mockStream),
      protoRegistry: { decodeKnownPayload: vi.fn().mockReturnValue({}) },
    } as any;

    const adapter = new GrpcTransportAdapter(mockClient, 'session-1');
    const messages = [];
    for await (const msg of adapter.start()) {
      messages.push(msg);
    }

    // The envelope is still yielded both times -- deduping the counter is
    // not the same as suppressing delivery; that stays the projection
    // guard's job.
    expect(messages).toHaveLength(2);
    expect(adapter.lastSequence).toBe(1);

    // A subsequent start() must subscribe at the deduped cursor (1), not at
    // the raw delivery count (2).
    await adapter.stop();
    for await (const _ of adapter.start()) {
      // drain the second pass
    }
    expect(mockStream.sendSubscribe).toHaveBeenNthCalledWith(2, 'session-1', 1);
  });

  // Edge case 2 from the plan: an empty/absent messageId has no identity to
  // dedup on, so it must increment unconditionally -- collapsing an id-less
  // feed to one envelope would be strictly worse. Mirrors the carve-out at
  // src/projections/base.ts:224-227.
  it('envelopes with an empty messageId always advance the resume cursor', async () => {
    const e1 = makeEnvelope({ sessionId: 'session-1', messageId: '' });
    const e2 = makeEnvelope({ sessionId: 'session-1', messageId: '' });
    const mockStream = makeMockStream([e1, e2]);
    const mockClient = {
      openStream: vi.fn().mockReturnValue(mockStream),
      protoRegistry: { decodeKnownPayload: vi.fn().mockReturnValue({}) },
    } as any;

    const adapter = new GrpcTransportAdapter(mockClient, 'session-1');
    for await (const _ of adapter.start()) {
      // drain
    }

    expect(adapter.lastSequence).toBe(2);
  });

  it('a cross-session envelope affects neither the yielded messages nor the resume cursor', async () => {
    const envelope1 = makeEnvelope({ sessionId: 'session-1' });
    const envelope2 = makeEnvelope({ sessionId: 'session-2', messageId: 'msg-2' });
    const envelope3 = makeEnvelope({ sessionId: 'session-1', messageId: 'msg-3', messageType: 'Vote' });

    const mockStream = makeMockStream([envelope1, envelope2, envelope3]);
    const mockClient = {
      openStream: vi.fn().mockReturnValue(mockStream),
      protoRegistry: { decodeKnownPayload: vi.fn().mockReturnValue({}) },
    } as any;

    const adapter = new GrpcTransportAdapter(mockClient, 'session-1');
    for await (const _ of adapter.start()) {
      // drain
    }

    expect(adapter.lastSequence).toBe(2);
  });

  // Edge case 1 from the plan: start() assigned `this.stream` unconditionally,
  // orphaning any prior stream while the earlier generator kept iterating it.
  // Two live generators would both feed one counter from two
  // differently-positioned replays.
  it('start() called again without stop() closes the prior stream first', async () => {
    const mockStream1 = makeMockStream([makeEnvelope({ sessionId: 'session-1', messageId: 'msg-1' })]);
    const mockStream2 = makeMockStream([]);
    const openStream = vi.fn().mockReturnValueOnce(mockStream1).mockReturnValueOnce(mockStream2);
    const mockClient = {
      openStream,
      protoRegistry: { decodeKnownPayload: vi.fn().mockReturnValue({}) },
    } as any;

    const adapter = new GrpcTransportAdapter(mockClient, 'session-1');

    // Prime the first generator (opens mockStream1, subscribes, yields once)
    // without draining it or calling stop() -- a re-entrant start().
    const firstIterator = adapter.start()[Symbol.asyncIterator]();
    await firstIterator.next();

    for await (const _ of adapter.start()) {
      // drain the second pass
    }

    expect(mockStream1.close).toHaveBeenCalledTimes(1);
    expect(mockStream2.sendSubscribe).toHaveBeenCalledWith('session-1', 1);
  });

  // "Recognised, not recovered from" (plan §Approach): a resume below a
  // compacted base must propagate to the caller unchanged, not trigger a
  // silent auto-retry from 0 -- a full re-replay would re-fire every agent
  // handler through the unguarded dispatcher.dispatch path.
  it('a FAILED_PRECONDITION resume error propagates without a recovery subscribe', async () => {
    const mockStream = {
      responses: async function* (): AsyncGenerator<Envelope, void, void> {
        throw new MacpTransportError('session history before ordinal 5 was compacted', 'FAILED_PRECONDITION');
      },
      sendSubscribe: vi.fn().mockResolvedValue(undefined),
      close: vi.fn(),
    };
    const mockClient = {
      openStream: vi.fn().mockReturnValue(mockStream),
      protoRegistry: { decodeKnownPayload: vi.fn().mockReturnValue({}) },
    } as any;

    const adapter = new GrpcTransportAdapter(mockClient, 'session-1');

    const consume = async () => {
      for await (const _ of adapter.start()) {
        // unreachable
      }
    };

    await expect(consume()).rejects.toMatchObject({ code: 'FAILED_PRECONDITION' });
    expect(mockStream.sendSubscribe).toHaveBeenCalledTimes(1);
  });
});

describe('HttpTransportAdapter', () => {
  it('yields messages from HTTP polling', async () => {
    const events = [
      {
        envelope: makeEnvelope({ messageType: 'Proposal' }),
        seq: 0,
      },
      {
        envelope: makeEnvelope({ messageType: 'Vote', messageId: 'msg-2' }),
        seq: 1,
      },
    ];

    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return {
          ok: true,
          json: async () => ({ events }),
        };
      }
      // Second call: return empty to let the adapter stop
      return {
        ok: true,
        json: async () => ({ events: [] }),
      };
    });

    vi.stubGlobal('fetch', mockFetch);

    const config: HttpPollingConfig = {
      baseUrl: 'http://localhost:3000',
      sessionId: 'session-1',
      participantId: 'agent-1',
      pollIntervalMs: 10,
      authToken: 'test-token',
    };

    const adapter = new HttpTransportAdapter(config);
    const messages = [];

    for await (const msg of adapter.start()) {
      messages.push(msg);
      if (messages.length >= 2) {
        await adapter.stop();
        break;
      }
    }

    expect(messages).toHaveLength(2);
    expect(messages[0].messageType).toBe('Proposal');
    expect(messages[1].messageType).toBe('Vote');

    // Verify auth header was sent
    expect(mockFetch).toHaveBeenCalled();
    const fetchCall = mockFetch.mock.calls[0];
    expect(fetchCall[0]).toContain('http://localhost:3000/sessions/session-1/events');
    expect(fetchCall[1].headers['Authorization']).toBe('Bearer test-token');

    vi.unstubAllGlobals();
  });

  it('handles failed HTTP responses gracefully', async () => {
    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return { ok: false, status: 500 };
      }
      return {
        ok: true,
        json: async () => ({
          events: [{ envelope: makeEnvelope(), seq: 0 }],
        }),
      };
    });

    vi.stubGlobal('fetch', mockFetch);

    const config: HttpPollingConfig = {
      baseUrl: 'http://localhost:3000',
      sessionId: 'session-1',
      participantId: 'agent-1',
      pollIntervalMs: 10,
    };

    const adapter = new HttpTransportAdapter(config);
    const messages = [];

    for await (const msg of adapter.start()) {
      messages.push(msg);
      if (messages.length >= 1) {
        await adapter.stop();
        break;
      }
    }

    // Should have recovered from the error and yielded a message
    expect(messages).toHaveLength(1);

    vi.unstubAllGlobals();
  });

  it('handles fetch exceptions gracefully', async () => {
    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        throw new Error('Network error');
      }
      return {
        ok: true,
        json: async () => ({
          events: [{ envelope: makeEnvelope(), seq: 0 }],
        }),
      };
    });

    vi.stubGlobal('fetch', mockFetch);

    const config: HttpPollingConfig = {
      baseUrl: 'http://localhost:3000',
      sessionId: 'session-1',
      participantId: 'agent-1',
      pollIntervalMs: 10,
    };

    const adapter = new HttpTransportAdapter(config);
    const messages = [];

    for await (const msg of adapter.start()) {
      messages.push(msg);
      if (messages.length >= 1) {
        await adapter.stop();
        break;
      }
    }

    expect(messages).toHaveLength(1);

    vi.unstubAllGlobals();
  });

  it('tracks lastSeq for incremental polling', async () => {
    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      callCount++;
      if (callCount === 1) {
        return {
          ok: true,
          json: async () => ({
            events: [{ envelope: makeEnvelope(), seq: 5 }],
          }),
        };
      }
      // Second call: return another event so the loop yields and we can break
      return {
        ok: true,
        json: async () => ({
          events: [{ envelope: makeEnvelope({ messageId: 'msg-2' }), seq: 6 }],
        }),
      };
    });

    vi.stubGlobal('fetch', mockFetch);

    const config: HttpPollingConfig = {
      baseUrl: 'http://localhost:3000',
      sessionId: 'session-1',
      participantId: 'agent-1',
      pollIntervalMs: 10,
    };

    const adapter = new HttpTransportAdapter(config);
    const messages = [];

    for await (const msg of adapter.start()) {
      messages.push(msg);
      if (messages.length >= 2) {
        await adapter.stop();
        break;
      }
    }

    // Second fetch call should include after=5 (the seq from the first batch)
    expect(mockFetch.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(mockFetch.mock.calls[1][0]).toContain('after=5');

    vi.unstubAllGlobals();
  });

  it('does not send auth header when no authToken', async () => {
    const mockFetch = vi.fn().mockImplementation(async () => ({
      ok: true,
      json: async () => ({
        events: [{ envelope: makeEnvelope(), seq: 0 }],
      }),
    }));

    vi.stubGlobal('fetch', mockFetch);

    const config: HttpPollingConfig = {
      baseUrl: 'http://localhost:3000',
      sessionId: 'session-1',
      participantId: 'agent-1',
      pollIntervalMs: 10,
    };

    const adapter = new HttpTransportAdapter(config);
    for await (const msg of adapter.start()) {
      await adapter.stop();
      break;
    }

    const fetchCall = mockFetch.mock.calls[0];
    expect(fetchCall[1].headers['Authorization']).toBeUndefined();

    vi.unstubAllGlobals();
  });

  // Plan: plans/rfc-0007-first-vote-stands.md Phase 2, Approach step 6. The
  // array (Python-style) branch builds `raw` directly off raw snake_case JSON
  // (`item.message_type` etc.) — without normalizing `message_id ->
  // messageId`, `raw.messageId` is `undefined`, so a projection's mandatory
  // `if (envelope.messageId)` redelivery guard (src/projections/base.ts)
  // short-circuits and every polled envelope looks id-less, skipping dedup
  // entirely. These two tests pin the fix.
  describe('array (Python-style) branch: message_id normalization', () => {
    it('normalizes item.message_id into raw.messageId', async () => {
      const mockFetch = vi.fn().mockImplementation(async () => ({
        ok: true,
        json: async () => [
          {
            message_id: 'poll-msg-1',
            message_type: 'Proposal',
            sender: 'agent-a',
            payload: { proposalId: 'p1', option: 'deploy' },
            seq: 0,
          },
        ],
      }));

      vi.stubGlobal('fetch', mockFetch);

      const config: HttpPollingConfig = {
        baseUrl: 'http://localhost:3000',
        sessionId: 'session-1',
        participantId: 'agent-1',
        pollIntervalMs: 10,
      };

      const adapter = new HttpTransportAdapter(config);
      const messages = [];
      for await (const msg of adapter.start()) {
        messages.push(msg);
        await adapter.stop();
        break;
      }

      expect(messages).toHaveLength(1);
      expect((messages[0]!.raw as unknown as Envelope).messageId).toBe('poll-msg-1');

      vi.unstubAllGlobals();
    });

    it('a redelivered polled envelope (same message_id) is deduped once fed to a projection', async () => {
      // The adapter itself does not dedup — `message_id` dedup is a
      // projection-level guard (src/projections/base.ts). This test proves
      // the normalization above is sufficient for that guard to actually see
      // a real id for HTTP-polled envelopes, closing the gap described above.
      const registry = new ProtoRegistry();
      const encoded = registry.encodeKnownPayload(MODE_DECISION, 'Proposal', { proposalId: 'p1', option: 'deploy' });

      let callCount = 0;
      const mockFetch = vi.fn().mockImplementation(async () => {
        callCount++;
        const item = {
          mode: MODE_DECISION,
          message_id: 'poll-msg-dup',
          message_type: 'Proposal',
          sender: 'agent-a',
          payload: encoded,
          seq: callCount - 1,
        };
        // Same message_id delivered on two successive polls (redelivery).
        return { ok: true, json: async () => [item] };
      });

      vi.stubGlobal('fetch', mockFetch);

      const config: HttpPollingConfig = {
        baseUrl: 'http://localhost:3000',
        sessionId: 'session-1',
        participantId: 'agent-1',
        pollIntervalMs: 10,
      };

      const adapter = new HttpTransportAdapter(config);
      const projection = new DecisionProjection();
      let seen = 0;
      for await (const msg of adapter.start()) {
        projection.applyEnvelope(msg.raw as unknown as Envelope, registry);
        seen++;
        if (seen >= 2) {
          await adapter.stop();
          break;
        }
      }

      expect(projection.transcript).toHaveLength(1);

      vi.unstubAllGlobals();
    });
  });
});
