import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DecisionProjection } from '../../../src/projections/decision';
import { ProtoRegistry } from '../../../src/proto-registry';
import { buildEnvelope } from '../../../src/envelope';
import { MODE_DECISION } from '../../../src/constants';
import { configureLogging, _resetLoggingForTests } from '../../../src/logging';

const registry = new ProtoRegistry();
const EXPECTED_KIND = 'duplicate_vote';

function makeEnvelope(messageType: string, payload: Record<string, unknown>, sender = 'agent-a') {
  return buildEnvelope({
    mode: MODE_DECISION,
    messageType,
    sessionId: 'test-session',
    sender,
    payload: registry.encodeKnownPayload(MODE_DECISION, messageType, payload),
  });
}

describe('DecisionProjection', () => {
  let projection: DecisionProjection;

  beforeEach(() => {
    projection = new DecisionProjection();
  });

  it('tracks proposals', () => {
    projection.applyEnvelope(
      makeEnvelope('Proposal', { proposalId: 'p1', option: 'deploy-v2', rationale: 'tests pass' }),
      registry,
    );
    expect(projection.proposals.size).toBe(1);
    expect(projection.proposals.get('p1')).toMatchObject({
      proposalId: 'p1',
      option: 'deploy-v2',
      rationale: 'tests pass',
      sender: 'agent-a',
    });
    expect(projection.phase).toBe('Evaluation');
  });

  it('tracks evaluations', () => {
    projection.applyEnvelope(makeEnvelope('Proposal', { proposalId: 'p1', option: 'opt' }), registry);
    projection.applyEnvelope(
      makeEnvelope(
        'Evaluation',
        { proposalId: 'p1', recommendation: 'approve', confidence: 0.9, reason: 'good' },
        'bob',
      ),
      registry,
    );
    expect(projection.evaluations).toHaveLength(1);
    expect(projection.evaluations[0]).toMatchObject({
      proposalId: 'p1',
      recommendation: 'approve',
      sender: 'bob',
    });
  });

  it('tracks objections with severity', () => {
    projection.applyEnvelope(makeEnvelope('Proposal', { proposalId: 'p1', option: 'opt' }), registry);
    projection.applyEnvelope(
      makeEnvelope('Objection', { proposalId: 'p1', reason: 'risky', severity: 'critical' }, 'bob'),
      registry,
    );
    expect(projection.objections).toHaveLength(1);
    expect(projection.objections[0].severity).toBe('critical');
    expect(projection.hasBlockingObjection('p1')).toBe(true);
  });

  it('defaults objection severity to medium', () => {
    projection.applyEnvelope(makeEnvelope('Proposal', { proposalId: 'p1', option: 'opt' }), registry);
    projection.applyEnvelope(makeEnvelope('Objection', { proposalId: 'p1', reason: 'minor issue' }, 'bob'), registry);
    expect(projection.objections[0].severity).toBe('medium');
    expect(projection.hasBlockingObjection('p1')).toBe(false);
  });

  it('tracks votes and computes totals', () => {
    projection.applyEnvelope(makeEnvelope('Proposal', { proposalId: 'p1', option: 'a' }), registry);
    projection.applyEnvelope(makeEnvelope('Proposal', { proposalId: 'p2', option: 'b' }), registry);
    projection.applyEnvelope(makeEnvelope('Vote', { proposalId: 'p1', vote: 'approve' }, 'alice'), registry);
    projection.applyEnvelope(makeEnvelope('Vote', { proposalId: 'p1', vote: 'approve' }, 'bob'), registry);
    projection.applyEnvelope(makeEnvelope('Vote', { proposalId: 'p2', vote: 'approve' }, 'carol'), registry);

    expect(projection.phase).toBe('Voting');
    const totals = projection.voteTotals();
    expect(totals['p1']).toBe(2);
    expect(totals['p2']).toBe(1);
  });

  it('majorityWinner returns proposal with most votes', () => {
    projection.applyEnvelope(makeEnvelope('Proposal', { proposalId: 'p1', option: 'a' }), registry);
    projection.applyEnvelope(makeEnvelope('Proposal', { proposalId: 'p2', option: 'b' }), registry);
    projection.applyEnvelope(makeEnvelope('Vote', { proposalId: 'p1', vote: 'approve' }, 'alice'), registry);
    projection.applyEnvelope(makeEnvelope('Vote', { proposalId: 'p2', vote: 'approve' }, 'bob'), registry);
    projection.applyEnvelope(makeEnvelope('Vote', { proposalId: 'p2', vote: 'approve' }, 'carol'), registry);

    expect(projection.majorityWinner()).toBe('p2');
  });

  it('majorityWinner returns undefined with no votes', () => {
    expect(projection.majorityWinner()).toBeUndefined();
  });

  it('tracks commitment and transitions to Committed phase', () => {
    projection.applyEnvelope(makeEnvelope('Proposal', { proposalId: 'p1', option: 'a' }), registry);
    projection.applyEnvelope(
      makeEnvelope('Commitment', {
        commitmentId: 'c1',
        action: 'deploy',
        authorityScope: 'ops',
        reason: 'approved',
        modeVersion: '1.0.0',
        configurationVersion: 'config.default',
      }),
      registry,
    );
    expect(projection.phase).toBe('Committed');
    expect(projection.commitment).toBeDefined();
  });

  // RFC-MACP-0001 §7.2 (`:216`): RESOLVED is terminal and sessions MUST
  // transition monotonically w.r.t. termination — never back to
  // OPEN/SUSPENDED. A conforming runtime rejects any session-scoped message
  // once the session is non-OPEN (§7.3 `:238`/`:247`), so a `Vote` cannot
  // legally follow a `Commitment` in accepted history — but if a caller
  // violates the accepted-only contract and replays one anyway, `phase`
  // must not regress out of 'Committed'.
  it('does not regress phase out of Committed if a Vote is (illegally) replayed after Commitment', () => {
    projection.applyEnvelope(makeEnvelope('Proposal', { proposalId: 'p1', option: 'a' }), registry);
    projection.applyEnvelope(
      makeEnvelope('Commitment', {
        commitmentId: 'c1',
        action: 'deploy',
        authorityScope: 'ops',
        reason: 'approved',
        modeVersion: '1.0.0',
        configurationVersion: 'config.default',
      }),
      registry,
    );
    expect(projection.phase).toBe('Committed');

    projection.applyEnvelope(makeEnvelope('Vote', { proposalId: 'p1', vote: 'approve' }, 'alice'), registry);

    expect(projection.phase).toBe('Committed');
  });

  // Old (wrong) behaviour: the Vote case set `this.phase = 'Voting'`
  // unconditionally, so a post-Commitment Vote flipped `phase` back out of
  // the terminal state (Phase 3, site 10).
  it('a post-Commitment Vote no longer flips phase back to Voting', () => {
    projection.applyEnvelope(makeEnvelope('Proposal', { proposalId: 'p1', option: 'a' }), registry);
    projection.applyEnvelope(
      makeEnvelope('Commitment', {
        commitmentId: 'c1',
        action: 'deploy',
        authorityScope: 'ops',
        reason: 'approved',
        modeVersion: '1.0.0',
        configurationVersion: 'config.default',
      }),
      registry,
    );
    projection.applyEnvelope(makeEnvelope('Vote', { proposalId: 'p1', vote: 'approve' }, 'alice'), registry);

    expect(projection.phase).not.toBe('Voting');
  });

  it('ignores envelopes for other modes', () => {
    const envelope = buildEnvelope({
      mode: 'macp.mode.proposal.v1',
      messageType: 'Proposal',
      sessionId: 'test-session',
      sender: 'agent-a',
      payload: Buffer.alloc(0),
    });
    projection.applyEnvelope(envelope, registry);
    expect(projection.transcript).toHaveLength(0);
  });

  it('the first accepted vote stands; a second Vote from the same sender is discarded as a duplicate_vote anomaly', () => {
    projection.applyEnvelope(makeEnvelope('Proposal', { proposalId: 'p1', option: 'a' }), registry);
    projection.applyEnvelope(makeEnvelope('Vote', { proposalId: 'p1', vote: 'reject' }, 'alice'), registry);
    const secondVote = makeEnvelope('Vote', { proposalId: 'p1', vote: 'approve' }, 'alice');
    projection.applyEnvelope(secondVote, registry);

    expect(projection.voteTotals()['p1']).toBe(0);
    expect(projection.votes.get('p1')?.size).toBe(1);
    expect(projection.votes.get('p1')?.get('alice')?.vote).toBe('reject');
    expect(projection.anomalies).toHaveLength(1);
    expect(projection.anomalies[0]).toMatchObject({
      kind: EXPECTED_KIND,
      mode: MODE_DECISION,
      messageType: 'Vote',
      messageId: secondVote.messageId,
      sender: 'alice',
      subjectId: 'p1',
    });
    expect(projection.anomalies[0].detail).toContain("'reject'");
    expect(projection.anomalies[0].detail).toContain("'approve'");
  });

  it('order-based, not value-based: whichever Vote arrives first stands', () => {
    projection.applyEnvelope(makeEnvelope('Proposal', { proposalId: 'p1', option: 'a' }), registry);
    projection.applyEnvelope(makeEnvelope('Vote', { proposalId: 'p1', vote: 'approve' }, 'alice'), registry);
    projection.applyEnvelope(makeEnvelope('Vote', { proposalId: 'p1', vote: 'reject' }, 'alice'), registry);

    expect(projection.voteTotals()['p1']).toBe(1);
    expect(projection.votes.get('p1')?.get('alice')?.vote).toBe('approve');
    expect(projection.anomalies).toHaveLength(1);
  });

  it('voteRatio under a duplicate vote records the anomaly but leaves the ratio at its correct conforming value', () => {
    projection.applyEnvelope(makeEnvelope('Proposal', { proposalId: 'p1', option: 'a' }), registry);
    projection.applyEnvelope(makeEnvelope('Vote', { proposalId: 'p1', vote: 'approve' }, 'alice'), registry);
    projection.applyEnvelope(makeEnvelope('Vote', { proposalId: 'p1', vote: 'approve' }, 'alice'), registry);
    projection.applyEnvelope(makeEnvelope('Vote', { proposalId: 'p1', vote: 'reject' }, 'bob'), registry);

    expect(projection.voteRatio('p1')).toBe(0.5);
    expect(projection.anomalies).toHaveLength(1);
  });

  it('majorityWinner under a duplicate vote records the anomaly but leaves the winner at its correct conforming value', () => {
    projection.applyEnvelope(makeEnvelope('Proposal', { proposalId: 'p1', option: 'a' }), registry);
    projection.applyEnvelope(makeEnvelope('Proposal', { proposalId: 'p2', option: 'b' }), registry);
    projection.applyEnvelope(makeEnvelope('Vote', { proposalId: 'p1', vote: 'approve' }, 'alice'), registry);
    // Duplicate: alice's second vote on p1 must not inflate p1's count or the
    // non-abstain denominator.
    projection.applyEnvelope(makeEnvelope('Vote', { proposalId: 'p1', vote: 'approve' }, 'alice'), registry);
    projection.applyEnvelope(makeEnvelope('Vote', { proposalId: 'p2', vote: 'approve' }, 'bob'), registry);
    projection.applyEnvelope(makeEnvelope('Vote', { proposalId: 'p2', vote: 'approve' }, 'carol'), registry);

    expect(projection.majorityWinner()).toBe('p2');
    expect(projection.anomalies).toHaveLength(1);
  });

  it('scopes duplicate detection per proposal_id: the same sender voting once on two proposals records nothing', () => {
    projection.applyEnvelope(makeEnvelope('Proposal', { proposalId: 'p1', option: 'a' }), registry);
    projection.applyEnvelope(makeEnvelope('Proposal', { proposalId: 'p2', option: 'b' }), registry);
    projection.applyEnvelope(makeEnvelope('Vote', { proposalId: 'p1', vote: 'approve' }, 'alice'), registry);
    projection.applyEnvelope(makeEnvelope('Vote', { proposalId: 'p2', vote: 'reject' }, 'alice'), registry);

    expect(projection.voteTotals()['p1']).toBe(1);
    expect(projection.voteTotals()['p2']).toBe(0);
    expect(projection.votes.get('p1')?.get('alice')?.vote).toBe('approve');
    expect(projection.votes.get('p2')?.get('alice')?.vote).toBe('reject');
    expect(projection.anomalies).toHaveLength(0);
  });

  it('the discarded duplicate still enters the transcript (distinct envelope, not a redelivery)', () => {
    projection.applyEnvelope(makeEnvelope('Proposal', { proposalId: 'p1', option: 'a' }), registry);
    projection.applyEnvelope(makeEnvelope('Vote', { proposalId: 'p1', vote: 'reject' }, 'alice'), registry);
    projection.applyEnvelope(makeEnvelope('Vote', { proposalId: 'p1', vote: 'approve' }, 'alice'), registry);

    expect(projection.transcript).toHaveLength(3);
  });

  it('a duplicate vote arriving after Commitment leaves phase Committed, not Voting', () => {
    projection.applyEnvelope(makeEnvelope('Proposal', { proposalId: 'p1', option: 'a' }), registry);
    projection.applyEnvelope(makeEnvelope('Vote', { proposalId: 'p1', vote: 'approve' }, 'alice'), registry);
    projection.applyEnvelope(
      makeEnvelope('Commitment', {
        commitmentId: 'c1',
        action: 'deploy',
        authorityScope: 'ops',
        reason: 'approved',
        modeVersion: '1.0.0',
        configurationVersion: 'config.default',
      }),
      registry,
    );
    expect(projection.phase).toBe('Committed');

    projection.applyEnvelope(makeEnvelope('Vote', { proposalId: 'p1', vote: 'reject' }, 'alice'), registry);

    expect(projection.phase).toBe('Committed');
    expect(projection.anomalies).toHaveLength(1);
  });

  describe('duplicate_vote anomaly logging', () => {
    afterEach(() => {
      _resetLoggingForTests();
    });

    it('emits logger.warn exactly once for a genuine duplicate vote', () => {
      const calls: unknown[][] = [];
      configureLogging({ sink: (level, args) => calls.push([level, ...args]) });

      projection.applyEnvelope(makeEnvelope('Proposal', { proposalId: 'p1', option: 'a' }), registry);
      projection.applyEnvelope(makeEnvelope('Vote', { proposalId: 'p1', vote: 'reject' }, 'alice'), registry);
      projection.applyEnvelope(makeEnvelope('Vote', { proposalId: 'p1', vote: 'approve' }, 'alice'), registry);

      const warnCalls = calls.filter(([level]) => level === 'warn');
      expect(warnCalls).toHaveLength(1);
    });

    it('a conforming three-sender transcript records zero anomalies and zero sink calls', () => {
      const calls: unknown[][] = [];
      configureLogging({ sink: (level, args) => calls.push([level, ...args]) });

      projection.applyEnvelope(makeEnvelope('Proposal', { proposalId: 'p1', option: 'a' }), registry);
      projection.applyEnvelope(makeEnvelope('Vote', { proposalId: 'p1', vote: 'approve' }, 'alice'), registry);
      projection.applyEnvelope(makeEnvelope('Vote', { proposalId: 'p1', vote: 'reject' }, 'bob'), registry);
      projection.applyEnvelope(makeEnvelope('Vote', { proposalId: 'p1', vote: 'abstain' }, 'carol'), registry);

      expect(projection.anomalies).toHaveLength(0);
      expect(calls).toHaveLength(0);
    });
  });

  describe('the reachability pair (redelivery vs. genuine duplicate)', () => {
    afterEach(() => {
      _resetLoggingForTests();
    });

    it('a redelivered Vote (same sender, same proposal_id, SAME messageId) records ZERO anomalies and leaves the tally unchanged', () => {
      const calls: unknown[][] = [];
      configureLogging({ sink: (level, args) => calls.push([level, ...args]) });

      projection.applyEnvelope(makeEnvelope('Proposal', { proposalId: 'p1', option: 'a' }), registry);
      const vote = makeEnvelope('Vote', { proposalId: 'p1', vote: 'approve' }, 'alice');
      projection.applyEnvelope(vote, registry);
      // Redelivery: the identical envelope (same messageId) arrives again, e.g.
      // via the shared-projection-instance echo path.
      projection.applyEnvelope(vote, registry);

      expect(projection.anomalies).toHaveLength(0);
      expect(projection.voteTotals()['p1']).toBe(1);
      expect(projection.votes.get('p1')?.size).toBe(1);
      // The redelivery guard returns before the switch, so no 'projection
      // anomaly' warn is ever reached on a redelivery — assert it anyway,
      // since this is the property that would break if the guard moved.
      const anomalyWarnCalls = calls.filter(([level, message]) => level === 'warn' && message === 'projection anomaly');
      expect(anomalyWarnCalls).toHaveLength(0);
    });

    it('a genuine duplicate Vote (same sender, same proposal_id, DIFFERENT messageId) records EXACTLY ONE anomaly', () => {
      projection.applyEnvelope(makeEnvelope('Proposal', { proposalId: 'p1', option: 'a' }), registry);
      const firstVote = buildEnvelope({
        mode: MODE_DECISION,
        messageType: 'Vote',
        sessionId: 'test-session',
        sender: 'alice',
        messageId: 'vote-1',
        payload: registry.encodeKnownPayload(MODE_DECISION, 'Vote', { proposalId: 'p1', vote: 'approve' }),
      });
      const secondVote = buildEnvelope({
        mode: MODE_DECISION,
        messageType: 'Vote',
        sessionId: 'test-session',
        sender: 'alice',
        messageId: 'vote-2',
        payload: registry.encodeKnownPayload(MODE_DECISION, 'Vote', { proposalId: 'p1', vote: 'reject' }),
      });
      projection.applyEnvelope(firstVote, registry);
      projection.applyEnvelope(secondVote, registry);

      expect(projection.anomalies).toHaveLength(1);
      expect(projection.anomalies[0].kind).toBe(EXPECTED_KIND);
      expect(projection.voteTotals()['p1']).toBe(1);
      expect(projection.votes.get('p1')?.size).toBe(1);
    });
  });

  it('hasBlockingObjection only counts critical severity', () => {
    projection.applyEnvelope(makeEnvelope('Proposal', { proposalId: 'p1', option: 'opt' }), registry);
    projection.applyEnvelope(
      makeEnvelope('Objection', { proposalId: 'p1', reason: 'high concern', severity: 'high' }, 'bob'),
      registry,
    );
    expect(projection.hasBlockingObjection('p1')).toBe(false);

    projection.applyEnvelope(
      makeEnvelope('Objection', { proposalId: 'p1', reason: 'critical issue', severity: 'critical' }, 'carol'),
      registry,
    );
    expect(projection.hasBlockingObjection('p1')).toBe(true);
  });

  it('voteRatio excludes ABSTAIN from denominator', () => {
    projection.applyEnvelope(makeEnvelope('Proposal', { proposalId: 'p1', option: 'a' }), registry);
    projection.applyEnvelope(makeEnvelope('Vote', { proposalId: 'p1', vote: 'APPROVE' }, 'alice'), registry);
    projection.applyEnvelope(makeEnvelope('Vote', { proposalId: 'p1', vote: 'REJECT' }, 'bob'), registry);
    projection.applyEnvelope(makeEnvelope('Vote', { proposalId: 'p1', vote: 'ABSTAIN' }, 'carol'), registry);

    // 1 approve / 2 non-abstain = 0.5
    expect(projection.voteRatio('p1')).toBe(0.5);
  });

  it('voteRatio returns 0 when all abstain', () => {
    projection.applyEnvelope(makeEnvelope('Proposal', { proposalId: 'p1', option: 'a' }), registry);
    projection.applyEnvelope(makeEnvelope('Vote', { proposalId: 'p1', vote: 'ABSTAIN' }, 'alice'), registry);
    expect(projection.voteRatio('p1')).toBe(0);
  });

  it('reviewEvaluations filters REVIEW recommendations', () => {
    projection.applyEnvelope(makeEnvelope('Proposal', { proposalId: 'p1', option: 'opt' }), registry);
    projection.applyEnvelope(
      makeEnvelope('Evaluation', { proposalId: 'p1', recommendation: 'REVIEW', confidence: 0.5 }, 'alice'),
      registry,
    );
    projection.applyEnvelope(
      makeEnvelope('Evaluation', { proposalId: 'p1', recommendation: 'APPROVE', confidence: 0.9 }, 'bob'),
      registry,
    );

    expect(projection.reviewEvaluations()).toHaveLength(1);
    expect(projection.qualifyingEvaluations()).toHaveLength(1);
    expect(projection.qualifyingEvaluations()[0].sender).toBe('bob');
  });

  it('accepts UPPERCASE vote values', () => {
    projection.applyEnvelope(makeEnvelope('Proposal', { proposalId: 'p1', option: 'a' }), registry);
    projection.applyEnvelope(makeEnvelope('Vote', { proposalId: 'p1', vote: 'APPROVE' }, 'alice'), registry);

    const totals = projection.voteTotals();
    expect(totals['p1']).toBe(1);
  });

  // Negative (decline) committed outcomes. A Decision reject-majority resolved
  // under a bound policy carries a Commitment with `outcome_positive: false`.
  // proto3 does not put a default-valued bool on the wire, so the decoder
  // (`ProtoRegistry.decodeMessage`) materializes absent bools back to `false` —
  // mirroring Python protobuf, where a schema bool is always present. These lock
  // in that a negative outcome is never silently read as positive.
  it('projects an explicit negative Commitment (outcome_positive: false) as a negative outcome', () => {
    projection.applyEnvelope(
      makeEnvelope('Commitment', {
        commitmentId: 'c1',
        action: 'decision.declined',
        authorityScope: 'test',
        reason: 'reject majority',
        outcomePositive: false, // explicit false — must survive encode->decode
        modeVersion: '1.0.0',
        policyVersion: '',
        configurationVersion: 'cfg-1',
      }),
      registry,
    );

    expect(projection.isCommitted).toBe(true);
    expect(projection.commitment?.outcomePositive).toBe(false); // not undefined
    expect(projection.isPositiveOutcome).toBe(false); // not defaulted to true
  });

  it('projects an explicit positive Commitment (outcome_positive: true) as a positive outcome', () => {
    projection.applyEnvelope(
      makeEnvelope('Commitment', {
        commitmentId: 'c1',
        action: 'decision.approved',
        authorityScope: 'test',
        reason: 'approve majority',
        outcomePositive: true,
        modeVersion: '1.0.0',
        configurationVersion: 'cfg-1',
      }),
      registry,
    );

    expect(projection.commitment?.outcomePositive).toBe(true);
    expect(projection.isPositiveOutcome).toBe(true);
  });

  it('materializes an omitted outcome_positive to false (proto3 default, matches Python)', () => {
    projection.applyEnvelope(
      makeEnvelope('Commitment', {
        commitmentId: 'c1',
        action: 'decision.rejected',
        authorityScope: 'test',
        reason: 'no explicit outcome_positive set',
        modeVersion: '1.0.0',
        configurationVersion: 'cfg-1',
      }),
      registry,
    );

    // proto3 omits a default bool on the wire; the decoder restores it to false
    // (the field exists in the schema) rather than leaving it undefined, so
    // isPositiveOutcome reflects the real proto default instead of guessing true.
    expect(projection.commitment?.outcomePositive).toBe(false);
    expect(projection.isPositiveOutcome).toBe(false);
  });
});
