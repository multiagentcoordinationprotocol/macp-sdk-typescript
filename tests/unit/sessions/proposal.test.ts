import { afterEach, describe, expect, it, vi } from 'vitest';
import { Auth } from '../../../src/auth';
import { MacpClient } from '../../../src/client';
import { ProposalSession } from '../../../src/proposal';
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

describe('ProposalSession — projection roundtrip', () => {
  it('start() appends SessionStart to transcript on ack.ok=true', async () => {
    const client = makeClient();
    const session = new ProposalSession(client);
    vi.spyOn(client, 'send').mockResolvedValue({ ok: true });

    const before = session.projection.transcript.length;
    await session.start({ intent: 'spec-review', participants: ['alice', 'bob'], ttlMs: 10_000 });
    expect(session.projection.transcript.length).toBe(before + 1);
  });

  it('propose() records an open proposal in activeProposals()', async () => {
    const client = makeClient();
    const session = new ProposalSession(client);
    vi.spyOn(client, 'send').mockResolvedValue({ ok: true });

    await session.propose({ proposalId: 'p1', title: 'v1' });
    expect(session.projection.activeProposals().map((p) => p.proposalId)).toEqual(['p1']);
  });

  it('does NOT mutate projection when client.send throws MacpAckError', async () => {
    const client = makeClient();
    const session = new ProposalSession(client);
    vi.spyOn(client, 'send').mockRejectedValue(
      new MacpAckError({ ok: false, error: { code: 'POLICY_DENIED', message: 'no' } }),
    );

    await expect(session.propose({ proposalId: 'p1', title: 'v1' })).rejects.toBeInstanceOf(MacpAckError);
    expect(session.projection.proposals.has('p1')).toBe(false);
  });

  it('counterPropose() adds a proposal that supersedes the original', async () => {
    const client = makeClient();
    const session = new ProposalSession(client);
    vi.spyOn(client, 'send').mockResolvedValue({ ok: true });

    await session.propose({ proposalId: 'p1', title: 'v1' });
    await session.counterPropose({ proposalId: 'p2', supersedesProposalId: 'p1', title: 'v2' });
    expect(session.projection.proposals.get('p2')?.supersedes).toBe('p1');
  });

  it('accept() flips isAccepted() for that proposal', async () => {
    const client = makeClient();
    const session = new ProposalSession(client);
    vi.spyOn(client, 'send').mockResolvedValue({ ok: true });

    await session.propose({ proposalId: 'p1', title: 'v1' });
    await session.accept({ proposalId: 'p1' });
    expect(session.projection.isAccepted('p1')).toBe(true);
  });

  it('reject({ terminal: true }) flips isTerminallyRejected()', async () => {
    const client = makeClient();
    const session = new ProposalSession(client);
    vi.spyOn(client, 'send').mockResolvedValue({ ok: true });

    await session.propose({ proposalId: 'p1', title: 'v1' });
    await session.reject({ proposalId: 'p1', terminal: true, reason: 'nope' });
    expect(session.projection.isTerminallyRejected('p1')).toBe(true);
    expect(session.projection.phase).toBe('TerminalRejected');
  });

  it('withdraw() marks the proposal withdrawn and removes it from activeProposals()', async () => {
    const client = makeClient();
    const session = new ProposalSession(client);
    vi.spyOn(client, 'send').mockResolvedValue({ ok: true });

    await session.propose({ proposalId: 'p1', title: 'v1' });
    await session.withdraw({ proposalId: 'p1' });
    expect(session.projection.proposals.get('p1')?.status).toBe('withdrawn');
    expect(session.projection.activeProposals()).toHaveLength(0);
  });

  it('commit() flips projection.isCommitted', async () => {
    const client = makeClient();
    const session = new ProposalSession(client);
    vi.spyOn(client, 'send').mockResolvedValue({ ok: true });

    await session.commit({ action: 'adopt', authorityScope: 'team', reason: 'accepted' });
    expect(session.projection.isCommitted).toBe(true);
  });

  it('a resolved NACK is returned but not applied to the projection', async () => {
    const client = makeClient();
    const session = new ProposalSession(client);
    vi.spyOn(client, 'send').mockResolvedValue({ ok: false, error: { code: 'POLICY_DENIED', message: 'no' } });

    const ack = await session.propose({ proposalId: 'p1', title: 'v1' });
    expect(ack.ok).toBe(false);
    expect(session.projection.proposals.has('p1')).toBe(false);
    expect(session.projection.transcript).toHaveLength(0);
  });
});

describe('ProposalSession — lifecycle delegation', () => {
  it('cancel() delegates to client.cancelSession with the session id', async () => {
    const client = makeClient();
    const session = new ProposalSession(client);
    const spy = vi
      .spyOn(client, 'cancelSession')
      .mockResolvedValue({ ok: true, sessionState: 'SESSION_STATE_CANCELLED' });

    const ack = await session.cancel('done');
    expect(ack.sessionState).toBe('SESSION_STATE_CANCELLED');
    expect(spy).toHaveBeenCalledWith(session.sessionId, 'done', expect.objectContaining({ raiseOnNack: true }));
  });

  it('suspend() delegates to client.suspendSession with the session id', async () => {
    const client = makeClient();
    const session = new ProposalSession(client);
    const spy = vi
      .spyOn(client, 'suspendSession')
      .mockResolvedValue({ ok: true, sessionState: 'SESSION_STATE_SUSPENDED' });

    const ack = await session.suspend('pausing');
    expect(ack.sessionState).toBe('SESSION_STATE_SUSPENDED');
    expect(spy).toHaveBeenCalledWith(session.sessionId, 'pausing', expect.objectContaining({ raiseOnNack: true }));
  });

  it('resume() delegates to client.resumeSession with the session id', async () => {
    const client = makeClient();
    const session = new ProposalSession(client);
    const spy = vi.spyOn(client, 'resumeSession').mockResolvedValue({ ok: true, sessionState: 'SESSION_STATE_OPEN' });

    const ack = await session.resume('back');
    expect(ack.sessionState).toBe('SESSION_STATE_OPEN');
    expect(spy).toHaveBeenCalledWith(session.sessionId, 'back', expect.objectContaining({ raiseOnNack: true }));
  });
});
