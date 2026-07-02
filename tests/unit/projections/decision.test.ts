import { describe, it, expect, beforeEach } from 'vitest';
import { DecisionProjection } from '../../../src/projections/decision';
import { ProtoRegistry } from '../../../src/proto-registry';
import { buildEnvelope } from '../../../src/envelope';
import { MODE_DECISION } from '../../../src/constants';

const registry = new ProtoRegistry();

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

  it('deduplicates votes by sender per proposal', () => {
    projection.applyEnvelope(makeEnvelope('Proposal', { proposalId: 'p1', option: 'a' }), registry);
    projection.applyEnvelope(makeEnvelope('Vote', { proposalId: 'p1', vote: 'reject' }, 'alice'), registry);
    projection.applyEnvelope(makeEnvelope('Vote', { proposalId: 'p1', vote: 'approve' }, 'alice'), registry);

    const totals = projection.voteTotals();
    expect(totals['p1']).toBe(1); // latest vote wins
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
  // under a bound policy carries a Commitment with an explicit
  // `outcome_positive: false`. These assert the value survives the real
  // encode -> decode round-trip (protobufjs preserves an explicitly-set false
  // even under `toObject({ defaults: false })`) and that `isPositiveOutcome`
  // uses `??` (not `||`) so an explicit false is not defaulted back to true.
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

  it('defaults an omitted outcome_positive to a positive outcome (legacy fallback)', () => {
    projection.applyEnvelope(
      makeEnvelope('Commitment', {
        commitmentId: 'c1',
        action: 'decision.approved',
        authorityScope: 'test',
        reason: 'approved',
        modeVersion: '1.0.0',
        configurationVersion: 'cfg-1',
      }),
      registry,
    );

    expect(projection.commitment?.outcomePositive).toBeUndefined(); // absent on the wire
    expect(projection.isPositiveOutcome).toBe(true); // legacy default preserved
  });
});
