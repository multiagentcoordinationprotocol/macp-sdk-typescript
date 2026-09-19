import { MacpSessionError } from './errors';
import type { PolicyDescriptor } from './types';

// ── Named policy rule types ─────────────────────────────────────────
// Names are unprefixed to match python-sdk's `macp_sdk.policy` exports
// so cross-SDK doc snippets and IDE auto-imports line up.

export interface CommitmentRules {
  authority?: 'initiator_only' | 'any_participant' | 'designated_role';
  /**
   * Required non-empty when `authority` is `'designated_role'` — every
   * builder throws `MacpSessionError` otherwise, since an authority rule
   * naming no one is unsatisfiable. Ignored (serialized but inert) under the
   * other two authorities.
   */
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
  /**
   * Vote-share fraction on a **0–1 scale** (e.g. `0.5` = simple majority). This
   * is a DIFFERENT field from the quorum `percentage` below — do not confuse
   * the scales.
   */
  threshold?: number;
  /**
   * Participation quorum. For `type: 'percentage'`, `value` is an **integer
   * 0–100** (the runtime evaluates it on the same 0–100 scale as the quorum
   * mode's threshold), NOT a 0–1 fraction. For `type: 'count'`, an absolute
   * participant count.
   */
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
  type: 'n_of_m' | 'percentage';
  /**
   * The approval bar (RFC-MACP-0012 §4.2) — how many APPROVE commitments the
   * request needs, NOT a participation quorum. Scale depends on `type`:
   * - `n_of_m`: an absolute count.
   * - `percentage`: an **integer 1–100**; the runtime computes the bar as
   *   `ceil(value / 100 × participants)`. So `75` means "≥ 75% of participants
   *   must approve", NOT `0.75`.
   *
   * Must be a **positive integer** for every `type` (`exclusiveMinimum: 0` in
   * the canonical `quorum-rules.schema.json`, unconditional — a zero approval
   * bar would be trivially satisfied by any ballot set). `buildQuorumPolicy`
   * validates this and throws on a non-integer, non-positive, or (for
   * `percentage`) out-of-[1,100] value.
   */
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
  // `authority: 'designated_role'` with an empty (or unset) `designatedRoles`
  // names no one, so no sender could ever satisfy it. All five rule schemas
  // reject this combination at admission (spec PR #121) via a root-level
  // `allOf` conditional arm, not an inline constraint on the property, so it
  // is easy to miss. Validated once, here, so every mode builder gets it
  // uniformly -- mirrors python-sdk `_commitment_dict`, policy.py:49-60.
  //
  // Explicit length check, not a truthiness test (Python's `not
  // c.designated_roles`): the omitted-field and supplied-`[]` cases both
  // collapse to length 0 here, and both must throw -- unlike Phase 3's
  // weights rule, there is no supplied-vs-absent distinction to preserve.
  if (commitment?.authority === 'designated_role' && (commitment.designatedRoles?.length ?? 0) === 0) {
    throw new MacpSessionError(
      "commitment.authority is 'designated_role' but designatedRoles is empty -- this names no one, " +
        'so no sender could ever satisfy it. Pass at least one role/participant id in designatedRoles.',
    );
  }
  return {
    authority: commitment?.authority ?? 'initiator_only',
    designated_roles: commitment?.designatedRoles ?? [],
    // Parity with python-sdk `_commitment_dict`: emitted for every mode, not
    // just decision, so policy JSON is byte-identical across SDKs.
    require_vote_quorum: commitment?.requireVoteQuorum ?? false,
  };
}

// Typed against VotingRules['algorithm'] (not a bare string[]) so adding a
// seventh canonical algorithm to that union without also adding it here is a
// tsc error instead of a silent runtime-only rejection — same frozen-set
// intent as this file's other guards (see e.g. commitment-hash-frozen-fields.test.ts).
const DECISION_ALGORITHMS: ReadonlySet<NonNullable<VotingRules['algorithm']>> = new Set([
  'none',
  'majority',
  'supermajority',
  'unanimous',
  'weighted',
  'plurality',
]);

// RFC-MACP-0012 §8 requires runtimes to accept all three forever -- none of
// these is a deprecation path. Mirrors macp-sdk-python policy.py's
// _DECISION_SCHEMA_VERSIONS.
const DECISION_SCHEMA_VERSIONS: ReadonlySet<1 | 2 | 3> = new Set([1, 2, 3]);

export interface DecisionPolicyOptions {
  /**
   * RFC-MACP-0012 rule schema version the runtime evaluates this policy
   * under (validated, never re-validated, at admission -- RFC-MACP-0012 §8
   * item 4):
   * - `1`/`2`: an empty decisive tally is fail-*open* (satisfies the voting
   *   requirement).
   * - `3`: an empty decisive tally is fail-*closed* for every algorithm
   *   except `'none'` (RFC-MACP-0012 §4.1, adopted in spec PR #99).
   *
   * Defaults to `2` to keep existing callers' semantics unchanged -- a
   * deliberate default, not an oversight, kept in byte-parity with
   * `macp-sdk-python`'s own `schema_version: int = 2`. Pass `3` explicitly
   * to opt into fail-closed empty tallies. This is descriptor metadata, not
   * a rule: it is never part of the serialized `rules` JSON.
   */
  schemaVersion?: 1 | 2 | 3;
}

export function buildDecisionPolicy(
  policyId: string,
  description: string,
  rules: DecisionPolicyRulesInput,
  options?: DecisionPolicyOptions,
): PolicyDescriptor {
  const schemaVersion = options?.schemaVersion ?? 2;
  if (!DECISION_SCHEMA_VERSIONS.has(schemaVersion)) {
    throw new MacpSessionError(
      `schemaVersion must be one of ${[...DECISION_SCHEMA_VERSIONS].sort().join(', ')}, got '${schemaVersion}'`,
    );
  }

  const algorithm = rules.voting?.algorithm ?? 'none';
  const threshold = rules.voting?.threshold ?? 0.5;
  const weights = rules.voting?.weights;

  // Match decision-rules.schema.json's constraints before the runtime does,
  // same rationale as buildQuorumPolicy's threshold checks above: a bad
  // descriptor fails immediately client-side instead of round-tripping to an
  // INVALID_POLICY_DEFINITION from RegisterPolicy. Order matters and mirrors
  // macp-sdk-python policy.py:148-180: algorithm enum, then threshold range,
  // then the majority/supermajority asymmetry, then weighted-requires-weights,
  // then the electorate rule (unconditional across every algorithm).
  if (!DECISION_ALGORITHMS.has(algorithm)) {
    throw new MacpSessionError(
      `voting algorithm must be one of ${[...DECISION_ALGORITHMS].sort().join(', ')}, got '${algorithm}'`,
    );
  }
  if (!(threshold > 0 && threshold <= 1)) {
    throw new MacpSessionError(`voting threshold must be > 0 and <= 1, got ${threshold}`);
  }
  if (algorithm === 'majority' && threshold < 0.5) {
    throw new MacpSessionError(`'majority' requires threshold >= 0.5 (an even split approves), got ${threshold}`);
  }
  // Deliberately asymmetric with the 'majority' check above: policy.std.majority
  // sets threshold exactly 0.5 and RFC-MACP-0012 §2.2 pins that reserved profile
  // byte-identical on every runtime, so an exclusive >= 0.5 bound here would
  // refuse a profile the runtime pre-registers at startup. Do not "fix" this.
  if (algorithm === 'supermajority' && threshold <= 0.5) {
    throw new MacpSessionError(
      "'supermajority' requires threshold > 0.5 -- the field's own default of 0.5 is a bare majority " +
        `wearing the name, got ${threshold}. Pass an explicit threshold (e.g. 0.67) for supermajority.`,
    );
  }
  if (algorithm === 'weighted' && (!weights || Object.keys(weights).length === 0)) {
    throw new MacpSessionError("'weighted' algorithm requires a non-empty 'weights' map");
  }
  // The weighted electorate is meaningful only when non-empty and strictly
  // positive-valued -- enforced unconditionally, at every algorithm, not only
  // 'weighted' (decision-rules.schema.json: voting.weights minProperties 1,
  // additionalProperties.exclusiveMinimum 0; normative at every schema_version).
  // A weight-0 participant is expressed by omission from this map, never by an
  // explicit 0. `weights !== undefined`, not a truthy check: `{}` is truthy.
  if (weights !== undefined) {
    if (Object.keys(weights).length === 0) {
      throw new MacpSessionError("'weights', if provided, must be non-empty");
    }
    for (const [participant, weight] of Object.entries(weights)) {
      // weight <= 0 alone would let a NaN weight slip through (NaN <= 0 is
      // false); the runtime guards this explicitly (registry.rs:596), mirrored
      // here even though the Python reference does not check it separately.
      if (weight <= 0 || Number.isNaN(weight)) {
        throw new MacpSessionError(
          `weights['${participant}'] must be > 0, got ${weight} -- a weight-0 observer is expressed by ` +
            'omission from the map, not by an explicit 0',
        );
      }
    }
  }

  // Decision-only: extend the shared v1 commitment rules with the schema_version 2
  // decline-over-approval switch, appended after the shared keys so it does not
  // leak into the still-v1 quorum/proposal/task/handoff commitment blocks
  // (parity with python-sdk `_commitment_dict` + `build_decision_policy`).
  const commitmentSection = serializeCommitment(rules.commitment);
  commitmentSection.allow_decline_over_approval = rules.commitment?.allowDeclineOverApproval ?? false;

  const rulesJson: Record<string, unknown> = {
    voting: {
      algorithm,
      threshold,
      quorum: rules.voting?.quorum ? { type: rules.voting.quorum.type, value: rules.voting.quorum.value } : undefined,
      weights,
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
    schemaVersion,
  };
}

export function buildQuorumPolicy(
  policyId: string,
  description: string,
  rules: QuorumPolicyRulesInput,
): PolicyDescriptor {
  const threshold = rules.threshold;
  if (threshold) {
    // Match the canonical quorum-rules schema's constraints before the runtime
    // does, so a bad descriptor fails immediately client-side instead of
    // round-tripping to an INVALID_POLICY_DEFINITION from RegisterPolicy.
    // Order matters: integer first (a float reaching the range checks below
    // would compare fine numerically but produce a confusing message), then
    // > 0, then the percentage-specific <= 100 cap, then type. Mirrors
    // macp-sdk-python policy.py:278-310.
    //
    // Number.isInteger(true) is false in TS, so unlike Python's
    // isinstance(True, int) trap (policy.py:285-287), no separate bool guard
    // is needed here.
    if (!Number.isInteger(threshold.value)) {
      throw new MacpSessionError(
        `quorum threshold value must be an integer (e.g. 75 for 75%), got ${threshold.value}. ` +
          "The canonical quorum-rules schema declares 'value' as an integer for every threshold " +
          'type; a fractional value like 0.75 would produce a schema-invalid descriptor that the ' +
          'runtime rejects at RegisterPolicy with worse diagnostics.',
      );
    }
    if (threshold.value <= 0) {
      throw new MacpSessionError(
        `quorum threshold value must be > 0, got ${threshold.value}. A zero approval bar is ` +
          'trivially satisfied by any ballot set, so the canonical quorum-rules schema declares ' +
          "'value' with exclusiveMinimum 0.",
      );
    }
    if (threshold.type === 'percentage' && threshold.value > 100) {
      throw new MacpSessionError(`quorum threshold value must be 1-100 for type 'percentage', got ${threshold.value}`);
    }
    if (threshold.type !== 'n_of_m' && threshold.type !== 'percentage') {
      throw new MacpSessionError(
        `quorum threshold type must be 'n_of_m' or 'percentage', got ${JSON.stringify(threshold.type)}. ` +
          "'weighted' is reserved -- it was removed from the canonical schema without ever having " +
          'defined semantics and must not be used.',
      );
    }
  }
  const rulesJson: Record<string, unknown> = {
    threshold: {
      type: rules.threshold?.type ?? 'n_of_m',
      value: rules.threshold?.value ?? 1,
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
