import { afterEach, describe, expect, it, vi } from 'vitest';
import { Auth } from '../../../src/auth';
import { MacpClient } from '../../../src/client';
import { HandoffSession } from '../../../src/handoff';
import { MacpAckError } from '../../../src/errors';

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
});
