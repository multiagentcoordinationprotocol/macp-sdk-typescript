/**
 * Integration tests for the client-visible runtime 0.14.0 behaviour.
 *
 * Pins the rules the SDK suite had no coverage for. Parity with
 * macp-sdk-python's tests/integration/test_runtime_0140.py. Two of the seven
 * cases discriminate against runtime 0.13.2 (a negative Handoff Commitment
 * with no offers is now allowed; after an accept it is now refused); the other
 * five already held on 0.13.2 and guard against regression.
 *
 * - Handoff Commitment readiness (`semantics_rev` 5, RFC-MACP-0010 §6.1): a
 *   positive Commitment needs an accepted offer; a negative one is allowed only
 *   with no offers or every offer declined. Otherwise `INVALID_ENVELOPE`.
 * - Lifecycle annotations (`SessionCancel` / `SessionSuspend` /
 *   `SessionResume`) are runtime-emitted; submitting one through `Send` is
 *   `FORBIDDEN` (RFC-MACP-0001 §7.6 item 9). The dedicated RPCs still work.
 *
 * Requires runtime >= 0.14.0 started with `MACP_ALLOW_INSECURE=1`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Auth, DecisionSession, HandoffSession, MacpAckError, MacpClient, buildEnvelope } from '../../src/index';
import type { Ack } from '../../src/index';

const RUNTIME_ADDRESS = process.env.MACP_RUNTIME_ADDRESS ?? 'localhost:50051';

const owner = Auth.devAgent('owner');
const target = Auth.devAgent('target');

let client: MacpClient;

beforeAll(() => {
  client = new MacpClient({ address: RUNTIME_ADDRESS, secure: false, allowInsecure: true, auth: owner });
});

afterAll(() => {
  client.close();
});

async function startHandoff(): Promise<HandoffSession> {
  const session = new HandoffSession(client, { auth: owner });
  const ack = await session.start({
    intent: 'rev5 readiness',
    participants: ['owner', 'target', 'target2'],
    ttlMs: 30_000,
    sender: 'owner',
  });
  expect(ack.ok).toBe(true);
  return session;
}

function commit(session: HandoffSession, positive: boolean): Promise<Ack> {
  return session.commit({
    action: positive ? 'handoff.accepted' : 'handoff.declined',
    authorityScope: 'support',
    reason: 'rev5 readiness',
    outcomePositive: positive,
    sender: 'owner',
  });
}

async function expectRefused(session: HandoffSession, positive: boolean): Promise<void> {
  const attempt = commit(session, positive);
  await expect(attempt).rejects.toBeInstanceOf(MacpAckError);
  await expect(attempt).rejects.toMatchObject({ failure: { code: 'INVALID_ENVELOPE' } });
}

function offer(session: HandoffSession): Promise<Ack> {
  return session.offer({ handoffId: 'h1', targetParticipant: 'target', scope: 'support', sender: 'owner' });
}

// ── Handoff Commitment readiness (semantics_rev 5) ──────────────────

describe('Handoff Commitment readiness (semantics_rev 5)', () => {
  it('a positive Commitment needs an accepted offer', async () => {
    const session = await startHandoff();
    // No offer at all: nothing to commit positively to.
    await expectRefused(session, true);

    await offer(session);
    // Offer still pending: not settled yet.
    await expectRefused(session, true);

    await session.acceptHandoff({ handoffId: 'h1', acceptedBy: 'target', sender: 'target', auth: target });
    expect((await commit(session, true)).ok).toBe(true);
    expect(session.projection.isCommitted).toBe(true);
  });

  it('a negative Commitment is refused while an offer is pending', async () => {
    const session = await startHandoff();
    await offer(session);
    await expectRefused(session, false);

    await session.decline({
      handoffId: 'h1',
      declinedBy: 'target',
      reason: 'at capacity',
      sender: 'target',
      auth: target,
    });
    // Every offer declined: a negative Commitment is now allowed.
    expect((await commit(session, false)).ok).toBe(true);
  });

  it('a negative Commitment is allowed with no offers', async () => {
    const session = await startHandoff();
    expect((await commit(session, false)).ok).toBe(true);
  });

  it('a negative Commitment is refused after an accept', async () => {
    const session = await startHandoff();
    await offer(session);
    await session.acceptHandoff({ handoffId: 'h1', acceptedBy: 'target', sender: 'target', auth: target });
    await expectRefused(session, false);
    await session.cancel('test cleanup');
  });
});

// ── Lifecycle annotations via Send are FORBIDDEN (RFC-MACP-0001 §7.6 item 9) ──

const ANNOTATIONS = ['SessionCancel', 'SessionSuspend', 'SessionResume'] as const;

describe('Lifecycle annotations via Send are FORBIDDEN', () => {
  it.each(ANNOTATIONS)('%s via send() is FORBIDDEN', async (messageType) => {
    const coordinator = Auth.devAgent('coordinator');
    const session = new DecisionSession(client, { auth: coordinator });
    const startAck = await session.start({
      intent: 'annotation via Send',
      participants: ['coordinator', 'alice'],
      ttlMs: 30_000,
      sender: 'coordinator',
    });
    expect(startAck.ok).toBe(true);

    const envelope = buildEnvelope({
      mode: 'macp.mode.decision.v1',
      messageType,
      sessionId: session.sessionId,
      sender: 'coordinator',
      payload: client.protoRegistry.encodeKnownPayload('macp.mode.decision.v1', messageType, { reason: 'via Send' }),
    });
    const attempt = client.send(envelope, { auth: coordinator });
    await expect(attempt).rejects.toBeInstanceOf(MacpAckError);
    await expect(attempt).rejects.toMatchObject({ failure: { code: 'FORBIDDEN' } });

    // The refused annotation changed nothing: the session is still OPEN and
    // the dedicated RPC still cancels it.
    const { metadata } = await client.getSession(session.sessionId, { auth: coordinator });
    expect(metadata.state).toBe('SESSION_STATE_OPEN');
    const cancelAck = await client.cancelSession(session.sessionId, 'test cleanup', { auth: coordinator });
    expect(cancelAck.ok).toBe(true);
  });
});
