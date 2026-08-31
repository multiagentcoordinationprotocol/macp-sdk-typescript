import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { QuorumProjection } from '../../../src/projections/quorum';
import { ProtoRegistry } from '../../../src/proto-registry';
import { buildEnvelope } from '../../../src/envelope';
import { MODE_QUORUM } from '../../../src/constants';
import { configureLogging, _resetLoggingForTests } from '../../../src/logging';

const registry = new ProtoRegistry();
const EXPECTED_KIND = 'duplicate_ballot';

function makeEnvelope(messageType: string, payload: Record<string, unknown>, sender = 'coordinator') {
  return buildEnvelope({
    mode: MODE_QUORUM,
    messageType,
    sessionId: 'test-session',
    sender,
    payload: registry.encodeKnownPayload(MODE_QUORUM, messageType, payload),
  });
}

describe('QuorumProjection', () => {
  let projection: QuorumProjection;

  beforeEach(() => {
    projection = new QuorumProjection();
  });

  it('tracks approval requests', () => {
    projection.applyEnvelope(
      makeEnvelope('ApprovalRequest', {
        requestId: 'r1',
        action: 'deploy',
        summary: 'deploy v2',
        requiredApprovals: 2,
      }),
      registry,
    );
    expect(projection.requests.size).toBe(1);
    expect(projection.threshold('r1')).toBe(2);
    expect(projection.phase).toBe('Voting');
  });

  it('tracks approvals', () => {
    projection.applyEnvelope(
      makeEnvelope('ApprovalRequest', { requestId: 'r1', action: 'x', summary: 'y', requiredApprovals: 2 }),
      registry,
    );
    projection.applyEnvelope(makeEnvelope('Approve', { requestId: 'r1', reason: 'ok' }, 'alice'), registry);
    projection.applyEnvelope(makeEnvelope('Approve', { requestId: 'r1', reason: 'fine' }, 'bob'), registry);

    expect(projection.approvalCount('r1')).toBe(2);
    expect(projection.hasQuorum('r1')).toBe(true);
  });

  it('tracks rejections', () => {
    projection.applyEnvelope(
      makeEnvelope('ApprovalRequest', { requestId: 'r1', action: 'x', summary: 'y', requiredApprovals: 2 }),
      registry,
    );
    projection.applyEnvelope(makeEnvelope('Reject', { requestId: 'r1', reason: 'no' }, 'alice'), registry);

    expect(projection.rejectionCount('r1')).toBe(1);
    expect(projection.hasQuorum('r1')).toBe(false);
  });

  it('tracks abstentions', () => {
    projection.applyEnvelope(
      makeEnvelope('ApprovalRequest', { requestId: 'r1', action: 'x', summary: 'y', requiredApprovals: 1 }),
      registry,
    );
    projection.applyEnvelope(makeEnvelope('Abstain', { requestId: 'r1' }, 'alice'), registry);

    expect(projection.abstentionCount('r1')).toBe(1);
  });

  it('remainingVotesNeeded computes correctly', () => {
    projection.applyEnvelope(
      makeEnvelope('ApprovalRequest', { requestId: 'r1', action: 'x', summary: 'y', requiredApprovals: 3 }),
      registry,
    );
    projection.applyEnvelope(makeEnvelope('Approve', { requestId: 'r1' }, 'alice'), registry);

    expect(projection.remainingVotesNeeded('r1')).toBe(2);

    projection.applyEnvelope(makeEnvelope('Approve', { requestId: 'r1' }, 'bob'), registry);
    expect(projection.remainingVotesNeeded('r1')).toBe(1);

    projection.applyEnvelope(makeEnvelope('Approve', { requestId: 'r1' }, 'carol'), registry);
    expect(projection.remainingVotesNeeded('r1')).toBe(0);
    expect(projection.hasQuorum('r1')).toBe(true);
  });

  it('votedSenders tracks who voted', () => {
    projection.applyEnvelope(
      makeEnvelope('ApprovalRequest', { requestId: 'r1', action: 'x', summary: 'y', requiredApprovals: 2 }),
      registry,
    );
    projection.applyEnvelope(makeEnvelope('Approve', { requestId: 'r1' }, 'alice'), registry);
    projection.applyEnvelope(makeEnvelope('Reject', { requestId: 'r1' }, 'bob'), registry);

    expect(projection.votedSenders('r1').sort()).toEqual(['alice', 'bob']);
  });

  it('the first accepted ballot stands; a second ballot from the same sender is discarded as a duplicate_ballot anomaly', () => {
    projection.applyEnvelope(
      makeEnvelope('ApprovalRequest', { requestId: 'r1', action: 'x', summary: 'y', requiredApprovals: 1 }),
      registry,
    );
    projection.applyEnvelope(makeEnvelope('Reject', { requestId: 'r1' }, 'alice'), registry);
    const secondBallot = makeEnvelope('Approve', { requestId: 'r1' }, 'alice');
    projection.applyEnvelope(secondBallot, registry);

    expect(projection.rejectionCount('r1')).toBe(1);
    expect(projection.approvalCount('r1')).toBe(0);
    expect(projection.hasQuorum('r1')).toBe(false);
    expect(projection.anomalies).toHaveLength(1);
    expect(projection.anomalies[0]).toMatchObject({
      kind: EXPECTED_KIND,
      mode: MODE_QUORUM,
      messageType: 'Approve',
      messageId: secondBallot.messageId,
      sender: 'alice',
      subjectId: 'r1',
    });
    expect(projection.anomalies[0].detail).toContain("'reject'");
    expect(projection.anomalies[0].detail).toContain("'approve'");
  });

  it('is order-based, not value-based: Approve-then-Reject keeps the Approve and discards the Reject', () => {
    projection.applyEnvelope(
      makeEnvelope('ApprovalRequest', { requestId: 'r1', action: 'x', summary: 'y', requiredApprovals: 1 }),
      registry,
    );
    projection.applyEnvelope(makeEnvelope('Approve', { requestId: 'r1' }, 'alice'), registry);
    projection.applyEnvelope(makeEnvelope('Reject', { requestId: 'r1' }, 'alice'), registry);

    expect(projection.approvalCount('r1')).toBe(1);
    expect(projection.rejectionCount('r1')).toBe(0);
    expect(projection.hasQuorum('r1')).toBe(true);
    expect(projection.anomalies).toHaveLength(1);
    expect(projection.anomalies[0].kind).toBe(EXPECTED_KIND);
    expect(projection.anomalies[0].messageType).toBe('Reject');
  });

  describe.each([
    { firstType: 'Approve', firstVote: 'approve', secondType: 'Reject' },
    { firstType: 'Approve', firstVote: 'approve', secondType: 'Abstain' },
    { firstType: 'Reject', firstVote: 'reject', secondType: 'Approve' },
    { firstType: 'Reject', firstVote: 'reject', secondType: 'Abstain' },
    { firstType: 'Abstain', firstVote: 'abstain', secondType: 'Approve' },
    { firstType: 'Abstain', firstVote: 'abstain', secondType: 'Reject' },
  ] as const)('cross-type duplicate: $firstType then $secondType', ({ firstType, firstVote, secondType }) => {
    it(`keeps the first (${firstType}) ballot and records exactly one duplicate_ballot anomaly`, () => {
      projection.applyEnvelope(
        makeEnvelope('ApprovalRequest', { requestId: 'r1', action: 'x', summary: 'y', requiredApprovals: 1 }),
        registry,
      );
      projection.applyEnvelope(makeEnvelope(firstType, { requestId: 'r1' }, 'alice'), registry);
      projection.applyEnvelope(makeEnvelope(secondType, { requestId: 'r1' }, 'alice'), registry);

      expect(projection.ballots.get('r1')?.get('alice')?.vote).toBe(firstVote);
      expect(projection.anomalies).toHaveLength(1);
      expect(projection.anomalies[0].kind).toBe(EXPECTED_KIND);
      expect(projection.anomalies[0].messageType).toBe(secondType);
    });
  });

  it('same-type duplicate: Approve then Approve, same sender, same requestId, keeps the first ballot (first reason survives)', () => {
    projection.applyEnvelope(
      makeEnvelope('ApprovalRequest', { requestId: 'r1', action: 'x', summary: 'y', requiredApprovals: 1 }),
      registry,
    );
    const firstBallot = buildEnvelope({
      mode: MODE_QUORUM,
      messageType: 'Approve',
      sessionId: 'test-session',
      sender: 'alice',
      messageId: 'ballot-1',
      payload: registry.encodeKnownPayload(MODE_QUORUM, 'Approve', { requestId: 'r1', reason: 'first-reason' }),
    });
    const secondBallot = buildEnvelope({
      mode: MODE_QUORUM,
      messageType: 'Approve',
      sessionId: 'test-session',
      sender: 'alice',
      messageId: 'ballot-2',
      payload: registry.encodeKnownPayload(MODE_QUORUM, 'Approve', { requestId: 'r1', reason: 'second-reason' }),
    });
    projection.applyEnvelope(firstBallot, registry);
    projection.applyEnvelope(secondBallot, registry);

    expect(projection.anomalies).toHaveLength(1);
    expect(projection.anomalies[0].kind).toBe(EXPECTED_KIND);
    expect(projection.anomalies[0].messageType).toBe('Approve');
    expect(projection.approvalCount('r1')).toBe(1);
    // The first ballot's reason must survive — this is what distinguishes
    // "guard keyed on sender alone" from "guard keyed on sender + vote":
    // both key the second Approve as a duplicate of the first, but only the
    // former also catches cross-type duplicates.
    expect(projection.ballots.get('r1')?.get('alice')?.reason).toBe('first-reason');
  });

  it('remainingVotesNeeded reflects first-wins under a duplicate: required 1, Reject then Approve leaves it at 1 (would be 0 under last-wins)', () => {
    projection.applyEnvelope(
      makeEnvelope('ApprovalRequest', { requestId: 'r1', action: 'x', summary: 'y', requiredApprovals: 1 }),
      registry,
    );
    projection.applyEnvelope(makeEnvelope('Reject', { requestId: 'r1' }, 'alice'), registry);
    projection.applyEnvelope(makeEnvelope('Approve', { requestId: 'r1' }, 'alice'), registry);

    expect(projection.remainingVotesNeeded('r1')).toBe(1);
  });

  it('a duplicate ballot arriving after Commitment leaves phase Committed, not Voting', () => {
    projection.applyEnvelope(
      makeEnvelope('ApprovalRequest', { requestId: 'r1', action: 'x', summary: 'y', requiredApprovals: 1 }),
      registry,
    );
    projection.applyEnvelope(makeEnvelope('Approve', { requestId: 'r1' }, 'alice'), registry);
    projection.applyEnvelope(
      makeEnvelope('Commitment', {
        commitmentId: 'c1',
        action: 'quorum.approved',
        authorityScope: 'team',
        reason: 'approved',
        modeVersion: '1.0.0',
        configurationVersion: 'config.default',
      }),
      registry,
    );
    expect(projection.phase).toBe('Committed');

    projection.applyEnvelope(makeEnvelope('Reject', { requestId: 'r1' }, 'alice'), registry);

    expect(projection.phase).toBe('Committed');
    expect(projection.anomalies).toHaveLength(1);
  });

  it('votedSenders returns exactly the one sender whose first ballot was kept', () => {
    projection.applyEnvelope(
      makeEnvelope('ApprovalRequest', { requestId: 'r1', action: 'x', summary: 'y', requiredApprovals: 1 }),
      registry,
    );
    projection.applyEnvelope(makeEnvelope('Reject', { requestId: 'r1' }, 'alice'), registry);
    projection.applyEnvelope(makeEnvelope('Approve', { requestId: 'r1' }, 'alice'), registry);

    expect(projection.votedSenders('r1')).toEqual(['alice']);
    expect(projection.votedSenders('r1')).toHaveLength(1);
  });

  it('commitmentReady is false under a duplicate ballot where the retired test made it true', () => {
    projection.applyEnvelope(
      makeEnvelope('ApprovalRequest', { requestId: 'r1', action: 'x', summary: 'y', requiredApprovals: 1 }),
      registry,
    );
    projection.applyEnvelope(makeEnvelope('Reject', { requestId: 'r1' }, 'alice'), registry);
    projection.applyEnvelope(makeEnvelope('Approve', { requestId: 'r1' }, 'alice'), registry);

    expect(projection.commitmentReady('r1')).toBe(false);
  });

  it('isThresholdUnreachable accounts for a duplicate ballot correctly (does not fabricate an extra voter)', () => {
    projection.applyEnvelope(
      makeEnvelope('ApprovalRequest', { requestId: 'r1', action: 'x', summary: 'y', requiredApprovals: 3 }),
      registry,
    );
    projection.applyEnvelope(makeEnvelope('Approve', { requestId: 'r1' }, 'alice'), registry);
    // Duplicate: alice's second ballot on r1 is discarded, so it must not
    // double-count her as a second voter, nor flip her kept approval to a
    // rejection.
    projection.applyEnvelope(makeEnvelope('Reject', { requestId: 'r1' }, 'alice'), registry);

    // Only alice has voted (once, approve kept); with totalEligible 3, two
    // more could still approve, so the threshold of 3 remains reachable.
    expect(projection.votedSenders('r1')).toHaveLength(1);
    expect(projection.approvalCount('r1')).toBe(1);
    expect(projection.isThresholdUnreachable('r1', 3)).toBe(false);
  });

  it('the discarded duplicate ballot still enters the transcript (distinct envelope, not a redelivery)', () => {
    projection.applyEnvelope(
      makeEnvelope('ApprovalRequest', { requestId: 'r1', action: 'x', summary: 'y', requiredApprovals: 1 }),
      registry,
    );
    projection.applyEnvelope(makeEnvelope('Reject', { requestId: 'r1' }, 'alice'), registry);
    projection.applyEnvelope(makeEnvelope('Approve', { requestId: 'r1' }, 'alice'), registry);

    expect(projection.transcript).toHaveLength(3);
  });

  it('scopes duplicate detection per request_id: the same sender casting one ballot on two requests records nothing', () => {
    projection.applyEnvelope(
      makeEnvelope('ApprovalRequest', { requestId: 'r1', action: 'x', summary: 'y', requiredApprovals: 1 }),
      registry,
    );
    projection.applyEnvelope(
      makeEnvelope('ApprovalRequest', { requestId: 'r2', action: 'x', summary: 'y', requiredApprovals: 1 }),
      registry,
    );
    projection.applyEnvelope(makeEnvelope('Approve', { requestId: 'r1' }, 'alice'), registry);
    projection.applyEnvelope(makeEnvelope('Reject', { requestId: 'r2' }, 'alice'), registry);

    expect(projection.approvalCount('r1')).toBe(1);
    expect(projection.rejectionCount('r2')).toBe(1);
    expect(projection.anomalies).toHaveLength(0);
  });

  describe('duplicate_ballot anomaly logging', () => {
    afterEach(() => {
      _resetLoggingForTests();
    });

    it('emits logger.warn exactly once for a genuine duplicate ballot', () => {
      const calls: unknown[][] = [];
      configureLogging({ sink: (level, args) => calls.push([level, ...args]) });

      projection.applyEnvelope(
        makeEnvelope('ApprovalRequest', { requestId: 'r1', action: 'x', summary: 'y', requiredApprovals: 1 }),
        registry,
      );
      projection.applyEnvelope(makeEnvelope('Reject', { requestId: 'r1' }, 'alice'), registry);
      projection.applyEnvelope(makeEnvelope('Approve', { requestId: 'r1' }, 'alice'), registry);

      const warnCalls = calls.filter(([level]) => level === 'warn');
      expect(warnCalls).toHaveLength(1);
    });

    it('a conforming three-sender transcript records zero anomalies and zero sink calls', () => {
      const calls: unknown[][] = [];
      configureLogging({ sink: (level, args) => calls.push([level, ...args]) });

      projection.applyEnvelope(
        makeEnvelope('ApprovalRequest', { requestId: 'r1', action: 'x', summary: 'y', requiredApprovals: 2 }),
        registry,
      );
      projection.applyEnvelope(makeEnvelope('Approve', { requestId: 'r1' }, 'alice'), registry);
      projection.applyEnvelope(makeEnvelope('Reject', { requestId: 'r1' }, 'bob'), registry);
      projection.applyEnvelope(makeEnvelope('Abstain', { requestId: 'r1' }, 'carol'), registry);

      expect(projection.anomalies).toHaveLength(0);
      expect(calls).toHaveLength(0);
    });
  });

  describe('the reachability pair (redelivery vs. genuine duplicate)', () => {
    afterEach(() => {
      _resetLoggingForTests();
    });

    it('a redelivered ballot (same sender, same request_id, SAME messageId) records ZERO anomalies and leaves counts unchanged', () => {
      const calls: unknown[][] = [];
      configureLogging({ sink: (level, args) => calls.push([level, ...args]) });

      projection.applyEnvelope(
        makeEnvelope('ApprovalRequest', { requestId: 'r1', action: 'x', summary: 'y', requiredApprovals: 1 }),
        registry,
      );
      const ballot = makeEnvelope('Approve', { requestId: 'r1' }, 'alice');
      projection.applyEnvelope(ballot, registry);
      // Redelivery: the identical envelope (same messageId) arrives again, e.g.
      // via the shared-projection-instance echo path.
      projection.applyEnvelope(ballot, registry);

      expect(projection.anomalies).toHaveLength(0);
      expect(projection.approvalCount('r1')).toBe(1);
      expect(projection.ballots.get('r1')?.size).toBe(1);
      const anomalyWarnCalls = calls.filter(([level, message]) => level === 'warn' && message === 'projection anomaly');
      expect(anomalyWarnCalls).toHaveLength(0);
    });

    it('a genuine duplicate ballot (same sender, same request_id, DIFFERENT messageId) records EXACTLY ONE anomaly', () => {
      projection.applyEnvelope(
        makeEnvelope('ApprovalRequest', { requestId: 'r1', action: 'x', summary: 'y', requiredApprovals: 1 }),
        registry,
      );
      const firstBallot = buildEnvelope({
        mode: MODE_QUORUM,
        messageType: 'Approve',
        sessionId: 'test-session',
        sender: 'alice',
        messageId: 'ballot-1',
        payload: registry.encodeKnownPayload(MODE_QUORUM, 'Approve', { requestId: 'r1' }),
      });
      const secondBallot = buildEnvelope({
        mode: MODE_QUORUM,
        messageType: 'Reject',
        sessionId: 'test-session',
        sender: 'alice',
        messageId: 'ballot-2',
        payload: registry.encodeKnownPayload(MODE_QUORUM, 'Reject', { requestId: 'r1' }),
      });
      projection.applyEnvelope(firstBallot, registry);
      projection.applyEnvelope(secondBallot, registry);

      expect(projection.anomalies).toHaveLength(1);
      expect(projection.anomalies[0].kind).toBe(EXPECTED_KIND);
      expect(projection.approvalCount('r1')).toBe(1);
      expect(projection.ballots.get('r1')?.size).toBe(1);
    });
  });

  describe('replay equivalence', () => {
    /**
     * Pins that replaying a projection's own `transcript` into a fresh
     * projection reproduces `ballots` and `anomalies` deep-equal to the
     * original — including that a redelivery (same `messageId`) leaves no
     * trace to replay, while a genuine duplicate (different `messageId`)
     * does. This test does not uniquely catch guard-placement regressions:
     * other tests in this suite (e.g. the reachability-pair tests above)
     * assert the same duplicate/redelivery distinction directly and would
     * also fail such a mutation.
     */
    it('replaying a projection’s own transcript into a fresh projection reproduces identical ballots and anomalies', () => {
      projection.applyEnvelope(
        makeEnvelope('ApprovalRequest', { requestId: 'r1', action: 'x', summary: 'y', requiredApprovals: 1 }),
        registry,
      );
      // One conforming ballot.
      const conforming = buildEnvelope({
        mode: MODE_QUORUM,
        messageType: 'Approve',
        sessionId: 'test-session',
        sender: 'alice',
        messageId: 'ballot-1',
        payload: registry.encodeKnownPayload(MODE_QUORUM, 'Approve', { requestId: 'r1' }),
      });
      projection.applyEnvelope(conforming, registry);
      // A redelivery of it (same messageId) -- never enters transcript.
      projection.applyEnvelope(conforming, registry);
      // A genuine duplicate from the same sender (different messageId).
      const duplicate = buildEnvelope({
        mode: MODE_QUORUM,
        messageType: 'Reject',
        sessionId: 'test-session',
        sender: 'alice',
        messageId: 'ballot-2',
        payload: registry.encodeKnownPayload(MODE_QUORUM, 'Reject', { requestId: 'r1' }),
      });
      projection.applyEnvelope(duplicate, registry);

      expect(projection.transcript).toHaveLength(3);
      expect(projection.anomalies).toHaveLength(1);

      const replay = new QuorumProjection();
      for (const envelope of projection.transcript) {
        replay.applyEnvelope(envelope, registry);
      }

      expect(replay.transcript).toEqual(projection.transcript);
      expect(replay.anomalies).toEqual(projection.anomalies);
      expect([...replay.ballots.entries()]).toEqual([...projection.ballots.entries()]);
    });
  });

  it('commitment transitions to Committed', () => {
    projection.applyEnvelope(
      makeEnvelope('Commitment', {
        commitmentId: 'c1',
        action: 'quorum.approved',
        authorityScope: 'team',
        reason: 'threshold reached',
        modeVersion: '1.0.0',
        configurationVersion: 'config.default',
      }),
      registry,
    );
    expect(projection.phase).toBe('Committed');
  });

  it('returns 0 for unknown request', () => {
    expect(projection.approvalCount('nope')).toBe(0);
    expect(projection.rejectionCount('nope')).toBe(0);
    expect(projection.abstentionCount('nope')).toBe(0);
    expect(projection.threshold('nope')).toBe(0);
    expect(projection.remainingVotesNeeded('nope')).toBe(0);
    expect(projection.votedSenders('nope')).toEqual([]);
    expect(projection.hasQuorum('nope')).toBe(false);
  });

  it('commitmentReady returns true when quorum reached and not yet committed', () => {
    projection.applyEnvelope(
      makeEnvelope('ApprovalRequest', { requestId: 'r1', action: 'deploy', summary: 'release', requiredApprovals: 1 }),
      registry,
    );
    expect(projection.commitmentReady('r1')).toBe(false);

    projection.applyEnvelope(makeEnvelope('Approve', { requestId: 'r1' }, 'alice'), registry);
    expect(projection.commitmentReady('r1')).toBe(true);

    projection.applyEnvelope(
      makeEnvelope('Commitment', {
        commitmentId: 'c1',
        action: 'quorum.approved',
        authorityScope: 'team',
        reason: 'approved',
        modeVersion: '1.0.0',
        configurationVersion: 'config.default',
      }),
      registry,
    );
    expect(projection.commitmentReady('r1')).toBe(false);
  });
});
