import { describe, it, expect } from 'vitest';
import {
  buildDecisionPolicy,
  buildQuorumPolicy,
  buildProposalPolicy,
  buildTaskPolicy,
  buildHandoffPolicy,
} from '../../src/policy';
import { MacpSessionError } from '../../src/errors';
import type { CommitmentRules } from '../../src/policy';
import type { PolicyDescriptor } from '../../src/types';

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

  describe('buildDecisionPolicy schemaVersion override (RFC-MACP-0012 §8)', () => {
    it('AC3: options omitted, {}, and undefined all emit schemaVersion 2', () => {
      expect(buildDecisionPolicy('p', 'd', {}).schemaVersion).toBe(2);
      expect(buildDecisionPolicy('p', 'd', {}, {}).schemaVersion).toBe(2);
      expect(buildDecisionPolicy('p', 'd', {}, undefined).schemaVersion).toBe(2);
    });

    it.each([1, 2, 3] as const)('AC2: explicit schemaVersion %i round-trips', (schemaVersion) => {
      expect(buildDecisionPolicy('p', 'd', {}, { schemaVersion }).schemaVersion).toBe(schemaVersion);
    });

    it('AC4: an out-of-range schemaVersion throws MacpSessionError', () => {
      const build = () => buildDecisionPolicy('p', 'd', {}, { schemaVersion: 4 as never });
      expect(build).toThrow(MacpSessionError);
      expect(build).toThrow(/schemaVersion must be one of/);
    });

    it('a NaN-typed schemaVersion throws MacpSessionError (untyped JS caller)', () => {
      const build = () => buildDecisionPolicy('p', 'd', {}, { schemaVersion: NaN as never });
      expect(build).toThrow(MacpSessionError);
      expect(build).toThrow(/schemaVersion must be one of/);
    });

    it('AC5: the serialized rules JSON is byte-identical across schema versions', () => {
      const rules = {
        voting: { algorithm: 'majority' as const, threshold: 0.6, weights: { a: 1, b: 2 } },
        commitment: { authority: 'designated_role' as const, designatedRoles: ['lead'] },
      };
      const v1 = buildDecisionPolicy('p', 'd', rules, { schemaVersion: 1 });
      const v2 = buildDecisionPolicy('p', 'd', rules, { schemaVersion: 2 });
      const v3 = buildDecisionPolicy('p', 'd', rules, { schemaVersion: 3 });
      expect(v1.rules).toBe(v2.rules);
      expect(v2.rules).toBe(v3.rules);
      expect(v1.schemaVersion).toBe(1);
      expect(v2.schemaVersion).toBe(2);
      expect(v3.schemaVersion).toBe(3);
    });

    it("does not affect any other builder's schemaVersion", () => {
      expect(buildQuorumPolicy('p', 'd', {}).schemaVersion).toBe(1);
      expect(buildProposalPolicy('p', 'd', {}).schemaVersion).toBe(1);
      expect(buildTaskPolicy('p', 'd', {}).schemaVersion).toBe(1);
      expect(buildHandoffPolicy('p', 'd', {}).schemaVersion).toBe(1);
    });
  });

  describe('buildDecisionPolicy schema constraints (RFC-MACP-0012 decision-rules.schema.json)', () => {
    it('throws on an algorithm outside the canonical six', () => {
      const build = () => buildDecisionPolicy('p', 'd', { voting: { algorithm: 'bogus' as never } });
      expect(build).toThrow(MacpSessionError);
      expect(build).toThrow(/algorithm must be one of/);
    });

    it.each(['none', 'majority', 'supermajority', 'unanimous', 'weighted', 'plurality'] as const)(
      'accepts the canonical algorithm %s',
      (algorithm) => {
        const extra =
          algorithm === 'supermajority' ? { threshold: 0.67 } : algorithm === 'weighted' ? { weights: { a: 1 } } : {};
        expect(() => buildDecisionPolicy('p', 'd', { voting: { algorithm, ...extra } })).not.toThrow();
      },
    );

    it.each([
      [0, true],
      [0.0001, false],
      [1, false],
      [1.0001, true],
    ])('threshold %s (throws: %s) — 0 < threshold <= 1', (threshold, shouldThrow) => {
      const build = () => buildDecisionPolicy('p', 'd', { voting: { threshold } });
      if (shouldThrow) {
        expect(build).toThrow(MacpSessionError);
      } else {
        expect(build).not.toThrow();
      }
    });

    it('majority passes at exactly 0.5 and throws just below it', () => {
      expect(() => buildDecisionPolicy('p', 'd', { voting: { algorithm: 'majority', threshold: 0.5 } })).not.toThrow();
      const build = () => buildDecisionPolicy('p', 'd', { voting: { algorithm: 'majority', threshold: 0.49 } });
      expect(build).toThrow(MacpSessionError);
      expect(build).toThrow(/majority.*requires threshold >= 0.5/);
    });

    it('supermajority throws at exactly 0.5 (the default-wearing-the-name trap) and passes just above it', () => {
      const build = () => buildDecisionPolicy('p', 'd', { voting: { algorithm: 'supermajority' } });
      expect(build).toThrow(MacpSessionError);
      expect(build).toThrow(/bare majority wearing the name/);
      expect(() =>
        buildDecisionPolicy('p', 'd', { voting: { algorithm: 'supermajority', threshold: 0.51 } }),
      ).not.toThrow();
    });

    it('AC2: supermajority at the default threshold throws; an explicit 0.67 succeeds', () => {
      expect(() => buildDecisionPolicy('p', 'd', { voting: { algorithm: 'supermajority' } })).toThrow(MacpSessionError);
      expect(() =>
        buildDecisionPolicy('p', 'd', { voting: { algorithm: 'supermajority', threshold: 0.67 } }),
      ).not.toThrow();
    });

    it("AC3: 'weighted' throws without weights and succeeds with a non-empty map", () => {
      expect(() => buildDecisionPolicy('p', 'd', { voting: { algorithm: 'weighted' } })).toThrow(MacpSessionError);
      expect(() =>
        buildDecisionPolicy('p', 'd', { voting: { algorithm: 'weighted', weights: { a: 1 } } }),
      ).not.toThrow();
    });

    it('AC4: the electorate rule is unconditional — algorithm: none with weights: {} still throws', () => {
      expect(() => buildDecisionPolicy('p', 'd', { voting: { algorithm: 'none', weights: {} } })).toThrow(
        MacpSessionError,
      );
    });

    it('throws on an empty weights map with the electorate rationale', () => {
      const build = () => buildDecisionPolicy('p', 'd', { voting: { weights: {} } });
      expect(build).toThrow(MacpSessionError);
      expect(build).toThrow(/non-empty/);
    });

    it('throws on a zero weight, naming omission as the correct way to express weight 0', () => {
      const build = () => buildDecisionPolicy('p', 'd', { voting: { weights: { a: 0 } } });
      expect(build).toThrow(MacpSessionError);
      expect(build).toThrow(/omission from the map/);
    });

    it('throws on a NaN weight, naming omission as the correct way to express weight 0', () => {
      // weight <= 0 alone would let NaN slip through (NaN <= 0 is false);
      // this pins the separate Number.isNaN guard (registry.rs:596 parity).
      const build = () => buildDecisionPolicy('p', 'd', { voting: { weights: { a: NaN } } });
      expect(build).toThrow(MacpSessionError);
      expect(build).toThrow(/omission from the map/);
    });

    it('throws on a NaN threshold', () => {
      // 0 < NaN is false, so this falls through the same branch as threshold
      // 0 -- pinned separately since it documents intent, not new coverage.
      expect(() => buildDecisionPolicy('p', 'd', { voting: { threshold: NaN } })).toThrow(MacpSessionError);
    });
  });

  describe('buildQuorumPolicy (RFC-MACP-0012 §4.2)', () => {
    it('builds with correct mode', () => {
      const descriptor = buildQuorumPolicy('q1', 'Quorum policy', {});
      expect(descriptor.mode).toBe('macp.mode.quorum.v1');
      expect(descriptor.schemaVersion).toBe(1);
    });

    it('uses RFC default values (omitted threshold yields value: 1)', () => {
      const rules = parseRules(buildQuorumPolicy('q1', 'desc', {}));
      expect(rules.threshold).toEqual({ type: 'n_of_m', value: 1 });
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

    it('includes a percentage threshold on the 1–100 integer scale', () => {
      // The runtime reads `percentage` as an integer 1–100 (approval bar =
      // ceil(value/100 × participants)). `75` means 75%, not 0.75.
      const rules = parseRules(
        buildQuorumPolicy('q1', 'desc', {
          threshold: { type: 'percentage', value: 75 },
        }),
      );
      expect(rules.threshold).toEqual({ type: 'percentage', value: 75 });
    });

    it('accepts the 100 percentage boundary', () => {
      expect(() => buildQuorumPolicy('q1', 'd', { threshold: { type: 'percentage', value: 100 } })).not.toThrow();
    });

    it.each(['n_of_m', 'percentage'] as const)(
      'throws on a zero approval bar for type %s (exclusiveMinimum: 0, unconditional)',
      (type) => {
        expect(() => buildQuorumPolicy('q1', 'd', { threshold: { type, value: 0 } })).toThrow(MacpSessionError);
      },
    );

    it('throws on a negative threshold value', () => {
      expect(() => buildQuorumPolicy('q1', 'd', { threshold: { type: 'percentage', value: -1 } })).toThrow(
        MacpSessionError,
      );
    });

    it('throws on a fractional percentage threshold (0.75 → ~1% bar bug)', () => {
      expect(() => buildQuorumPolicy('q1', 'd', { threshold: { type: 'percentage', value: 0.75 } })).toThrow(
        MacpSessionError,
      );
    });

    it('throws on a fractional n_of_m threshold', () => {
      // Unlike the percentage-only check this replaces, integrality is now
      // enforced unconditionally: the canonical schema declares 'value' as
      // an integer for every threshold type, not just 'percentage'.
      expect(() => buildQuorumPolicy('q1', 'd', { threshold: { type: 'n_of_m', value: 1.5 } })).toThrow(
        MacpSessionError,
      );
    });

    it('throws on an out-of-range percentage threshold', () => {
      expect(() => buildQuorumPolicy('q1', 'd', { threshold: { type: 'percentage', value: 101 } })).toThrow(
        MacpSessionError,
      );
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

    it("throws on the reserved 'weighted' type, naming the reservation", () => {
      // 'weighted' was removed from the canonical quorum-rules schema without
      // ever having defined semantics (no weights vocabulary, no electorate
      // rule) and is refused by the runtime. The TS union no longer admits it
      // at compile time (see the `tsc` check below); this proves the runtime
      // guard also catches a JS caller or an `as` cast around the type.
      const build = () =>
        buildQuorumPolicy('q1', 'desc', {
          threshold: { type: 'weighted' as never, value: 10 },
        });
      expect(build).toThrow(MacpSessionError);
      expect(build).toThrow(/reserved/);
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

  describe('serializeCommitment: designated_role requires designated_roles', () => {
    // Shared behavior, tested once across all five builders rather than
    // per-builder, since serializeCommitment() is the single call site.
    const builders: Array<
      [string, (policyId: string, description: string, rules: { commitment?: CommitmentRules }) => PolicyDescriptor]
    > = [
      ['buildDecisionPolicy', buildDecisionPolicy],
      ['buildQuorumPolicy', buildQuorumPolicy],
      ['buildProposalPolicy', buildProposalPolicy],
      ['buildTaskPolicy', buildTaskPolicy],
      ['buildHandoffPolicy', buildHandoffPolicy],
    ];

    it.each(builders)('%s throws when designatedRoles is omitted', (_name, build) => {
      const throwing = () => build('p', 'd', { commitment: { authority: 'designated_role' } });
      expect(throwing).toThrow(MacpSessionError);
      expect(throwing).toThrow(/designatedRoles/);
      expect(throwing).toThrow(/names no one/);
    });

    it.each(builders)('%s throws when designatedRoles is empty', (_name, build) => {
      const throwing = () => build('p', 'd', { commitment: { authority: 'designated_role', designatedRoles: [] } });
      expect(throwing).toThrow(MacpSessionError);
      expect(throwing).toThrow(/designatedRoles/);
      expect(throwing).toThrow(/names no one/);
    });

    it.each(builders)('%s succeeds with a non-empty designatedRoles and emits it', (_name, build) => {
      const descriptor = build('p', 'd', {
        commitment: { authority: 'designated_role', designatedRoles: ['lead'] },
      });
      const rules = parseRules(descriptor);
      expect((rules.commitment as { designated_roles: string[] }).designated_roles).toEqual(['lead']);
    });

    it('does not throw for any_participant with an empty designatedRoles (negative control)', () => {
      // The schema's conditional arm is keyed on `authority` alone --
      // designatedRoles is ignored, not invalid, under the other two.
      expect(() =>
        buildProposalPolicy('p', 'd', { commitment: { authority: 'any_participant', designatedRoles: [] } }),
      ).not.toThrow();
    });

    it('does not throw for initiator_only with a non-empty designatedRoles (negative control)', () => {
      // Same conditional arm, opposite direction: a populated designatedRoles
      // under an authority that ignores it is still harmless, not invalid.
      expect(() =>
        buildProposalPolicy('p', 'd', { commitment: { authority: 'initiator_only', designatedRoles: ['lead'] } }),
      ).not.toThrow();
    });

    it('Decision: the throw happens before allow_decline_over_approval is appended', () => {
      expect(() =>
        buildDecisionPolicy('p', 'd', {
          commitment: { authority: 'designated_role', allowDeclineOverApproval: true },
        }),
      ).toThrow(MacpSessionError);
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
