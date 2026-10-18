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

/**
 * Optional policy override for the `QuorumProjection` readiness helpers.
 * `effectiveThreshold` is `effectiveQuorumThreshold()`'s result: a number
 * replaces the payload's `requiredApprovals`, `null` means unsatisfiable
 * (treated as an infinite bar), and omitting it keeps the payload value.
 */
export interface QuorumThresholdOptions {
  effectiveThreshold?: number | null;
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
        this.setPhase('Voting');
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
    // RFC-MACP-0011 §5 rule 3 (`rfcs/RFC-MACP-0011-quorum-mode.md:69`): a ballot
    // MUST reference the Session's accepted request_id. `applyEnvelope`'s input
    // contract is accepted-only (see accepted-only-contract.test.ts), not a
    // guarantee every field inside an accepted envelope is itself valid, so an
    // unfiltered/multi-session transcript could still carry a ballot for a
    // request_id this projection never saw an ApprovalRequest for. Without this
    // guard that would fabricate a `ballots` Map entry: votedSenders() and
    // approvalCount()/rejectionCount()/abstentionCount() would report on a
    // request that doesn't exist, and a second such ballot from the same sender
    // would fire a spurious duplicate_ballot anomaly against it (issue #121,
    // same bug shape as issue #119's proposal.ts/handoff.ts/decision.ts sites).
    if (!this.requests.has(requestId)) return;

    const senderMap = this.ballots.get(requestId) ?? new Map<string, BallotRecord>();
    const kept = senderMap.get(envelope.sender);
    if (kept !== undefined) {
      // RFC-MACP-0011 §5 rule 3 (`:69`, hardened by spec PR
      // multiagentcoordinationprotocol#85): "Each eligible participant MUST
      // cast at most one ballot per request_id... A runtime MUST reject a
      // second ballot from the same sender for the same request_id,
      // regardless of the type of either ballot; the first accepted ballot
      // stands." Participation itself is still MAY (a participant need not
      // ballot at all) — only the one-per-participant cap and first-wins
      // outcome are MUST. A later ballot of a *different* type is still a
      // duplicate, not a change of vote, so this guard is keyed on the
      // sender ALONE within the request — never on sender + vote.
      // macp-runtime enforces this identically in all three arms
      // (quorum.rs:164/184/204).
      //
      // Keeping the sender's FIRST ballot is now a direct rule-3 citation
      // (above), not an inference — before PR #85 hardened the rule, this
      // comment relied on parity with RFC-MACP-0007 §5 item 3's first-stands
      // rule for `Vote` plus macp-runtime's observed behavior, since RFC-0011
      // capped *how many* ballots without yet stating *which* stands.
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

  /**
   * The approval bar for `requestId`: the policy override when one is passed,
   * else the payload's `requiredApprovals`. `null` (an unsatisfiable override,
   * see `effectiveQuorumThreshold`) is an infinite bar. `undefined` for an
   * unknown request.
   */
  private required(requestId: string, options?: QuorumThresholdOptions): number | undefined {
    const req = this.requests.get(requestId);
    if (!req) return undefined;
    const override = options?.effectiveThreshold;
    if (override === undefined) return req.requiredApprovals;
    return override === null ? Infinity : override;
  }

  /**
   * True once the approval count reaches the bar. Pass `{ effectiveThreshold }`
   * (from `effectiveQuorumThreshold`) when a bound policy's `threshold`
   * overrides `requiredApprovals` (runtime ≥ 0.9.0, RFC-MACP-0011 §5 rule 6).
   */
  hasQuorum(requestId: string, options?: QuorumThresholdOptions): boolean {
    const required = this.required(requestId, options);
    if (required === undefined) return false;
    return this.approvalCount(requestId) >= required;
  }

  /** The approval bar, or 0 if the request is unknown. `Infinity` for an unsatisfiable override. */
  threshold(requestId: string, options?: QuorumThresholdOptions): number {
    return this.required(requestId, options) ?? 0;
  }

  votedSenders(requestId: string): string[] {
    const senderMap = this.ballots.get(requestId);
    return senderMap ? [...senderMap.keys()] : [];
  }

  remainingVotesNeeded(requestId: string, options?: QuorumThresholdOptions): number {
    const required = this.required(requestId, options);
    if (required === undefined) return 0;
    return Math.max(0, required - this.approvalCount(requestId));
  }

  commitmentReady(requestId: string, options?: QuorumThresholdOptions): boolean {
    return this.hasQuorum(requestId, options) && this.phase !== 'Committed';
  }

  /**
   * True if the remaining possible approvals cannot reach the bar. Under a
   * policy `threshold` override above the participant count (runtime ≥ 0.9.0)
   * this is true before any ballot — pass `{ effectiveThreshold }` to see it.
   */
  isThresholdUnreachable(requestId: string, totalEligible: number, options?: QuorumThresholdOptions): boolean {
    const required = this.required(requestId, options);
    if (required === undefined) return false;
    const remaining = totalEligible - this.votedSenders(requestId).length;
    return this.approvalCount(requestId) + remaining < required;
  }

  private countVotes(requestId: string, vote: BallotRecord['vote']): number {
    const senderMap = this.ballots.get(requestId);
    if (!senderMap) return 0;
    return [...senderMap.values()].filter((b) => b.vote === vote).length;
  }
}
