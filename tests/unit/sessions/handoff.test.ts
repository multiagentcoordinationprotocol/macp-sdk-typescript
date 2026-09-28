import { afterEach, describe, expect, it, vi } from 'vitest';
import { Auth } from '../../../src/auth';
import { MacpClient } from '../../../src/client';
import { HandoffSession } from '../../../src/handoff';
import { MacpAckError, MacpIdentityMismatchError } from '../../../src/errors';
import { MODE_HANDOFF } from '../../../src/constants';
import type { Envelope } from '../../../src/types';

function makeClient(): MacpClient {
  return new MacpClient({
    address: '127.0.0.1:50051',
    secure: false,
    allowInsecure: true,
    auth: Auth.bearer('alice-token', { expectedSender: 'alice' }),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('HandoffSession — projection roundtrip', () => {
  it('start() appends SessionStart to transcript on ack.ok=true', async () => {
    const client = makeClient();
    const session = new HandoffSession(client);
    vi.spyOn(client, 'send').mockResolvedValue({ ok: true });

    const before = session.projection.transcript.length;
    await session.start({ intent: 'escalate', participants: ['alice', 'bob'], ttlMs: 10_000 });
    expect(session.projection.transcript.length).toBe(before + 1);
  });

  it('start() accepts an empty intent (issue #124 item 3)', async () => {
    const client = makeClient();
    const session = new HandoffSession(client);
    vi.spyOn(client, 'send').mockResolvedValue({ ok: true });

    await expect(session.start({ intent: '', participants: ['alice', 'bob'], ttlMs: 10_000 })).resolves.toMatchObject({
      ok: true,
    });
  });

  it('offer() records a pending handoff', async () => {
    const client = makeClient();
    const session = new HandoffSession(client);
    vi.spyOn(client, 'send').mockResolvedValue({ ok: true });

    await session.offer({ handoffId: 'h1', targetParticipant: 'bob', scope: 'ops' });
    expect(session.projection.pendingHandoffs().map((h) => h.handoffId)).toEqual(['h1']);
    expect(session.projection.getHandoff('h1')?.status).toBe('offered');
  });

  it('does NOT mutate projection when client.send throws MacpAckError', async () => {
    const client = makeClient();
    const session = new HandoffSession(client);
    vi.spyOn(client, 'send').mockRejectedValue(
      new MacpAckError({ ok: false, error: { code: 'POLICY_DENIED', message: 'no' } }),
    );

    await expect(session.offer({ handoffId: 'h1', targetParticipant: 'bob', scope: 'ops' })).rejects.toBeInstanceOf(
      MacpAckError,
    );
    expect(session.projection.handoffs.has('h1')).toBe(false);
  });

  it('addContext() sets contextContentType and flips status from offered to context_sent', async () => {
    const client = makeClient();
    const session = new HandoffSession(client);
    vi.spyOn(client, 'send').mockResolvedValue({ ok: true });

    await session.offer({ handoffId: 'h1', targetParticipant: 'bob', scope: 'ops' });
    await session.addContext({ handoffId: 'h1', contentType: 'application/json' });
    const record = session.projection.getHandoff('h1');
    expect(record?.status).toBe('context_sent');
    expect(record?.contextContentType).toBe('application/json');
  });

  it('sendContext alias removed in 0.3.0 (use addContext)', () => {
    const session = new HandoffSession(makeClient());
    expect((session as unknown as { sendContext?: unknown }).sendContext).toBeUndefined();
  });

  it('acceptHandoff() flips isAccepted()', async () => {
    const client = makeClient();
    const session = new HandoffSession(client);
    vi.spyOn(client, 'send').mockResolvedValue({ ok: true });

    await session.offer({ handoffId: 'h1', targetParticipant: 'bob', scope: 'ops' });
    await session.acceptHandoff({ handoffId: 'h1', acceptedBy: 'bob' });
    expect(session.projection.isAccepted('h1')).toBe(true);
  });

  it('acceptHandoff() strips a client-supplied implicit=true before encoding', () => {
    // The runtime rejects client-submitted accepts with implicit=true; the SDK
    // must never let one reach the wire. Encode the payload the session builds
    // and assert the `implicit` field is absent.
    const client = makeClient();
    const encodeSpy = vi.spyOn(client.protoRegistry, 'encodeKnownPayload');
    const session = new HandoffSession(client);
    vi.spyOn(client, 'send').mockResolvedValue({ ok: true });

    // @ts-expect-error — `implicit` is intentionally not on the public input type;
    // this simulates a caller forcing it through.
    void session.acceptHandoff({ handoffId: 'h1', acceptedBy: 'bob', implicit: true });

    const acceptCall = encodeSpy.mock.calls.find((c) => c[1] === 'HandoffAccept');
    expect(acceptCall).toBeDefined();
    expect(acceptCall?.[2]).not.toHaveProperty('implicit');
  });

  it('decline() flips isDeclined()', async () => {
    const client = makeClient();
    const session = new HandoffSession(client);
    vi.spyOn(client, 'send').mockResolvedValue({ ok: true });

    await session.offer({ handoffId: 'h1', targetParticipant: 'bob', scope: 'ops' });
    await session.decline({ handoffId: 'h1', declinedBy: 'bob', reason: 'busy' });
    expect(session.projection.isDeclined('h1')).toBe(true);
  });

  it('commit() flips projection.isCommitted', async () => {
    const client = makeClient();
    const session = new HandoffSession(client);
    vi.spyOn(client, 'send').mockResolvedValue({ ok: true });

    await session.commit({ action: 'handover', authorityScope: 'ops', reason: 'accepted' });
    expect(session.projection.isCommitted).toBe(true);
  });

  it('a resolved NACK is returned but not applied to the projection', async () => {
    const client = makeClient();
    const session = new HandoffSession(client);
    vi.spyOn(client, 'send').mockResolvedValue({ ok: false, error: { code: 'POLICY_DENIED', message: 'no' } });

    const ack = await session.offer({ handoffId: 'h1', targetParticipant: 'bob', scope: 'ops' });
    expect(ack.ok).toBe(false);
    expect(session.projection.handoffs.has('h1')).toBe(false);
    expect(session.projection.transcript).toHaveLength(0);
  });

  // Issue #108.6/4f: addContext previously required contentType with no
  // default. Fails on old code (contentType was required, not optional).
  it("issue #108.6: addContext() without contentType defaults to 'application/octet-stream' on the encoded payload", async () => {
    const client = makeClient();
    const session = new HandoffSession(client);
    const sendSpy = vi.spyOn(client, 'send').mockResolvedValue({ ok: true });

    await session.addContext({ handoffId: 'h1' });

    const envelope = sendSpy.mock.calls[0]![0] as Envelope;
    const decoded = client.protoRegistry.decodeKnownPayload(MODE_HANDOFF, 'HandoffContext', envelope.payload);
    expect(decoded).toMatchObject({ contentType: 'application/octet-stream' });
  });

  // Deliberately `||`, not `??` (see the comment at addContext's call site) —
  // an explicit empty string must also fall back to the default.
  it("issue #108.6: addContext() with an explicit empty contentType still defaults to 'application/octet-stream'", async () => {
    const client = makeClient();
    const session = new HandoffSession(client);
    const sendSpy = vi.spyOn(client, 'send').mockResolvedValue({ ok: true });

    await session.addContext({ handoffId: 'h1', contentType: '' });

    const envelope = sendSpy.mock.calls[0]![0] as Envelope;
    const decoded = client.protoRegistry.decodeKnownPayload(MODE_HANDOFF, 'HandoffContext', envelope.payload);
    expect(decoded).toMatchObject({ contentType: 'application/octet-stream' });
  });

  // Issue #108.5/4e: acceptHandoff builds its own `rest` copy rather than
  // routing through toProtoPayload(input) (the only action here that
  // doesn't) — decoding the actual wire payload is what proves the fallback
  // was applied to `rest`, not silently dropped by being applied to `input`
  // instead. Fails on old code: acceptedBy was passed straight through.
  it.each([undefined, ''])(
    'issue #108.5: acceptHandoff() defaults acceptedBy to the resolved sender (input=%j)',
    async (acceptedBy) => {
      const client = makeClient();
      const session = new HandoffSession(client);
      const sendSpy = vi.spyOn(client, 'send').mockResolvedValue({ ok: true });

      await session.acceptHandoff({ handoffId: 'h1', acceptedBy });

      const envelope = sendSpy.mock.calls[0]![0] as Envelope;
      const decoded = client.protoRegistry.decodeKnownPayload(MODE_HANDOFF, 'HandoffAccept', envelope.payload);
      expect(decoded).toMatchObject({ acceptedBy: 'alice' });
    },
  );

  it.each([undefined, ''])(
    'issue #108.5: decline() defaults declinedBy to the resolved sender (input=%j)',
    async (declinedBy) => {
      const client = makeClient();
      const session = new HandoffSession(client);
      const sendSpy = vi.spyOn(client, 'send').mockResolvedValue({ ok: true });

      await session.decline({ handoffId: 'h1', declinedBy, reason: 'busy' });

      const envelope = sendSpy.mock.calls[0]![0] as Envelope;
      const decoded = client.protoRegistry.decodeKnownPayload(MODE_HANDOFF, 'HandoffDecline', envelope.payload);
      expect(decoded).toMatchObject({ declinedBy: 'alice' });
    },
  );

  // Negative case for issue #108.5: an explicitly-supplied non-empty
  // acceptedBy/declinedBy must be preserved, not overwritten by the resolved
  // sender (client auth resolves the sender to 'alice' here). Fails on a
  // mutation that unconditionally sets acceptedBy/declinedBy = sender.
  it('issue #108.5: acceptHandoff() preserves an explicitly-supplied acceptedBy', async () => {
    const client = makeClient();
    const session = new HandoffSession(client);
    const sendSpy = vi.spyOn(client, 'send').mockResolvedValue({ ok: true });

    await session.acceptHandoff({ handoffId: 'h1', acceptedBy: 'carol' });

    const envelope = sendSpy.mock.calls[0]![0] as Envelope;
    const decoded = client.protoRegistry.decodeKnownPayload(MODE_HANDOFF, 'HandoffAccept', envelope.payload);
    expect(decoded).toMatchObject({ acceptedBy: 'carol' });
  });

  it('issue #108.5: decline() preserves an explicitly-supplied declinedBy', async () => {
    const client = makeClient();
    const session = new HandoffSession(client);
    const sendSpy = vi.spyOn(client, 'send').mockResolvedValue({ ok: true });

    await session.decline({ handoffId: 'h1', declinedBy: 'carol', reason: 'busy' });

    const envelope = sendSpy.mock.calls[0]![0] as Envelope;
    const decoded = client.protoRegistry.decodeKnownPayload(MODE_HANDOFF, 'HandoffDecline', envelope.payload);
    expect(decoded).toMatchObject({ declinedBy: 'carol' });
  });

  // Issue #108.4/4d: start()'s input type gained an `auth` field. Fails on old
  // code: previously start() ignored a per-call `auth` entirely, so a
  // conflicting per-call `auth.expectedSender` could never surface here.
  it('issue #108.4: start() with a per-call auth.expectedSender conflicting with sender throws MacpIdentityMismatchError', async () => {
    // Client-level auth is deliberately permissive (no expectedSender) so this
    // test only passes if start() actually threads input.auth into senderFor()
    // — makeClient()'s expectedSender:'alice' would make this vacuous, since
    // sender:'mallory' would conflict with the client credential regardless.
    const client = new MacpClient({
      address: '127.0.0.1:50051',
      secure: false,
      allowInsecure: true,
      auth: Auth.devAgent('alice'),
    });
    const session = new HandoffSession(client);
    vi.spyOn(client, 'send').mockResolvedValue({ ok: true });

    await expect(
      session.start({
        intent: 'escalate',
        participants: ['alice', 'bob'],
        ttlMs: 10_000,
        sender: 'mallory',
        auth: Auth.bearer('tok', { expectedSender: 'alice' }),
      }),
    ).rejects.toBeInstanceOf(MacpIdentityMismatchError);
  });

  it('issue #108.4: start() forwards a per-call auth to client.send', async () => {
    const client = makeClient();
    const session = new HandoffSession(client);
    const sendSpy = vi.spyOn(client, 'send').mockResolvedValue({ ok: true });
    const perCallAuth = Auth.bearer('carol-token', { expectedSender: 'carol' });

    await session.start({
      intent: 'escalate',
      participants: ['alice', 'bob'],
      ttlMs: 10_000,
      sender: 'carol',
      auth: perCallAuth,
    });

    expect(sendSpy.mock.calls[0]![1]).toMatchObject({ auth: perCallAuth });
  });
});

describe('HandoffSession — lifecycle delegation', () => {
  it('cancel() delegates to client.cancelSession with the session id', async () => {
    const client = makeClient();
    const session = new HandoffSession(client);
    const spy = vi
      .spyOn(client, 'cancelSession')
      .mockResolvedValue({ ok: true, sessionState: 'SESSION_STATE_CANCELLED' });

    const ack = await session.cancel('done');
    expect(ack.sessionState).toBe('SESSION_STATE_CANCELLED');
    expect(spy).toHaveBeenCalledWith(session.sessionId, 'done', expect.objectContaining({ raiseOnNack: true }));
  });

  it('suspend() delegates to client.suspendSession with the session id', async () => {
    const client = makeClient();
    const session = new HandoffSession(client);
    const spy = vi
      .spyOn(client, 'suspendSession')
      .mockResolvedValue({ ok: true, sessionState: 'SESSION_STATE_SUSPENDED' });

    const ack = await session.suspend('pausing');
    expect(ack.sessionState).toBe('SESSION_STATE_SUSPENDED');
    expect(spy).toHaveBeenCalledWith(session.sessionId, 'pausing', expect.objectContaining({ raiseOnNack: true }));
  });

  it('resume() delegates to client.resumeSession with the session id', async () => {
    const client = makeClient();
    const session = new HandoffSession(client);
    const spy = vi.spyOn(client, 'resumeSession').mockResolvedValue({ ok: true, sessionState: 'SESSION_STATE_OPEN' });

    const ack = await session.resume('back');
    expect(ack.sessionState).toBe('SESSION_STATE_OPEN');
    expect(spy).toHaveBeenCalledWith(session.sessionId, 'back', expect.objectContaining({ raiseOnNack: true }));
  });
});
