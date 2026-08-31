import { MODE_QUORUM } from '../constants';
import { logger } from '../logging';
import type { ProjectionAnomaly } from './base';
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
  /**
   * Cardinality anomalies recorded while replaying this projection's accepted
   * transcript (e.g. a duplicate ballot across `Approve`/`Reject`/`Abstain`
   * from the same sender for the same `request_id`). See
   * `BaseProjection.anomalies` (`src/projections/base.ts`) for the canonical
   * description; duplicated here only as a one-line pointer.
   */
  readonly anomalies: ProjectionAnomaly[] = [];
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
      const anomaly: ProjectionAnomaly = {
        kind: 'duplicate_ballot',
        mode: envelope.mode,
        messageType: envelope.messageType,
        messageId: envelope.messageId,
        sender: envelope.sender,
        subjectId: requestId,
        detail: `sender ${envelope.sender} already cast '${kept.vote}' on request ${requestId}; discarded '${vote}'`,
      };
      this.anomalies.push(anomaly);
      logger.warn('projection anomaly', anomaly);
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
