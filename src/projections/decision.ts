import { MODE_DECISION } from '../constants';
import { BaseProjection } from './base';
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

export class DecisionProjection extends BaseProjection {
  protected readonly mode = MODE_DECISION;
  readonly proposals = new Map<string, DecisionProposalRecord>();
  readonly evaluations: DecisionEvaluationRecord[] = [];
  readonly objections: DecisionObjectionRecord[] = [];
  readonly votes = new Map<string, Map<string, DecisionVoteRecord>>();
  phase: 'Proposal' | 'Evaluation' | 'Voting' | 'Committed' = 'Proposal';

  /** Handle a Decision-mode envelope. See `BaseProjection.applyEnvelope` for the accepted-only input contract and redelivery/rollback semantics shared by all built-in modes. */
  protected applyMode(envelope: Envelope, protoRegistry: ProtoRegistry): void {
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
          this.recordAnomaly({
            kind: 'duplicate_vote',
            mode: envelope.mode,
            messageType: envelope.messageType,
            messageId: envelope.messageId,
            sender: envelope.sender,
            subjectId: record.proposalId,
            detail: `sender ${envelope.sender} already voted '${kept.vote}' on proposal ${record.proposalId}; discarded '${record.vote}'`,
          });
          break;
        }
        bySender.set(envelope.sender, { ...record, sender: envelope.sender });
        this.votes.set(record.proposalId, bySender);
        // RFC-MACP-0001 §7.2 (`:218`): RESOLVED is terminal and sessions
        // MUST transition monotonically w.r.t. termination — never back to
        // OPEN/SUSPENDED. §7.3 (`:240`, restated `:249`) says a conforming
        // runtime rejects any session-scoped message once the session is
        // non-OPEN, so a `Vote` cannot legally follow a `Commitment` in
        // accepted history. If one reaches here anyway (the caller violated
        // the accepted-only contract — see `applyEnvelope`'s docblock), do
        // not regress `phase` out of `'Committed'`. Note "phase" itself is
        // not a normative MACP term (it appears once, in passing, at
        // RFC-MACP-0012 `:211`); this guard is justified by session
        // terminality, not by a phase specification. An anomaly would be
        // recorded here too, but `ProjectionAnomalyKind` (`base.ts:8-9`) is
        // deliberately frozen pending cross-SDK agreement with
        // macp-sdk-python.
        if (this.phase !== 'Committed') {
          this.phase = 'Voting';
        }
        break;
      }
      default:
        break;
    }
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
