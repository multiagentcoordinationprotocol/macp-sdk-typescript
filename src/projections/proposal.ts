import { MODE_PROPOSAL } from '../constants';
import { BaseProjection } from './base';
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

export class ProposalProjection extends BaseProjection {
  protected readonly mode = MODE_PROPOSAL;
  readonly proposals = new Map<string, ProposalRecord>();
  readonly accepts: ProposalAcceptRecord[] = [];
  readonly rejections: ProposalRejectRecord[] = [];
  /**
   * Each sender's current (unsuperseded) `Accept`, keyed by sender.
   * RFC-MACP-0008 §5 rule 5 (`:70`): "A participant MAY change its
   * acceptance target by sending a later `Accept` for a different live
   * proposal. The latest accepted `Accept` from a participant supersedes
   * earlier accepts from the same participant." `accepts` above retains the
   * full append-only history (including superseded accepts) for audit
   * purposes; `isAccepted` and `acceptedProposal` read from this map instead
   * so they reflect the live acceptance set — required for determinism by
   * §7 (`:89`): "Given the same accepted history and the same version-bound
   * rules, implementations MUST derive the same live proposal set, the same
   * acceptance set, and the same commitment eligibility."
   */
  private readonly latestAcceptBySender = new Map<string, ProposalAcceptRecord>();
  phase: 'Negotiating' | 'TerminalRejected' | 'Committed' = 'Negotiating';

  /** Handle a Proposal-mode envelope. See `BaseProjection.applyEnvelope` for the accepted-only input contract and redelivery/rollback semantics shared by all built-in modes. */
  protected applyMode(envelope: Envelope, protoRegistry: ProtoRegistry): void {
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
        const accept: ProposalAcceptRecord = { ...record, sender: envelope.sender };
        this.accepts.push(accept);
        // RFC-MACP-0008 §5 rule 5 (`:70`): this Accept supersedes any earlier
        // one from the same sender for the live acceptance set.
        this.latestAcceptBySender.set(envelope.sender, accept);
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
      default:
        break;
    }
  }

  activeProposals(): ProposalRecord[] {
    return [...this.proposals.values()].filter((p) => p.status === 'open');
  }

  latestProposal(): ProposalRecord | undefined {
    const all = [...this.proposals.values()];
    return all[all.length - 1];
  }

  /**
   * True if some participant's *current* (unsuperseded) `Accept` targets
   * `proposalId` — RFC-MACP-0008 §5 rule 5 (`:70`). Note this reads from the
   * live acceptance set, not from `accepts`' full history: a participant
   * whose only accept for `proposalId` was later superseded by a re-accept
   * of a different proposal is not counted.
   */
  isAccepted(proposalId: string): boolean {
    for (const accept of this.latestAcceptBySender.values()) {
      if (accept.proposalId === proposalId) return true;
    }
    return false;
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

  /**
   * The single proposal every participant's *current* accept targets, or
   * `undefined` if no one has an outstanding accept or outstanding accepts
   * are split across more than one proposal. Computed from the live
   * acceptance set (see `isAccepted`), not from `accepts`' full history — a
   * participant who accepts `p1` and later re-accepts `p2` (RFC-MACP-0008 §5
   * rule 5, `:70`) contributes only `p2`, so this correctly returns `p2`
   * rather than `undefined`.
   */
  acceptedProposal(): string | undefined {
    if (this.latestAcceptBySender.size === 0) return undefined;
    const ids = new Set([...this.latestAcceptBySender.values()].map((a) => a.proposalId));
    if (ids.size === 1) return ids.values().next().value;
    return undefined;
  }

  hasTerminalRejection(): boolean {
    return this.rejections.some((r) => r.terminal);
  }
}
