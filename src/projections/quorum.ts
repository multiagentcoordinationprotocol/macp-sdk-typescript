import { MODE_QUORUM } from '../constants';
import { BaseProjection } from './base';
import type { Envelope } from '../types';
import type { ProtoRegistry } from '../proto-registry';

export interface ApprovalRequestRecord {
  requestId: string;
  action: string;
  summary: string;
  requiredApprovals: number;
  sender: string;
}

export interface BallotRecord {
  requestId: string;
  vote: 'approve' | 'reject' | 'abstain';
  reason?: string;
  sender: string;
}

export class QuorumProjection extends BaseProjection {
  protected readonly mode = MODE_QUORUM;
  readonly requests = new Map<string, ApprovalRequestRecord>();
  readonly ballots = new Map<string, Map<string, BallotRecord>>();
  phase: 'Pending' | 'Voting' | 'Committed' = 'Pending';

  /** Handle a Quorum-mode envelope. See `BaseProjection.applyEnvelope` for the accepted-only input contract and redelivery/rollback semantics shared by all built-in modes. */
  protected applyMode(envelope: Envelope, protoRegistry: ProtoRegistry): void {
    const payload = protoRegistry.decodeKnownPayload(envelope.mode, envelope.messageType, envelope.payload);
    switch (envelope.messageType) {
      case 'ApprovalRequest': {
        const record = payload as {
          requestId: string;
          action: string;
          summary: string;
          requiredApprovals: number;
        };
        this.requests.set(record.requestId, { ...record, sender: envelope.sender });
        this.phase = 'Voting';
        break;
      }
      case 'Approve': {
        const record = payload as { requestId: string; reason?: string };
        this.setBallot(envelope, record.requestId, 'approve', record.reason);
        break;
      }
      case 'Reject': {
        const record = payload as { requestId: string; reason?: string };
        this.setBallot(envelope, record.requestId, 'reject', record.reason);
        break;
      }
      case 'Abstain': {
        const record = payload as { requestId: string; reason?: string };
        this.setBallot(envelope, record.requestId, 'abstain', record.reason);
        break;
      }
      default:
        break;
    }
  }

  private setBallot(envelope: Envelope, requestId: string, vote: BallotRecord['vote'], reason?: string): void {
    const senderMap = this.ballots.get(requestId) ?? new Map<string, BallotRecord>();
    const kept = senderMap.get(envelope.sender);
    if (kept !== undefined) {
      // RFC-MACP-0011 §5 rule 3 (`:67`): participation is MAY (a participant need
      // not cast a ballot), but the cap of one ballot per participant ACROSS
      // Approve, Reject, and Abstain is enforced under §5's opening sentence,
      // "Implementations MUST enforce the following:" (`:63`). Do NOT phrase this
      // as "a participant MUST cast at most one ballot" — RFC-0011 puts the MUST
      // on the implementation, not the participant (contrast RFC-MACP-0007 §5.3,
      // which puts it directly on the participant; same obligation, different
      // addressee). A later ballot of a *different* type is still a duplicate,
      // not a change of vote, so this guard is keyed on the sender ALONE within
      // the request — never on sender + vote. macp-runtime enforces this
      // identically in all three arms (quorum.rs:164/184/204).
      // Keeping the sender's FIRST ballot (rather than the last) is not stated
      // by RFC-0011 either; it is parity with RFC-MACP-0007 §5 item 3's
      // explicit first-stands rule for `Vote`, plus macp-runtime's enforced
      // first-wins behaviour.
      this.recordAnomaly({
        kind: 'duplicate_ballot',
        mode: envelope.mode,
        messageType: envelope.messageType,
        messageId: envelope.messageId,
        sender: envelope.sender,
        subjectId: requestId,
        detail: `sender ${envelope.sender} already cast '${kept.vote}' on request ${requestId}; discarded '${vote}'`,
      });
      return;
    }
    senderMap.set(envelope.sender, { requestId, vote, reason, sender: envelope.sender });
    this.ballots.set(requestId, senderMap);
  }

  approvalCount(requestId: string): number {
    return this.countVotes(requestId, 'approve');
  }

  rejectionCount(requestId: string): number {
    return this.countVotes(requestId, 'reject');
  }

  abstentionCount(requestId: string): number {
    return this.countVotes(requestId, 'abstain');
  }

  hasQuorum(requestId: string): boolean {
    const req = this.requests.get(requestId);
    if (!req) return false;
    return this.approvalCount(requestId) >= req.requiredApprovals;
  }

  threshold(requestId: string): number {
    return this.requests.get(requestId)?.requiredApprovals ?? 0;
  }

  votedSenders(requestId: string): string[] {
    const senderMap = this.ballots.get(requestId);
    return senderMap ? [...senderMap.keys()] : [];
  }

  remainingVotesNeeded(requestId: string): number {
    const req = this.requests.get(requestId);
    if (!req) return 0;
    return Math.max(0, req.requiredApprovals - this.approvalCount(requestId));
  }

  commitmentReady(requestId: string): boolean {
    return this.hasQuorum(requestId) && this.phase !== 'Committed';
  }

  isThresholdUnreachable(requestId: string, totalEligible: number): boolean {
    const req = this.requests.get(requestId);
    if (!req) return false;
    const remaining = totalEligible - this.votedSenders(requestId).length;
    return this.approvalCount(requestId) + remaining < req.requiredApprovals;
  }

  private countVotes(requestId: string, vote: BallotRecord['vote']): number {
    const senderMap = this.ballots.get(requestId);
    if (!senderMap) return 0;
    return [...senderMap.values()].filter((b) => b.vote === vote).length;
  }
}
