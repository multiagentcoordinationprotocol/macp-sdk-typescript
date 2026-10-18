import {
  buildDecisionPolicy,
  buildHandoffPolicy,
  buildProposalPolicy,
  buildQuorumPolicy,
  buildTaskPolicy,
} from '../../src/policy';
import type { PolicyDescriptor } from '../../src/types';

// Builder inputs whose `rules` bytes are pinned in golden/policy-builders.json
// (captured before extensions/annotations existed), so adding a rules key
// class can never shift the bytes an existing caller registers.
export const GOLDEN_CASES: Record<string, () => PolicyDescriptor> = {
  'decision.defaults': () => buildDecisionPolicy('p', 'd', {}),
  'decision.full': () =>
    buildDecisionPolicy(
      'p',
      'd',
      {
        voting: {
          algorithm: 'weighted',
          threshold: 0.6,
          quorum: { type: 'percentage', value: 50 },
          weights: { a: 2, b: 1 },
        },
        objectionHandling: { criticalSeverityVetoes: true, vetoThreshold: 2, criticalObjectionAction: 'hold' },
        evaluation: { minimumConfidence: 0.7, requiredBeforeVoting: true },
        commitment: {
          authority: 'designated_role',
          designatedRoles: ['lead'],
          requireVoteQuorum: true,
          allowDeclineOverApproval: true,
        },
      },
      { schemaVersion: 2 },
    ),
  'quorum.defaults': () => buildQuorumPolicy('p', 'd', {}),
  'quorum.full': () =>
    buildQuorumPolicy('p', 'd', {
      threshold: { type: 'percentage', value: 67 },
      abstention: { countsTowardQuorum: true, interpretation: 'implicit_reject' },
      commitment: { authority: 'any_participant' },
    }),
  'proposal.defaults': () => buildProposalPolicy('p', 'd', {}),
  'proposal.full': () =>
    buildProposalPolicy('p', 'd', {
      acceptance: { criterion: 'counterparty' },
      counterProposal: { maxRounds: 3 },
      rejection: { terminalOnAnyReject: true },
    }),
  'task.defaults': () => buildTaskPolicy('p', 'd', {}),
  'task.full': () =>
    buildTaskPolicy('p', 'd', {
      assignment: { allowReassignmentOnReject: true },
      completion: { requireOutput: true },
    }),
  'handoff.defaults': () => buildHandoffPolicy('p', 'd', {}),
  'handoff.full': () => buildHandoffPolicy('p', 'd', { acceptance: { implicitAcceptTimeoutMs: 5000 } }),
};
