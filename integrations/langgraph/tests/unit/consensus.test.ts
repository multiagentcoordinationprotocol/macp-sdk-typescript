import { afterEach, describe, expect, it, vi } from 'vitest';
import { Auth, commitmentHash } from 'macp-sdk-typescript';
import { ballotFor, normalizeRecommendation, resolveConsensusOptions, runConsensus } from '../../src';
import { fakeClient, fixed } from './helpers';

afterEach(() => vi.restoreAllMocks());

const types = (sent: { messageType: string }[]) => sent.map((s) => s.messageType);

describe('ballot mapping', () => {
  it.each([
    ['approve', 'APPROVE'],
    ['REVIEW', 'ABSTAIN'],
    ['abstain', 'ABSTAIN'],
    ['REJECT', 'REJECT'],
    ['block', 'REJECT'],
  ])('%s → %s', (rec, ballot) => expect(ballotFor(rec)).toBe(ballot));

  it('normalizes ABSTAIN to REVIEW and refuses anything off the wire set', () => {
    expect(normalizeRecommendation('abstain')).toBe('REVIEW');
    expect(normalizeRecommendation('Block')).toBe('BLOCK');
    expect(() => normalizeRecommendation('ACCEPT')).toThrow(/invalid recommendation/);
    expect(() => ballotFor('yes')).toThrow(/invalid recommendation/);
  });
});

describe('option validation', () => {
  const { client } = fakeClient();
  const p = (id: string) => ({ id, evaluator: fixed('APPROVE') });

  it('resolves defaults: decision, strict majority, initiator from the client', () => {
    expect(resolveConsensusOptions({ client, participants: [p('a'), p('b'), p('c'), p('d')] })).toEqual({
      initiator: 'coordinator',
      mode: 'decision',
      threshold: 3,
    });
  });

  it.each([
    ['no participants', { participants: [] }, /at least one participant/],
    ['duplicate ids', { participants: [p('a'), p('a')] }, /unique/],
    ['initiator as participant', { participants: [p('coordinator')] }, /cannot also be a participant/],
    ['threshold 0', { participants: [p('a')], threshold: 0 }, /threshold/],
    ['threshold > n', { participants: [p('a'), p('b')], threshold: 3 }, /threshold/],
    ['fractional threshold', { participants: [p('a'), p('b')], threshold: 1.5 }, /threshold/],
    ['unknown mode', { participants: [p('a')], mode: 'task' }, /unknown consensus mode/],
    ['empty id', { participants: [p('')] }, /non-empty id/],
    ['missing evaluator', { participants: [{ id: 'a' }] }, /evaluator/],
  ])('throws TypeError on %s', (_name, extra, message) => {
    expect(() => resolveConsensusOptions({ client, ...(extra as object) } as never)).toThrow(TypeError);
    expect(() => resolveConsensusOptions({ client, ...(extra as object) } as never)).toThrow(message);
  });

  it('needs an initiator id when the client credential carries none', () => {
    const { client: anon } = fakeClient();
    (anon as { auth?: unknown }).auth = { bearerToken: 't' };
    expect(() => resolveConsensusOptions({ client: anon, participants: [p('a')] })).toThrow(/initiator agent id/);
    expect(resolveConsensusOptions({ client: anon, participants: [p('a')], initiator: 'boss' }).initiator).toBe('boss');
  });
});

describe('decision mode', () => {
  it('evaluates everyone before any vote, then commits once the threshold is met', async () => {
    const { client, sent } = fakeClient();
    const seen: Record<string, unknown>[] = [];
    const result = await runConsensus(
      {
        client,
        participants: [
          { id: 'alice', evaluator: (proposal) => (seen.push(proposal), fixed('APPROVE')()) },
          { id: 'bob', evaluator: fixed('approve', 0.7) },
          { id: 'carol', evaluator: fixed('BLOCK') },
        ],
      },
      { option: 'ship-it', rationale: 'tests pass', details: { build: 42 } },
    );

    expect(types(sent)).toEqual([
      'SessionStart',
      'Proposal',
      'Evaluation',
      'Evaluation',
      'Evaluation',
      'Vote',
      'Vote',
      'Commitment',
    ]);
    expect(sent[0]!.payload.participants).toEqual(['coordinator', 'alice', 'bob', 'carol']);
    expect(sent[1]!.sender).toBe('coordinator');
    expect(JSON.parse(Buffer.from(sent[1]!.payload.supportingData as Uint8Array).toString())).toEqual({ build: 42 });
    expect(sent.slice(2, 5).map((s) => [s.sender, s.payload.recommendation])).toEqual([
      ['alice', 'APPROVE'],
      ['bob', 'APPROVE'],
      ['carol', 'BLOCK'],
    ]);
    expect(seen[0]).toEqual({
      proposalId: 'p1',
      option: 'ship-it',
      rationale: 'tests pass',
      details: { build: 42 },
      mode: 'macp.mode.decision.v1',
    });

    expect(result).toMatchObject({
      outcome: 'approve',
      mode: 'macp.mode.decision.v1',
      approvals: 2,
      threshold: 2,
      ballots: [
        { participant: 'alice', vote: 'APPROVE' },
        { participant: 'bob', vote: 'APPROVE' },
      ],
    });
    expect(result.commitment).toMatchObject({
      action: 'macp.consensus.approved',
      authorityScope: 'macp.consensus',
      reason: '2/3 approvals (threshold 2)',
      outcomePositive: true,
      policyVersion: 'policy.default',
    });
    expect(result.commitmentHash).toBe(commitmentHash(result.commitment));
    expect(result.commitmentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    // The payload in the result is the one on the wire.
    const wire = sent.at(-1)!;
    expect(wire.sender).toBe('coordinator');
    expect(wire.payload).toMatchObject({
      commitmentId: result.commitment.commitmentId,
      action: result.commitment.action,
      reason: result.commitment.reason,
      outcomePositive: true,
    });
  });

  it('commits a rejection as soon as approval is out of reach', async () => {
    const { client, sent } = fakeClient();
    const result = await runConsensus(
      {
        client,
        participants: [
          { id: 'a', evaluator: fixed('REVIEW') },
          { id: 'b', evaluator: fixed('REJECT') },
          { id: 'c', evaluator: fixed('APPROVE') },
        ],
        action: 'deploy',
        policy: 'policy.strict',
      },
      { option: 'deploy' },
    );
    expect(types(sent).filter((t) => t === 'Vote')).toHaveLength(2);
    expect(sent.filter((s) => s.messageType === 'Vote').map((s) => s.payload.vote)).toEqual(['ABSTAIN', 'REJECT']);
    expect(result.outcome).toBe('reject');
    expect(result.commitment).toMatchObject({
      action: 'deploy.rejected',
      reason: '0/3 approvals (threshold 2)',
      outcomePositive: false,
      policyVersion: 'policy.strict',
    });
  });

  it('sends ABSTAIN evaluations as REVIEW and honours a custom voter', async () => {
    const { client, sent } = fakeClient();
    const result = await runConsensus(
      {
        client,
        threshold: 1,
        participants: [
          {
            id: 'a',
            evaluator: fixed('abstain'),
            voter: { shouldVote: () => true, decideVote: async () => ({ vote: 'approve', reason: 'overruled' }) },
          },
        ],
      },
      { option: 'x' },
    );
    expect(sent.find((s) => s.messageType === 'Evaluation')!.payload.recommendation).toBe('REVIEW');
    expect(result.ballots).toEqual([{ participant: 'a', vote: 'APPROVE', reason: 'overruled' }]);
    expect(result.outcome).toBe('approve');
  });

  it('records a declined vote as an abstention without sending one', async () => {
    const { client, sent } = fakeClient();
    const result = await runConsensus(
      {
        client,
        participants: [
          { id: 'a', evaluator: fixed('APPROVE'), voter: { shouldVote: () => false, decideVote: vi.fn() } },
          { id: 'b', evaluator: fixed('APPROVE') },
        ],
        threshold: 2,
      },
      { option: 'x' },
    );
    expect(result.ballots[0]).toEqual({ participant: 'a', vote: 'ABSTAIN', reason: 'declined to vote' });
    expect(result.outcome).toBe('reject');
    expect(types(sent).filter((t) => t === 'Vote')).toHaveLength(0);
  });

  it('accepts an EvaluationStrategy object and per-participant auth', async () => {
    const { client, sent } = fakeClient();
    const send = vi.mocked(client.send);
    await runConsensus(
      {
        client,
        threshold: 1,
        participants: [
          {
            id: 'a',
            auth: Auth.bearer('tok-a', { expectedSender: 'a' }),
            evaluator: { evaluate: async () => fixed('APPROVE')() },
          },
        ],
      },
      { option: 'x' },
    );
    const evalCall = send.mock.calls.find(([env]) => env.messageType === 'Evaluation')!;
    expect(evalCall[1]).toMatchObject({ auth: { bearerToken: 'tok-a' } });
    expect(sent.find((s) => s.messageType === 'Evaluation')!.sender).toBe('a');
  });
});

describe('quorum mode', () => {
  it('keeps the initiator off the roster and maps evaluations to ballots', async () => {
    const { client, sent } = fakeClient();
    const seen: Record<string, unknown>[] = [];
    const result = await runConsensus(
      {
        client,
        mode: 'quorum',
        threshold: 2,
        participants: [
          { id: 'a', evaluator: (proposal) => (seen.push(proposal), fixed('APPROVE')()) },
          { id: 'b', evaluator: fixed('REVIEW') },
          { id: 'c', evaluator: fixed('BLOCK') },
        ],
      },
      { option: 'wire-transfer', rationale: 'pay invoice 17' },
    );
    expect(types(sent)).toEqual(['SessionStart', 'ApprovalRequest', 'Approve', 'Abstain', 'Reject', 'Commitment']);
    expect(sent[0]!.payload.participants).toEqual(['a', 'b', 'c']);
    expect(sent[1]!.payload).toMatchObject({
      requestId: 'r1',
      action: 'wire-transfer',
      summary: 'pay invoice 17',
      requiredApprovals: 2,
    });
    expect(sent[1]!.sender).toBe('coordinator');
    expect(seen[0]).toEqual({
      proposalId: 'r1',
      option: 'wire-transfer',
      rationale: 'pay invoice 17',
      details: null,
      mode: 'macp.mode.quorum.v1',
    });
    expect(result).toMatchObject({ outcome: 'reject', mode: 'macp.mode.quorum.v1', approvals: 1, threshold: 2 });
    expect(result.commitment.reason).toBe('1/3 approvals (threshold 2)');
  });

  it('stops collecting ballots once settled', async () => {
    const { client, sent } = fakeClient();
    const third = vi.fn(fixed('APPROVE'));
    const result = await runConsensus(
      {
        client,
        mode: 'quorum',
        participants: [
          { id: 'a', evaluator: fixed('APPROVE') },
          { id: 'b', evaluator: fixed('APPROVE') },
          { id: 'c', evaluator: third },
        ],
      },
      { option: 'go' },
    );
    expect(third).not.toHaveBeenCalled();
    expect(types(sent)).toEqual(['SessionStart', 'ApprovalRequest', 'Approve', 'Approve', 'Commitment']);
    expect(result.outcome).toBe('approve');
  });
});

describe('failures', () => {
  it('cancels the session and rethrows when an evaluator throws', async () => {
    const { client, cancel } = fakeClient();
    const run = runConsensus(
      {
        client,
        participants: [
          {
            id: 'a',
            evaluator: () => {
              throw new Error('model down');
            },
          },
        ],
      },
      { option: 'x' },
    );
    await expect(run).rejects.toThrow('model down');
    expect(cancel).toHaveBeenCalledWith(expect.any(String), 'consensus failed: model down', expect.anything());
  });

  it('cancels and rethrows when the commitment is refused', async () => {
    const { client, cancel } = fakeClient({ failOn: 'Commitment' });
    await expect(
      runConsensus({ client, participants: [{ id: 'a', evaluator: fixed('APPROVE') }] }, { option: 'x' }),
    ).rejects.toThrow('boom on Commitment');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('keeps the original error when the cancel itself fails', async () => {
    const { client, cancel } = fakeClient({ failOn: 'Proposal' });
    cancel.mockRejectedValue(new Error('cancel failed'));
    await expect(
      runConsensus({ client, participants: [{ id: 'a', evaluator: fixed('APPROVE') }] }, { option: 'x' }),
    ).rejects.toThrow('boom on Proposal');
  });

  it('does not cancel a session that never started', async () => {
    const { client, cancel } = fakeClient({ failOn: 'SessionStart' });
    await expect(
      runConsensus({ client, participants: [{ id: 'a', evaluator: fixed('APPROVE') }] }, { option: 'x' }),
    ).rejects.toThrow('boom on SessionStart');
    expect(cancel).not.toHaveBeenCalled();
  });

  it('refuses an out-of-range confidence and an empty option', async () => {
    const { client } = fakeClient();
    await expect(
      runConsensus({ client, participants: [{ id: 'a', evaluator: fixed('APPROVE', 1.5) }] }, { option: 'x' }),
    ).rejects.toThrow(/confidence/);
    await expect(
      runConsensus({ client, participants: [{ id: 'a', evaluator: fixed('APPROVE') }] }, { option: '' }),
    ).rejects.toThrow(/non-empty option/);
  });
});
