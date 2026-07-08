import { afterEach, describe, expect, it, vi } from 'vitest';
import { Auth } from '../../../src/auth';
import { MacpClient } from '../../../src/client';
import { DecisionSession } from '../../../src/decision';
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

describe('DecisionSession — projection roundtrip', () => {
  it('start() appends a SessionStart envelope to the projection transcript on ack.ok=true', async () => {
    const client = makeClient();
    const session = new DecisionSession(client);
    vi.spyOn(client, 'send').mockResolvedValue({ ok: true });

    const before = session.projection.transcript.length;
    await session.start({ intent: 'pick-region', participants: ['alice', 'bob'], ttlMs: 10_000 });
    expect(session.projection.transcript.length).toBe(before + 1);
  });

  it('propose() records the proposal when ack.ok=true', async () => {
    const client = makeClient();
    const session = new DecisionSession(client);
    vi.spyOn(client, 'send').mockResolvedValue({ ok: true });

    await session.propose({ proposalId: 'p1', option: 'go' });
    expect(session.projection.proposals.has('p1')).toBe(true);
    expect(session.projection.proposals.get('p1')?.option).toBe('go');
  });

  it('does NOT apply to projection when client.send throws MacpAckError', async () => {
    const client = makeClient();
    const session = new DecisionSession(client);
    vi.spyOn(client, 'send').mockRejectedValue(
      new MacpAckError({ ok: false, error: { code: 'POLICY_DENIED', message: 'no' } }),
    );

    await expect(session.propose({ proposalId: 'p1', option: 'go' })).rejects.toBeInstanceOf(MacpAckError);
    expect(session.projection.proposals.has('p1')).toBe(false);
    expect(session.projection.transcript.length).toBe(0);
  });

  it('evaluate() records evaluation keyed by proposalId', async () => {
    const client = makeClient();
    const session = new DecisionSession(client);
    vi.spyOn(client, 'send').mockResolvedValue({ ok: true });

    await session.propose({ proposalId: 'p1', option: 'go' });
    await session.evaluate({ proposalId: 'p1', recommendation: 'APPROVE', confidence: 0.9 });
    expect(session.projection.evaluations).toHaveLength(1);
    expect(session.projection.evaluations[0].proposalId).toBe('p1');
  });

  it('raiseObjection() appends to objections', async () => {
    const client = makeClient();
    const session = new DecisionSession(client);
    vi.spyOn(client, 'send').mockResolvedValue({ ok: true });

    await session.propose({ proposalId: 'p1', option: 'go' });
    await session.raiseObjection({ proposalId: 'p1', reason: 'unsafe', severity: 'critical' });
    expect(session.projection.objections).toHaveLength(1);
    expect(session.projection.hasBlockingObjection('p1')).toBe(true);
  });

  it('vote() updates voteTotals after a proposal', async () => {
    const client = makeClient();
    const session = new DecisionSession(client);
    vi.spyOn(client, 'send').mockResolvedValue({ ok: true });

    await session.propose({ proposalId: 'p1', option: 'go' });
    await session.vote({ proposalId: 'p1', vote: 'approve' });
    expect(session.projection.voteTotals()).toEqual({ p1: 1 });
  });

  it('commit() flips projection.isCommitted on ack.ok=true', async () => {
    const client = makeClient();
    const session = new DecisionSession(client);
    vi.spyOn(client, 'send').mockResolvedValue({ ok: true });

    expect(session.projection.isCommitted).toBe(false);
    await session.commit({ action: 'deploy', authorityScope: 'prod', reason: 'majority' });
    expect(session.projection.isCommitted).toBe(true);
    expect(session.projection.phase).toBe('Committed');
  });

  it('suspend() delegates to client.suspendSession with the session id', async () => {
    const client = makeClient();
    const session = new DecisionSession(client);
    const spy = vi
      .spyOn(client, 'suspendSession')
      .mockResolvedValue({ ok: true, sessionState: 'SESSION_STATE_SUSPENDED' });

    const ack = await session.suspend('pausing');
    expect(ack.sessionState).toBe('SESSION_STATE_SUSPENDED');
    expect(spy).toHaveBeenCalledWith(session.sessionId, 'pausing', expect.objectContaining({ raiseOnNack: true }));
  });

  it('resume() delegates to client.resumeSession with the session id', async () => {
    const client = makeClient();
    const session = new DecisionSession(client);
    const spy = vi.spyOn(client, 'resumeSession').mockResolvedValue({ ok: true, sessionState: 'SESSION_STATE_OPEN' });

    const ack = await session.resume('back');
    expect(ack.sessionState).toBe('SESSION_STATE_OPEN');
    expect(spy).toHaveBeenCalledWith(session.sessionId, 'back', expect.objectContaining({ raiseOnNack: true }));
  });

  it('cancel() delegates to client.cancelSession with the session id', async () => {
    const client = makeClient();
    const session = new DecisionSession(client);
    const spy = vi
      .spyOn(client, 'cancelSession')
      .mockResolvedValue({ ok: true, sessionState: 'SESSION_STATE_CANCELLED' });

    const ack = await session.cancel('done');
    expect(ack.sessionState).toBe('SESSION_STATE_CANCELLED');
    expect(spy).toHaveBeenCalledWith(session.sessionId, 'done', expect.objectContaining({ raiseOnNack: true }));
  });

  it('a resolved NACK is returned but not applied to the projection', async () => {
    const client = makeClient();
    const session = new DecisionSession(client);
    vi.spyOn(client, 'send').mockResolvedValue({ ok: false, error: { code: 'POLICY_DENIED', message: 'no' } });

    const ack = await session.propose({ proposalId: 'p1', option: 'go' });
    expect(ack.ok).toBe(false);
    expect(session.projection.proposals.has('p1')).toBe(false);
    expect(session.projection.transcript).toHaveLength(0);
  });
});
