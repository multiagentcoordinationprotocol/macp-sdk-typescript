import { describe, it, expect } from 'vitest';
import {
  buildDecisionPolicy,
  buildQuorumPolicy,
  buildProposalPolicy,
  buildTaskPolicy,
  buildHandoffPolicy,
} from '../../src/policy';

function parseRules(descriptor: { rules: string }): Record<string, unknown> {
  return JSON.parse(descriptor.rules);
}

describe('policy builders', () => {
  describe('buildDecisionPolicy', () => {
    it('builds a descriptor with correct mode and schemaVersion', () => {
      const descriptor = buildDecisionPolicy('policy.test', 'Test policy', {});
      expect(descriptor.policyId).toBe('policy.test');
      expect(descriptor.mode).toBe('macp.mode.decision.v1');
      expect(descriptor.description).toBe('Test policy');
      // RFC-MACP-0012 schema_version 2 (additive Decision decline-gating fields).
      expect(descriptor.schemaVersion).toBe(2);
    });

    it('includes default voting rules', () => {
      const rules = parseRules(buildDecisionPolicy('p1', 'desc', {}));
      expect(rules.voting).toEqual(expect.objectContaining({ algorithm: 'none', threshold: 0.5 }));
    });

    it('includes custom voting rules', () => {
      const rules = parseRules(
        buildDecisionPolicy('p1', 'desc', {
          voting: {
            algorithm: 'majority',
            threshold: 0.6,
            quorum: { type: 'count', value: 3 },
            weights: { 'agent-a': 2, 'agent-b': 1 },
          },
        }),
      );
      expect(rules.voting).toEqual(
        expect.objectContaining({
          algorithm: 'majority',
          threshold: 0.6,
          quorum: { type: 'count', value: 3 },
          weights: { 'agent-a': 2, 'agent-b': 1 },
        }),
      );
    });

    it('includes objection handling rules', () => {
      const rules = parseRules(
        buildDecisionPolicy('p1', 'desc', {
          objectionHandling: { criticalSeverityVetoes: false, vetoThreshold: 2 },
        }),
      );
      expect(rules.objection_handling).toEqual({
        critical_severity_vetoes: false,
        veto_threshold: 2,
        critical_objection_action: 'deny',
      });
    });

    it('includes custom critical_objection_action (schema_version 2)', () => {
      const rules = parseRules(
        buildDecisionPolicy('p1', 'desc', {
          objectionHandling: {
            criticalSeverityVetoes: true,
            vetoThreshold: 1,
            criticalObjectionAction: 'finalize_decline',
          },
        }),
      );
      expect(rules.objection_handling).toEqual({
        critical_severity_vetoes: true,
        veto_threshold: 1,
        critical_objection_action: 'finalize_decline',
      });
    });

    it('includes evaluation rules', () => {
      const rules = parseRules(
        buildDecisionPolicy('p1', 'desc', {
          evaluation: { minimumConfidence: 0.8, requiredBeforeVoting: true },
        }),
      );
      expect(rules.evaluation).toEqual({
        minimum_confidence: 0.8,
        required_before_voting: true,
      });
    });

    it('includes commitment rules with designated_roles', () => {
      const rules = parseRules(
        buildDecisionPolicy('p1', 'desc', {
          commitment: {
            authority: 'designated_role',
            designatedRoles: ['admin'],
            requireVoteQuorum: true,
          },
        }),
      );
      expect(rules.commitment).toEqual({
        authority: 'designated_role',
        designated_roles: ['admin'],
        require_vote_quorum: true,
        allow_decline_over_approval: false,
      });
    });

    it('includes custom allow_decline_over_approval (schema_version 2)', () => {
      const rules = parseRules(
        buildDecisionPolicy('p1', 'desc', {
          commitment: { authority: 'initiator_only', allowDeclineOverApproval: true },
        }),
      );
      expect(rules.commitment).toEqual({
        authority: 'initiator_only',
        designated_roles: [],
        require_vote_quorum: false,
        allow_decline_over_approval: true,
      });
    });

    it('uses default objection handling values', () => {
      const rules = parseRules(buildDecisionPolicy('p1', 'desc', {}));
      expect(rules.objection_handling).toEqual({
        critical_severity_vetoes: false,
        veto_threshold: 1,
        critical_objection_action: 'deny',
      });
    });

    it('uses default commitment values', () => {
      const rules = parseRules(buildDecisionPolicy('p1', 'desc', {}));
      expect(rules.commitment).toEqual({
        authority: 'initiator_only',
        designated_roles: [],
        require_vote_quorum: false,
        allow_decline_over_approval: false,
      });
    });
  });

  describe('buildQuorumPolicy (RFC-MACP-0012 §4.2)', () => {
    it('builds with correct mode', () => {
      const descriptor = buildQuorumPolicy('q1', 'Quorum policy', {});
      expect(descriptor.mode).toBe('macp.mode.quorum.v1');
      expect(descriptor.schemaVersion).toBe(1);
    });

    it('uses RFC default values', () => {
      const rules = parseRules(buildQuorumPolicy('q1', 'desc', {}));
      expect(rules.threshold).toEqual({ type: 'n_of_m', value: 0 });
      expect(rules.abstention).toEqual({
        counts_toward_quorum: false,
        interpretation: 'neutral',
      });
      expect(rules.commitment).toEqual({
        authority: 'initiator_only',
        designated_roles: [],
        require_vote_quorum: false,
      });
    });

    it('includes custom threshold', () => {
      const rules = parseRules(
        buildQuorumPolicy('q1', 'desc', {
          threshold: { type: 'percentage', value: 0.75 },
        }),
      );
      expect(rules.threshold).toEqual({ type: 'percentage', value: 0.75 });
    });

    it('includes custom abstention rules', () => {
      const rules = parseRules(
        buildQuorumPolicy('q1', 'desc', {
          abstention: { countsTowardQuorum: true, interpretation: 'implicit_reject' },
        }),
      );
      expect(rules.abstention).toEqual({
        counts_toward_quorum: true,
        interpretation: 'implicit_reject',
      });
    });

    it('includes weighted threshold', () => {
      const rules = parseRules(
        buildQuorumPolicy('q1', 'desc', {
          threshold: { type: 'weighted', value: 10 },
        }),
      );
      expect(rules.threshold).toEqual({ type: 'weighted', value: 10 });
    });

    it('includes commitment with designated roles', () => {
      const rules = parseRules(
        buildQuorumPolicy('q1', 'desc', {
          commitment: { authority: 'designated_role', designatedRoles: ['lead'] },
        }),
      );
      expect(rules.commitment).toEqual({
        authority: 'designated_role',
        designated_roles: ['lead'],
        require_vote_quorum: false,
      });
    });

    it('stays schema_version 1 and drops the Decision-only allow_decline_over_approval field', () => {
      const descriptor = buildQuorumPolicy('q1', 'desc', {
        commitment: { allowDeclineOverApproval: true },
      });
      expect(descriptor.schemaVersion).toBe(1);
      const rules = parseRules(descriptor);
      expect(rules.commitment).toEqual({
        authority: 'initiator_only',
        designated_roles: [],
        require_vote_quorum: false,
      });
    });
  });

  describe('buildProposalPolicy (RFC-MACP-0012 §4.3)', () => {
    it('builds with correct mode', () => {
      const descriptor = buildProposalPolicy('pr1', 'Proposal policy', {});
      expect(descriptor.mode).toBe('macp.mode.proposal.v1');
    });

    it('uses RFC default values', () => {
      const rules = parseRules(buildProposalPolicy('pr1', 'desc', {}));
      expect(rules.acceptance).toEqual({ criterion: 'all_parties' });
      expect(rules.counter_proposal).toEqual({ max_rounds: 0 });
      expect(rules.rejection).toEqual({ terminal_on_any_reject: false });
      expect(rules.commitment).toEqual({
        authority: 'initiator_only',
        designated_roles: [],
        require_vote_quorum: false,
      });
    });

    it('includes custom acceptance criterion', () => {
      const rules = parseRules(
        buildProposalPolicy('pr1', 'desc', {
          acceptance: { criterion: 'counterparty' },
        }),
      );
      expect(rules.acceptance).toEqual({ criterion: 'counterparty' });
    });

    it('includes counter-proposal limits and rejection rules', () => {
      const rules = parseRules(
        buildProposalPolicy('pr1', 'desc', {
          counterProposal: { maxRounds: 5 },
          rejection: { terminalOnAnyReject: true },
        }),
      );
      expect(rules.counter_proposal).toEqual({ max_rounds: 5 });
      expect(rules.rejection).toEqual({ terminal_on_any_reject: true });
    });
  });

  describe('buildTaskPolicy (RFC-MACP-0012 §4.4)', () => {
    it('builds with correct mode', () => {
      const descriptor = buildTaskPolicy('t1', 'Task policy', {});
      expect(descriptor.mode).toBe('macp.mode.task.v1');
    });

    it('uses RFC default values', () => {
      const rules = parseRules(buildTaskPolicy('t1', 'desc', {}));
      expect(rules.assignment).toEqual({ allow_reassignment_on_reject: false });
      expect(rules.completion).toEqual({ require_output: false });
      expect(rules.commitment).toEqual({
        authority: 'initiator_only',
        designated_roles: [],
        require_vote_quorum: false,
      });
    });

    it('includes custom assignment and completion rules', () => {
      const rules = parseRules(
        buildTaskPolicy('t1', 'desc', {
          assignment: { allowReassignmentOnReject: true },
          completion: { requireOutput: true },
        }),
      );
      expect(rules.assignment).toEqual({ allow_reassignment_on_reject: true });
      expect(rules.completion).toEqual({ require_output: true });
    });
  });

  describe('buildHandoffPolicy (RFC-MACP-0012 §4.5)', () => {
    it('builds with correct mode', () => {
      const descriptor = buildHandoffPolicy('h1', 'Handoff policy', {});
      expect(descriptor.mode).toBe('macp.mode.handoff.v1');
    });

    it('uses RFC default values', () => {
      const rules = parseRules(buildHandoffPolicy('h1', 'desc', {}));
      expect(rules.acceptance).toEqual({ implicit_accept_timeout_ms: 0 });
      expect(rules.commitment).toEqual({
        authority: 'initiator_only',
        designated_roles: [],
        require_vote_quorum: false,
      });
    });

    it('includes custom implicit accept timeout', () => {
      const rules = parseRules(
        buildHandoffPolicy('h1', 'desc', {
          acceptance: { implicitAcceptTimeoutMs: 15000 },
        }),
      );
      expect(rules.acceptance).toEqual({ implicit_accept_timeout_ms: 15000 });
    });

    it('includes commitment with any_participant authority', () => {
      const rules = parseRules(
        buildHandoffPolicy('h1', 'desc', {
          commitment: { authority: 'any_participant' },
        }),
      );
      expect(rules.commitment).toEqual({
        authority: 'any_participant',
        designated_roles: [],
        require_vote_quorum: false,
      });
    });
  });

  describe('PolicyDescriptor shape', () => {
    it('rules field is a string', () => {
      const descriptor = buildDecisionPolicy('p1', 'desc', {});
      expect(typeof descriptor.rules).toBe('string');
    });

    it('rules can be parsed as JSON', () => {
      const descriptor = buildDecisionPolicy('p1', 'desc', { voting: { algorithm: 'unanimous' } });
      const parsed = parseRules(descriptor);
      expect((parsed.voting as Record<string, unknown>).algorithm).toBe('unanimous');
    });

    it('registeredAtUnixMs is undefined by default', () => {
      const descriptor = buildDecisionPolicy('p1', 'desc', {});
      expect(descriptor.registeredAtUnixMs).toBeUndefined();
    });
  });
});
