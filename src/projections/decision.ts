import { MODE_DECISION } from '../constants';
import { logger } from '../logging';
import type { ProjectionAnomaly } from './base';
import type { Envelope } from '../types';
import type { ProtoRegistry } from '../proto-registry';

export interface DecisionProposalRecord {
  proposalId: string;
  option: string;
  rationale?: string;
  sender: string;
}

export interface DecisionEvaluationRecord {
  proposalId: string;
  recommendation: string;
  confidence: number;
  reason?: string;
  sender: string;
}

export interface DecisionObjectionRecord {
  proposalId: string;
  reason: string;
  severity: string;
  sender: string;
}

export interface DecisionVoteRecord {
  proposalId: string;
  vote: string;
  reason?: string;
  sender: string;
}

export class DecisionProjection {
  readonly proposals = new Map<string, DecisionProposalRecord>();
  readonly evaluations: DecisionEvaluationRecord[] = [];
  readonly objections: DecisionObjectionRecord[] = [];
  readonly votes = new Map<string, Map<string, DecisionVoteRecord>>();
  /**
   * The session's accepted history, one envelope per unique `message_id`. See
   * `BaseProjection.transcript` (`src/projections/base.ts`) for the full
   * redelivery-idempotence contract (RFC-MACP-0006 §3.2); duplicated here
   * only as a one-line pointer.
   */
  readonly transcript: Envelope[] = [];
  /**
   * Cardinality anomalies recorded while replaying this projection's accepted
   * transcript (e.g. a duplicate `Vote` from the same sender for the same
   * `proposal_id`). See `BaseProjection.anomalies` (`src/projections/base.ts`)
   * for the canonical description; duplicated here only as a one-line
   * pointer.
   */
  readonly anomalies: ProjectionAnomaly[] = [];
  phase: 'Proposal' | 'Evaluation' | 'Voting' | 'Committed' = 'Proposal';
  commitment?: Record<string, unknown>;
  /**
   * `message_id`s already applied to this projection. See
   * `BaseProjection.seenMessageIds` (`src/projections/base.ts`) for the full
   * redelivery-idempotence rationale (RFC-MACP-0006 §3.2); duplicated here
   * only as a one-line pointer.
   */
  private readonly seenMessageIds = new Set<string>();

  /**
   * Apply one envelope to this projection's in-process state.
   *
   * Input contract: **accepted-only**, caller-maintained (`Envelope` carries
   * no acceptance marker). Canonical source: `schemas/conformance/README.md`
   * "Notes:", RFC-MACP-0007 §5.3, RFC-MACP-0011 §5. Full rationale and failure
   * mode are documented once, on `BaseProjection.applyEnvelope`
   * (`src/projections/base.ts`), and duplicated here only as a one-line
   * pointer so six independent copies of the same prose cannot drift.
   *
   * Redelivery idempotence: a redelivered envelope (same `message_id`) is a
   * non-event — not appended to `transcript`, not passed to the `switch`.
   * See `BaseProjection.applyEnvelope` for the full RFC-MACP-0006 §3.2
   * citation; duplicated here only as a one-line pointer.
   */
  applyEnvelope(envelope: Envelope, protoRegistry: ProtoRegistry): void {
    if (envelope.mode !== MODE_DECISION) return;
    if (envelope.messageId) {
      if (this.seenMessageIds.has(envelope.messageId)) {
        logger.debug('projection redelivery ignored', {
          messageId: envelope.messageId,
          mode: envelope.mode,
          messageType: envelope.messageType,
        });
        return;
      }
      this.seenMessageIds.add(envelope.messageId);
    }
    this.transcript.push(envelope);
    const payload = protoRegistry.decodeKnownPayload(envelope.mode, envelope.messageType, envelope.payload);
    switch (envelope.messageType) {
      case 'Proposal': {
        const record = payload as { proposalId: string; option: string; rationale?: string };
        this.proposals.set(record.proposalId, {
          proposalId: record.proposalId,
          option: record.option,
          rationale: record.rationale,
          sender: envelope.sender,
        });
        this.phase = 'Evaluation';
        break;
      }
      case 'Evaluation': {
        const record = payload as { proposalId: string; recommendation: string; confidence: number; reason?: string };
        this.evaluations.push({ ...record, sender: envelope.sender });
        break;
      }
      case 'Objection': {
        const record = payload as { proposalId: string; reason: string; severity?: string };
        this.objections.push({ ...record, severity: record.severity ?? 'medium', sender: envelope.sender });
        break;
      }
      case 'Vote': {
        const record = payload as { proposalId: string; vote: string; reason?: string };
        const bySender = this.votes.get(record.proposalId) ?? new Map<string, DecisionVoteRecord>();
        const kept = bySender.get(envelope.sender);
        if (kept !== undefined) {
          // RFC-MACP-0007 §5 item 3: the first accepted Vote stands. A conforming
          // runtime NACKs the duplicate (macp-runtime decision.rs), so reaching
          // here means the transcript was not filtered to a conforming
          // runtime's accepted history.
          const anomaly: ProjectionAnomaly = {
            kind: 'duplicate_vote',
            mode: envelope.mode,
            messageType: envelope.messageType,
            messageId: envelope.messageId,
            sender: envelope.sender,
            subjectId: record.proposalId,
            detail: `sender ${envelope.sender} already voted '${kept.vote}' on proposal ${record.proposalId}; discarded '${record.vote}'`,
          };
          this.anomalies.push(anomaly);
          logger.warn('projection anomaly', anomaly);
          break;
        }
        bySender.set(envelope.sender, { ...record, sender: envelope.sender });
        this.votes.set(record.proposalId, bySender);
        // RFC-MACP-0001 §7.2 (`:216`): RESOLVED is terminal and sessions
        // MUST transition monotonically w.r.t. termination — never back to
        // OPEN/SUSPENDED. §7.3 (`:238`, restated `:247`) says a conforming
        // runtime rejects any session-scoped message once the session is
        // non-OPEN, so a `Vote` cannot legally follow a `Commitment` in
        // accepted history. If one reaches here anyway (the caller violated
        // the accepted-only contract — see `applyEnvelope`'s docblock), do
        // not regress `phase` out of `'Committed'`. Note "phase" itself is
        // not a normative MACP term (it appears once, in passing, at
        // RFC-MACP-0012 `:211`); this guard is justified by session
        // terminality, not by a phase specification.
        if (this.phase !== 'Committed') {
          this.phase = 'Voting';
        }
        break;
      }
      case 'Commitment': {
        this.commitment = payload;
        this.phase = 'Committed';
        break;
      }
      default:
        break;
    }
  }

  /**
   * True once at least one `ProjectionAnomaly` has been recorded. See
   * `BaseProjection.hasAnomalies` (`src/projections/base.ts`) for the
   * canonical description; duplicated here only as a one-line pointer.
   */
  get hasAnomalies(): boolean {
    return this.anomalies.length > 0;
  }

  get isCommitted(): boolean {
    return this.commitment !== undefined;
  }

  get isPositiveOutcome(): boolean | undefined {
    if (!this.commitment) return undefined;
    const val =
      (this.commitment as Record<string, unknown>).outcomePositive ??
      (this.commitment as Record<string, unknown>).outcome_positive;
    return val !== undefined ? Boolean(val) : true;
  }

  voteTotals(): Record<string, number> {
    const totals: Record<string, number> = {};
    for (const [proposalId, senderVotes] of this.votes.entries()) {
      totals[proposalId] = [...senderVotes.values()].filter((item) => isPositiveVote(item.vote)).length;
    }
    return totals;
  }

  majorityWinner(): string | undefined {
    const totals = this.voteTotals();
    const entries = Object.entries(totals);
    if (!entries.length) return undefined;
    // Count total non-abstain votes across all proposals
    let nonAbstain = 0;
    for (const senderVotes of this.votes.values()) {
      for (const vote of senderVotes.values()) {
        if (vote.vote.toUpperCase() !== 'ABSTAIN') {
          nonAbstain++;
        }
      }
    }
    if (nonAbstain === 0) return undefined;
    for (const [proposalId, count] of entries) {
      if (count / nonAbstain > 0.5) return proposalId;
    }
    return undefined;
  }

  /** Returns the APPROVE vote ratio excluding ABSTAIN votes from the denominator. */
  voteRatio(proposalId: string): number {
    const senderVotes = this.votes.get(proposalId);
    if (!senderVotes) return 0;
    const votes = [...senderVotes.values()];
    const nonAbstain = votes.filter((v) => v.vote.toUpperCase() !== 'ABSTAIN');
    if (nonAbstain.length === 0) return 0;
    const approvals = nonAbstain.filter((v) => isPositiveVote(v.vote)).length;
    return approvals / nonAbstain.length;
  }

  /** Only critical-severity objections are blocking per RFC-MACP-0004. */
  hasBlockingObjection(proposalId?: string): boolean {
    if (proposalId !== undefined) {
      return this.objections.some(
        (item) => item.proposalId === proposalId && item.severity.toLowerCase() === 'critical',
      );
    }
    return this.objections.some((item) => item.severity.toLowerCase() === 'critical');
  }

  /** Evaluations with REVIEW recommendation (informational only). */
  reviewEvaluations(): DecisionEvaluationRecord[] {
    return this.evaluations.filter((e) => e.recommendation.toUpperCase() === 'REVIEW');
  }

  /** Evaluations excluding REVIEW (qualifying evaluations). */
  qualifyingEvaluations(): DecisionEvaluationRecord[] {
    return this.evaluations.filter((e) => e.recommendation.toUpperCase() !== 'REVIEW');
  }
}

function isPositiveVote(vote: string): boolean {
  const normalized = vote.trim().toUpperCase();
  return (
    normalized === 'APPROVE' ||
    normalized === 'APPROVED' ||
    normalized === 'YES' ||
    normalized === 'ACCEPT' ||
    normalized === 'ACCEPTED'
  );
}
