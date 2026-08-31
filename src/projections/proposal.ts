import { MODE_PROPOSAL } from '../constants';
import { logger } from '../logging';
import type { Envelope } from '../types';
import type { ProtoRegistry } from '../proto-registry';

export interface ProposalRecord {
  proposalId: string;
  title: string;
  summary?: string;
  tags?: string[];
  sender: string;
  supersedes?: string;
  status: 'open' | 'accepted' | 'rejected' | 'withdrawn';
}

export interface ProposalAcceptRecord {
  proposalId: string;
  reason?: string;
  sender: string;
}

export interface ProposalRejectRecord {
  proposalId: string;
  terminal: boolean;
  reason?: string;
  sender: string;
}

export class ProposalProjection {
  readonly proposals = new Map<string, ProposalRecord>();
  readonly accepts: ProposalAcceptRecord[] = [];
  readonly rejections: ProposalRejectRecord[] = [];
  /**
   * The session's accepted history, one envelope per unique `message_id`. See
   * `BaseProjection.transcript` (`src/projections/base.ts`) for the full
   * redelivery-idempotence contract (RFC-MACP-0006 §3.2); duplicated here
   * only as a one-line pointer.
   */
  readonly transcript: Envelope[] = [];
  phase: 'Negotiating' | 'TerminalRejected' | 'Committed' = 'Negotiating';
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
    if (envelope.mode !== MODE_PROPOSAL) return;
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
        const record = payload as { proposalId: string; title: string; summary?: string; tags?: string[] };
        this.proposals.set(record.proposalId, {
          proposalId: record.proposalId,
          title: record.title,
          summary: record.summary,
          tags: record.tags,
          sender: envelope.sender,
          status: 'open',
        });
        break;
      }
      case 'CounterProposal': {
        const record = payload as {
          proposalId: string;
          supersedesProposalId: string;
          title: string;
          summary?: string;
        };
        this.proposals.set(record.proposalId, {
          proposalId: record.proposalId,
          title: record.title,
          summary: record.summary,
          sender: envelope.sender,
          supersedes: record.supersedesProposalId,
          status: 'open',
        });
        break;
      }
      case 'Accept': {
        const record = payload as { proposalId: string; reason?: string };
        this.accepts.push({ ...record, sender: envelope.sender });
        break;
      }
      case 'Reject': {
        const record = payload as { proposalId: string; terminal?: boolean; reason?: string };
        const terminal = record.terminal ?? false;
        this.rejections.push({
          proposalId: record.proposalId,
          terminal,
          reason: record.reason,
          sender: envelope.sender,
        });
        if (terminal) {
          const proposal = this.proposals.get(record.proposalId);
          if (proposal) proposal.status = 'rejected';
          this.phase = 'TerminalRejected';
        }
        break;
      }
      case 'Withdraw': {
        const record = payload as { proposalId: string };
        const proposal = this.proposals.get(record.proposalId);
        if (proposal) proposal.status = 'withdrawn';
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

  activeProposals(): ProposalRecord[] {
    return [...this.proposals.values()].filter((p) => p.status === 'open');
  }

  latestProposal(): ProposalRecord | undefined {
    const all = [...this.proposals.values()];
    return all[all.length - 1];
  }

  isAccepted(proposalId: string): boolean {
    return this.accepts.some((a) => a.proposalId === proposalId);
  }

  isTerminallyRejected(proposalId: string): boolean {
    return this.rejections.some((r) => r.proposalId === proposalId && r.terminal);
  }

  liveProposals(): Map<string, ProposalRecord> {
    const result = new Map<string, ProposalRecord>();
    for (const [id, p] of this.proposals) {
      if (p.status !== 'withdrawn') result.set(id, p);
    }
    return result;
  }

  acceptedProposal(): string | undefined {
    if (this.accepts.length === 0) return undefined;
    const ids = new Set(this.accepts.map((a) => a.proposalId));
    if (ids.size === 1) return ids.values().next().value;
    return undefined;
  }

  hasTerminalRejection(): boolean {
    return this.rejections.some((r) => r.terminal);
  }
}
