import { afterEach, describe, expect, it, vi } from 'vitest';
import { Auth } from '../../../src/auth';
import { MacpClient } from '../../../src/client';
import { DecisionSession } from '../../../src/decision';
import { MacpAckError, MacpIdentityMismatchError } from '../../../src/errors';
import { MODE_DECISION } from '../../../src/constants';
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

  // Issue #108.3: validateVote/validateRecommendation/validateSeverity each
  // *return* a normalized string, which decision.ts previously discarded —
  // so a lowercase/mixed-case caller input reached the wire un-normalized.
  // These decode the actual encoded envelope payload (not the input object,
  // and not a projection getter — several of those normalize internally
  // regardless, per the plan) to prove the wire value itself is normalized.
  // Fails on old code.
  it("issue #108.3: evaluate({ recommendation: 'review' }) puts REVIEW on the encoded payload", async () => {
    const client = makeClient();
    const session = new DecisionSession(client);
    const sendSpy = vi.spyOn(client, 'send').mockResolvedValue({ ok: true });

    await session.propose({ proposalId: 'p1', option: 'go' });
    await session.evaluate({ proposalId: 'p1', recommendation: 'review', confidence: 0.5 });

    const envelope = sendSpy.mock.calls[1]![0] as Envelope;
    const decoded = client.protoRegistry.decodeKnownPayload(MODE_DECISION, 'Evaluation', envelope.payload);
    expect(decoded).toMatchObject({ recommendation: 'REVIEW' });
  });

  it("issue #108.3: raiseObjection({ severity: 'HIGH' }) puts high on the encoded payload", async () => {
    const client = makeClient();
    const session = new DecisionSession(client);
    const sendSpy = vi.spyOn(client, 'send').mockResolvedValue({ ok: true });

    await session.propose({ proposalId: 'p1', option: 'go' });
    await session.raiseObjection({ proposalId: 'p1', reason: 'unsafe', severity: 'HIGH' });

    const envelope = sendSpy.mock.calls[1]![0] as Envelope;
    const decoded = client.protoRegistry.decodeKnownPayload(MODE_DECISION, 'Objection', envelope.payload);
    expect(decoded).toMatchObject({ severity: 'high' });
  });

  it("issue #108.3: vote({ vote: 'approve' }) puts APPROVE on the encoded payload", async () => {
    const client = makeClient();
    const session = new DecisionSession(client);
    const sendSpy = vi.spyOn(client, 'send').mockResolvedValue({ ok: true });

    await session.propose({ proposalId: 'p1', option: 'go' });
    await session.vote({ proposalId: 'p1', vote: 'approve' });

    const envelope = sendSpy.mock.calls[1]![0] as Envelope;
    const decoded = client.protoRegistry.decodeKnownPayload(MODE_DECISION, 'Vote', envelope.payload);
    expect(decoded).toMatchObject({ vote: 'APPROVE' });
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

  // Issue #108.4/4d: start()'s input type gained an `auth` field so callers can
  // pass a per-call credential distinct from the session/client-level one. Fails
  // on old code: previously start() ignored a per-call `auth` entirely (it only
  // ever called `this.senderFor(input.sender)`), so a conflicting per-call
  // `auth.expectedSender` could never surface a mismatch here.
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
    const session = new DecisionSession(client);
    vi.spyOn(client, 'send').mockResolvedValue({ ok: true });

    await expect(
      session.start({
        intent: 'pick-region',
        participants: ['alice', 'bob'],
        ttlMs: 10_000,
        sender: 'mallory',
        auth: Auth.bearer('tok', { expectedSender: 'alice' }),
      }),
    ).rejects.toBeInstanceOf(MacpIdentityMismatchError);
  });

  it('issue #108.4: start() forwards a per-call auth to client.send', async () => {
    const client = makeClient();
    const session = new DecisionSession(client);
    const sendSpy = vi.spyOn(client, 'send').mockResolvedValue({ ok: true });
    const perCallAuth = Auth.bearer('carol-token', { expectedSender: 'carol' });

    await session.start({
      intent: 'pick-region',
      participants: ['alice', 'bob'],
      ttlMs: 10_000,
      sender: 'carol',
      auth: perCallAuth,
    });

    expect(sendSpy.mock.calls[0]![1]).toMatchObject({ auth: perCallAuth });
  });
});
