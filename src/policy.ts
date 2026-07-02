import type { PolicyDescriptor } from './types';

// ── Named policy rule types ─────────────────────────────────────────
// Names are unprefixed to match python-sdk's `macp_sdk.policy` exports
// so cross-SDK doc snippets and IDE auto-imports line up.

export interface CommitmentRules {
  authority?: 'initiator_only' | 'any_participant' | 'designated_role';
  designatedRoles?: string[];
  /** Decision-specific: require quorum before commit. Ignored for other modes. */
  requireVoteQuorum?: boolean;
  /**
   * RFC-MACP-0012 schema_version 2, Decision mode only: when `true`, a
   * reject-majority resolves the session with a committed *negative* outcome
   * (`outcome_positive = false`) instead of denying commitment. Emitted only by
   * `buildDecisionPolicy`, so the still-v1 quorum/proposal/task/handoff
   * commitment schemas are unaffected. Default `false` preserves v1 behavior.
   */
  allowDeclineOverApproval?: boolean;
}

export interface VotingRules {
  algorithm?: 'none' | 'majority' | 'supermajority' | 'unanimous' | 'weighted' | 'plurality';
  threshold?: number;
  quorum?: { type: 'count' | 'percentage'; value: number };
  weights?: Record<string, number>;
}

export interface ObjectionHandlingRules {
  criticalSeverityVetoes?: boolean;
  vetoThreshold?: number;
  /**
   * RFC-MACP-0012 schema_version 2: action taken when a critical objection would
   * block commitment. `deny` rejects the commitment (legacy default),
   * `finalize_decline` resolves the session as a negative outcome, `hold` leaves
   * the session open. Default `deny` preserves v1 behavior.
   */
  criticalObjectionAction?: 'deny' | 'finalize_decline' | 'hold';
}

export interface EvaluationRules {
  minimumConfidence?: number;
  requiredBeforeVoting?: boolean;
}

export interface QuorumThreshold {
  type: 'n_of_m' | 'percentage' | 'weighted';
  value: number;
}

export interface AbstentionRules {
  countsTowardQuorum?: boolean;
  interpretation?: 'neutral' | 'implicit_reject' | 'ignored';
}

export interface ProposalAcceptanceRules {
  criterion?: 'all_parties' | 'counterparty' | 'initiator';
}

export interface CounterProposalRules {
  maxRounds?: number;
}

export interface RejectionRules {
  terminalOnAnyReject?: boolean;
}

export interface TaskAssignmentRules {
  allowReassignmentOnReject?: boolean;
}

export interface TaskCompletionRules {
  requireOutput?: boolean;
}

export interface HandoffAcceptanceRules {
  implicitAcceptTimeoutMs?: number;
}

// ── Composite rule-input types per mode ──────────────────────────

export interface DecisionPolicyRulesInput {
  voting?: VotingRules;
  objectionHandling?: ObjectionHandlingRules;
  evaluation?: EvaluationRules;
  commitment?: CommitmentRules;
}

export interface QuorumPolicyRulesInput {
  threshold?: QuorumThreshold;
  abstention?: AbstentionRules;
  commitment?: CommitmentRules;
}

export interface ProposalPolicyRulesInput {
  acceptance?: ProposalAcceptanceRules;
  counterProposal?: CounterProposalRules;
  rejection?: RejectionRules;
  commitment?: CommitmentRules;
}

export interface TaskPolicyRulesInput {
  assignment?: TaskAssignmentRules;
  completion?: TaskCompletionRules;
  commitment?: CommitmentRules;
}

export interface HandoffPolicyRulesInput {
  acceptance?: HandoffAcceptanceRules;
  commitment?: CommitmentRules;
}

// ── Builder helpers ─────────────────────────────────────────────────

function serializeCommitment(commitment?: CommitmentRules): Record<string, unknown> {
  return {
    authority: commitment?.authority ?? 'initiator_only',
    designated_roles: commitment?.designatedRoles ?? [],
    // Parity with python-sdk `_commitment_dict`: emitted for every mode, not
    // just decision, so policy JSON is byte-identical across SDKs.
    require_vote_quorum: commitment?.requireVoteQuorum ?? false,
  };
}

export function buildDecisionPolicy(
  policyId: string,
  description: string,
  rules: DecisionPolicyRulesInput,
): PolicyDescriptor {
  // Decision-only: extend the shared v1 commitment rules with the schema_version 2
  // decline-over-approval switch, appended after the shared keys so it does not
  // leak into the still-v1 quorum/proposal/task/handoff commitment blocks
  // (parity with python-sdk `_commitment_dict` + `build_decision_policy`).
  const commitmentSection = serializeCommitment(rules.commitment);
  commitmentSection.allow_decline_over_approval = rules.commitment?.allowDeclineOverApproval ?? false;

  const rulesJson: Record<string, unknown> = {
    voting: {
      algorithm: rules.voting?.algorithm ?? 'none',
      threshold: rules.voting?.threshold ?? 0.5,
      quorum: rules.voting?.quorum ? { type: rules.voting.quorum.type, value: rules.voting.quorum.value } : undefined,
      weights: rules.voting?.weights ?? undefined,
    },
    objection_handling: {
      critical_severity_vetoes: rules.objectionHandling?.criticalSeverityVetoes ?? false,
      veto_threshold: rules.objectionHandling?.vetoThreshold ?? 1,
      critical_objection_action: rules.objectionHandling?.criticalObjectionAction ?? 'deny',
    },
    evaluation: {
      minimum_confidence: rules.evaluation?.minimumConfidence ?? 0,
      required_before_voting: rules.evaluation?.requiredBeforeVoting ?? false,
    },
    commitment: commitmentSection,
  };
  return {
    policyId,
    mode: 'macp.mode.decision.v1',
    description,
    rules: JSON.stringify(rulesJson),
    schemaVersion: 2,
  };
}

export function buildQuorumPolicy(
  policyId: string,
  description: string,
  rules: QuorumPolicyRulesInput,
): PolicyDescriptor {
  const rulesJson: Record<string, unknown> = {
    threshold: {
      type: rules.threshold?.type ?? 'n_of_m',
      value: rules.threshold?.value ?? 0,
    },
    abstention: {
      counts_toward_quorum: rules.abstention?.countsTowardQuorum ?? false,
      interpretation: rules.abstention?.interpretation ?? 'neutral',
    },
    commitment: serializeCommitment(rules.commitment),
  };
  return {
    policyId,
    mode: 'macp.mode.quorum.v1',
    description,
    rules: JSON.stringify(rulesJson),
    schemaVersion: 1,
  };
}

export function buildProposalPolicy(
  policyId: string,
  description: string,
  rules: ProposalPolicyRulesInput,
): PolicyDescriptor {
  const rulesJson: Record<string, unknown> = {
    acceptance: {
      criterion: rules.acceptance?.criterion ?? 'all_parties',
    },
    counter_proposal: {
      max_rounds: rules.counterProposal?.maxRounds ?? 0,
    },
    rejection: {
      terminal_on_any_reject: rules.rejection?.terminalOnAnyReject ?? false,
    },
    commitment: serializeCommitment(rules.commitment),
  };
  return {
    policyId,
    mode: 'macp.mode.proposal.v1',
    description,
    rules: JSON.stringify(rulesJson),
    schemaVersion: 1,
  };
}

export function buildTaskPolicy(policyId: string, description: string, rules: TaskPolicyRulesInput): PolicyDescriptor {
  const rulesJson: Record<string, unknown> = {
    assignment: {
      allow_reassignment_on_reject: rules.assignment?.allowReassignmentOnReject ?? false,
    },
    completion: {
      require_output: rules.completion?.requireOutput ?? false,
    },
    commitment: serializeCommitment(rules.commitment),
  };
  return {
    policyId,
    mode: 'macp.mode.task.v1',
    description,
    rules: JSON.stringify(rulesJson),
    schemaVersion: 1,
  };
}

export function buildHandoffPolicy(
  policyId: string,
  description: string,
  rules: HandoffPolicyRulesInput,
): PolicyDescriptor {
  const rulesJson: Record<string, unknown> = {
    acceptance: {
      implicit_accept_timeout_ms: rules.acceptance?.implicitAcceptTimeoutMs ?? 0,
    },
    commitment: serializeCommitment(rules.commitment),
  };
  return {
    policyId,
    mode: 'macp.mode.handoff.v1',
    description,
    rules: JSON.stringify(rulesJson),
    schemaVersion: 1,
  };
}
