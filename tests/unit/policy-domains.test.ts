import { describe, it, expect } from 'vitest';
import {
  ABSTENTION_INTERPRETATIONS,
  COMMITMENT_AUTHORITIES,
  CRITICAL_OBJECTION_ACTIONS,
  PROPOSAL_ACCEPTANCE_CRITERIA,
  buildDecisionPolicy,
  buildHandoffPolicy,
  buildProposalPolicy,
  buildQuorumPolicy,
  buildTaskPolicy,
  type CommitmentRules,
} from '../../src/policy';
import { MacpSessionError } from '../../src/errors';

// Runtime 0.9.0 refuses an off-domain rule value at RegisterPolicy with
// INVALID_POLICY_DEFINITION; the builders refuse it client-side first. Same
// cases as macp-sdk-python's tests/unit/test_policy_domains.py.

const BUILDERS = {
  decision: (commitment: CommitmentRules) => buildDecisionPolicy('p', 'd', { commitment }),
  quorum: (commitment: CommitmentRules) => buildQuorumPolicy('p', 'd', { commitment }),
  proposal: (commitment: CommitmentRules) => buildProposalPolicy('p', 'd', { commitment }),
  task: (commitment: CommitmentRules) => buildTaskPolicy('p', 'd', { commitment }),
  handoff: (commitment: CommitmentRules) => buildHandoffPolicy('p', 'd', { commitment }),
};

// Off-domain values arrive from untyped (JS/JSON) callers; cast past the unions.
const bad = <T>(value: unknown) => value as T;

function expectRefused(build: () => unknown, field: string): void {
  expect(build).toThrow(MacpSessionError);
  expect(build).toThrow(field);
}

describe('policy builder value domains: refused', () => {
  const modes = Object.keys(BUILDERS) as (keyof typeof BUILDERS)[];
  const cases = modes.flatMap((mode) =>
    ['initiator', 'anyone', '', 'INITIATOR_ONLY', 3].map((authority) => [mode, authority] as const),
  );
  it.each(cases)('%s commitment.authority %j', (mode, authority) => {
    expectRefused(
      () => BUILDERS[mode]({ authority: bad<CommitmentRules['authority']>(authority) }),
      'commitment.authority',
    );
  });

  it.each(['n_of_m', 'weighted', ''])('voting.quorum_type %j', (type) => {
    expectRefused(
      () => buildDecisionPolicy('p', 'd', { voting: { quorum: { type: bad<'count'>(type), value: 1 } } }),
      'voting.quorum_type',
    );
  });

  it.each([-1, -0.5, NaN, Infinity, true, '1'])('voting.quorum_value %j', (value) => {
    expectRefused(
      () => buildDecisionPolicy('p', 'd', { voting: { quorum: { type: 'count', value: bad<number>(value) } } }),
      'voting.quorum_value',
    );
  });

  it.each([0, -1, 1.5, true, NaN])('objection_handling.veto_threshold %j', (value) => {
    expectRefused(
      () => buildDecisionPolicy('p', 'd', { objectionHandling: { vetoThreshold: bad<number>(value) } }),
      'objection_handling.veto_threshold',
    );
  });

  it.each(['block', 'decline', 'HOLD'])('objection_handling.critical_objection_action %j', (action) => {
    expectRefused(
      () =>
        buildDecisionPolicy('p', 'd', {
          objectionHandling: { criticalObjectionAction: bad<'deny'>(action) },
        }),
      'objection_handling.critical_objection_action',
    );
  });

  it.each([-0.01, 1.01, NaN, Infinity, true])('evaluation.minimum_confidence %j', (value) => {
    expectRefused(
      () => buildDecisionPolicy('p', 'd', { evaluation: { minimumConfidence: bad<number>(value) } }),
      'evaluation.minimum_confidence',
    );
  });

  it.each(['reject', 'abstain', ''])('abstention.interpretation %j', (interpretation) => {
    expectRefused(
      () => buildQuorumPolicy('p', 'd', { abstention: { interpretation: bad<'neutral'>(interpretation) } }),
      'abstention.interpretation',
    );
  });

  it.each(['majority', 'all', ''])('acceptance.criterion %j', (criterion) => {
    expectRefused(
      () => buildProposalPolicy('p', 'd', { acceptance: { criterion: bad<'initiator'>(criterion) } }),
      'acceptance.criterion',
    );
  });

  it.each([-1, 2.5, true])('counter_proposal.max_rounds %j', (value) => {
    expectRefused(
      () => buildProposalPolicy('p', 'd', { counterProposal: { maxRounds: bad<number>(value) } }),
      'counter_proposal.max_rounds',
    );
  });

  it.each([-1, 10.5, false])('acceptance.implicit_accept_timeout_ms %j', (value) => {
    expectRefused(
      () => buildHandoffPolicy('p', 'd', { acceptance: { implicitAcceptTimeoutMs: bad<number>(value) } }),
      'acceptance.implicit_accept_timeout_ms',
    );
  });
});

describe('policy builder value domains: accepted', () => {
  it('decision boundaries', () => {
    const rules = JSON.parse(
      buildDecisionPolicy('p', 'd', {
        voting: { quorum: { type: 'percentage', value: 0 } },
        objectionHandling: { vetoThreshold: 1 },
        evaluation: { minimumConfidence: 1 },
      }).rules,
    );
    expect(rules.voting.quorum).toEqual({ type: 'percentage', value: 0 });
    expect(rules.objection_handling.veto_threshold).toBe(1);
    expect(rules.evaluation.minimum_confidence).toBe(1);
    expect(() => buildDecisionPolicy('p', 'd', { evaluation: { minimumConfidence: 0 } })).not.toThrow();
  });

  it('zero counts', () => {
    expect(() => buildProposalPolicy('p', 'd', { counterProposal: { maxRounds: 0 } })).not.toThrow();
    expect(() => buildHandoffPolicy('p', 'd', { acceptance: { implicitAcceptTimeoutMs: 0 } })).not.toThrow();
  });

  it.each([...COMMITMENT_AUTHORITIES].filter((a) => a !== 'designated_role'))('authority %s', (authority) => {
    for (const build of Object.values(BUILDERS)) expect(() => build({ authority })).not.toThrow();
  });

  it('designated_role with roles', () => {
    for (const build of Object.values(BUILDERS)) {
      expect(() => build({ authority: 'designated_role', designatedRoles: ['ops'] })).not.toThrow();
    }
  });

  it.each([...ABSTENTION_INTERPRETATIONS])('interpretation %s', (interpretation) => {
    expect(() => buildQuorumPolicy('p', 'd', { abstention: { interpretation } })).not.toThrow();
  });

  it.each([...PROPOSAL_ACCEPTANCE_CRITERIA])('criterion %s', (criterion) => {
    expect(() => buildProposalPolicy('p', 'd', { acceptance: { criterion } })).not.toThrow();
  });

  it.each([...CRITICAL_OBJECTION_ACTIONS])('critical objection action %s', (criticalObjectionAction) => {
    expect(() => buildDecisionPolicy('p', 'd', { objectionHandling: { criticalObjectionAction } })).not.toThrow();
  });

  it('exported sets match macp-sdk-python', () => {
    expect([...COMMITMENT_AUTHORITIES].sort()).toEqual(['any_participant', 'designated_role', 'initiator_only']);
    expect([...ABSTENTION_INTERPRETATIONS].sort()).toEqual(['ignored', 'implicit_reject', 'neutral']);
    expect([...PROPOSAL_ACCEPTANCE_CRITERIA].sort()).toEqual(['all_parties', 'counterparty', 'initiator']);
    expect([...CRITICAL_OBJECTION_ACTIONS].sort()).toEqual(['deny', 'finalize_decline', 'hold']);
  });
});
