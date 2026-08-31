import { MODE_QUORUM } from '../constants';
import { logger } from '../logging';
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

export class QuorumProjection {
  readonly requests = new Map<string, ApprovalRequestRecord>();
  readonly ballots = new Map<string, Map<string, BallotRecord>>();
  /**
   * The session's accepted history, one envelope per unique `message_id`. See
   * `BaseProjection.transcript` (`src/projections/base.ts`) for the full
   * redelivery-idempotence contract (RFC-MACP-0006 §3.2); duplicated here
   * only as a one-line pointer.
   */
  readonly transcript: Envelope[] = [];
  phase: 'Pending' | 'Voting' | 'Committed' = 'Pending';
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
    if (envelope.mode !== MODE_QUORUM) return;
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
        this.setBallot(record.requestId, envelope.sender, 'approve', record.reason);
        break;
      }
      case 'Reject': {
        const record = payload as { requestId: string; reason?: string };
        this.setBallot(record.requestId, envelope.sender, 'reject', record.reason);
        break;
      }
      case 'Abstain': {
        const record = payload as { requestId: string; reason?: string };
        this.setBallot(record.requestId, envelope.sender, 'abstain', record.reason);
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

  private setBallot(requestId: string, sender: string, vote: BallotRecord['vote'], reason?: string): void {
    const senderMap = this.ballots.get(requestId) ?? new Map<string, BallotRecord>();
    senderMap.set(sender, { requestId, vote, reason, sender });
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
