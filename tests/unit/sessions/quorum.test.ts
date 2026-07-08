import { afterEach, describe, expect, it, vi } from 'vitest';
import { Auth } from '../../../src/auth';
import { MacpClient } from '../../../src/client';
import { QuorumSession } from '../../../src/quorum';
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

describe('QuorumSession — projection roundtrip', () => {
  it('start() appends SessionStart to transcript on ack.ok=true', async () => {
    const client = makeClient();
    const session = new QuorumSession(client);
    vi.spyOn(client, 'send').mockResolvedValue({ ok: true });

    const before = session.projection.transcript.length;
    await session.start({ intent: 'approve-deploy', participants: ['alice', 'bob'], ttlMs: 10_000 });
    expect(session.projection.transcript.length).toBe(before + 1);
  });

  it('requestApproval() records the request and moves phase to Voting', async () => {
    const client = makeClient();
    const session = new QuorumSession(client);
    vi.spyOn(client, 'send').mockResolvedValue({ ok: true });

    await session.requestApproval({ requestId: 'r1', action: 'deploy', summary: 'ship', requiredApprovals: 2 });
    expect(session.projection.requests.has('r1')).toBe(true);
    expect(session.projection.phase).toBe('Voting');
    expect(session.projection.threshold('r1')).toBe(2);
  });

  it('does NOT mutate projection when client.send throws MacpAckError', async () => {
    const client = makeClient();
    const session = new QuorumSession(client);
    vi.spyOn(client, 'send').mockRejectedValue(
      new MacpAckError({ ok: false, error: { code: 'POLICY_DENIED', message: 'no' } }),
    );

    await expect(
      session.requestApproval({ requestId: 'r1', action: 'deploy', summary: 'ship', requiredApprovals: 1 }),
    ).rejects.toBeInstanceOf(MacpAckError);
    expect(session.projection.requests.has('r1')).toBe(false);
  });

  it('approve() increments approvalCount() and reaches quorum when threshold met', async () => {
    const client = makeClient();
    const session = new QuorumSession(client);
    vi.spyOn(client, 'send').mockResolvedValue({ ok: true });

    await session.requestApproval({ requestId: 'r1', action: 'deploy', summary: 'ship', requiredApprovals: 1 });
    await session.approve({ requestId: 'r1' });
    expect(session.projection.approvalCount('r1')).toBe(1);
    expect(session.projection.hasQuorum('r1')).toBe(true);
    expect(session.projection.votedSenders('r1')).toEqual(['alice']);
  });

  it('reject() does NOT count toward approvalCount() but shows up in votedSenders()', async () => {
    const client = makeClient();
    const session = new QuorumSession(client);
    vi.spyOn(client, 'send').mockResolvedValue({ ok: true });

    await session.requestApproval({ requestId: 'r1', action: 'deploy', summary: 'ship', requiredApprovals: 2 });
    await session.reject({ requestId: 'r1', reason: 'risky' });
    expect(session.projection.approvalCount('r1')).toBe(0);
    expect(session.projection.rejectionCount('r1')).toBe(1);
    expect(session.projection.votedSenders('r1')).toEqual(['alice']);
  });

  it('abstain() records the abstention without approving', async () => {
    const client = makeClient();
    const session = new QuorumSession(client);
    vi.spyOn(client, 'send').mockResolvedValue({ ok: true });

    await session.requestApproval({ requestId: 'r1', action: 'deploy', summary: 'ship', requiredApprovals: 2 });
    await session.abstain({ requestId: 'r1', reason: 'recused' });
    expect(session.projection.abstentionCount('r1')).toBe(1);
    expect(session.projection.approvalCount('r1')).toBe(0);
    expect(session.projection.hasQuorum('r1')).toBe(false);
  });

  it('commit() flips projection.isCommitted', async () => {
    const client = makeClient();
    const session = new QuorumSession(client);
    vi.spyOn(client, 'send').mockResolvedValue({ ok: true });

    await session.commit({ action: 'deploy', authorityScope: 'prod', reason: 'quorum' });
    expect(session.projection.isCommitted).toBe(true);
  });

  it('a resolved NACK is returned but not applied to the projection', async () => {
    const client = makeClient();
    const session = new QuorumSession(client);
    vi.spyOn(client, 'send').mockResolvedValue({ ok: false, error: { code: 'POLICY_DENIED', message: 'no' } });

    const ack = await session.requestApproval({
      requestId: 'r1',
      action: 'deploy',
      summary: 'ship',
      requiredApprovals: 1,
    });
    expect(ack.ok).toBe(false);
    expect(session.projection.requests.has('r1')).toBe(false);
    expect(session.projection.transcript).toHaveLength(0);
  });
});

describe('QuorumSession — lifecycle delegation', () => {
  it('cancel() delegates to client.cancelSession with the session id', async () => {
    const client = makeClient();
    const session = new QuorumSession(client);
    const spy = vi
      .spyOn(client, 'cancelSession')
      .mockResolvedValue({ ok: true, sessionState: 'SESSION_STATE_CANCELLED' });

    const ack = await session.cancel('done');
    expect(ack.sessionState).toBe('SESSION_STATE_CANCELLED');
    expect(spy).toHaveBeenCalledWith(session.sessionId, 'done', expect.objectContaining({ raiseOnNack: true }));
  });

  it('suspend() delegates to client.suspendSession with the session id', async () => {
    const client = makeClient();
    const session = new QuorumSession(client);
    const spy = vi
      .spyOn(client, 'suspendSession')
      .mockResolvedValue({ ok: true, sessionState: 'SESSION_STATE_SUSPENDED' });

    const ack = await session.suspend('pausing');
    expect(ack.sessionState).toBe('SESSION_STATE_SUSPENDED');
    expect(spy).toHaveBeenCalledWith(session.sessionId, 'pausing', expect.objectContaining({ raiseOnNack: true }));
  });

  it('resume() delegates to client.resumeSession with the session id', async () => {
    const client = makeClient();
    const session = new QuorumSession(client);
    const spy = vi.spyOn(client, 'resumeSession').mockResolvedValue({ ok: true, sessionState: 'SESSION_STATE_OPEN' });

    const ack = await session.resume('back');
    expect(ack.sessionState).toBe('SESSION_STATE_OPEN');
    expect(spy).toHaveBeenCalledWith(session.sessionId, 'back', expect.objectContaining({ raiseOnNack: true }));
  });
});
