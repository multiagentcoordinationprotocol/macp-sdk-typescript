import { MODE_HANDOFF } from '../constants';
import type { Envelope } from '../types';
import type { ProtoRegistry } from '../proto-registry';

export interface HandoffRecord {
  handoffId: string;
  targetParticipant: string;
  scope: string;
  reason?: string;
  sender: string;
  status: 'offered' | 'context_sent' | 'accepted' | 'declined';
  contextContentType?: string;
  acceptedBy?: string;
  declinedBy?: string;
  /**
   * `true` when the accept that resolved this handoff was a runtime-emitted
   * synthetic implicit accept (RFC-MACP-0010 §5.1, proto ≥ 0.1.6). `false` for
   * an explicit target accept. Only meaningful once `status === 'accepted'`.
   */
  implicit?: boolean;
}

export class HandoffProjection {
  readonly handoffs = new Map<string, HandoffRecord>();
  readonly transcript: Envelope[] = [];
  phase: 'Pending' | 'OfferPending' | 'ContextSharing' | 'Accepted' | 'Declined' | 'Committed' = 'Pending';
  commitment?: Record<string, unknown>;

  applyEnvelope(envelope: Envelope, protoRegistry: ProtoRegistry): void {
    if (envelope.mode !== MODE_HANDOFF) return;
    this.transcript.push(envelope);
    const payload = protoRegistry.decodeKnownPayload(envelope.mode, envelope.messageType, envelope.payload);
    switch (envelope.messageType) {
      case 'HandoffOffer': {
        const record = payload as { handoffId: string; targetParticipant: string; scope: string; reason?: string };
        this.handoffs.set(record.handoffId, {
          handoffId: record.handoffId,
          targetParticipant: record.targetParticipant,
          scope: record.scope,
          reason: record.reason,
          sender: envelope.sender,
          status: 'offered',
        });
        this.phase = 'OfferPending';
        break;
      }
      case 'HandoffContext': {
        const record = payload as { handoffId: string; contentType: string };
        const handoff = this.handoffs.get(record.handoffId);
        if (handoff) {
          // Per RFC-MACP-0010 §2.1: context after accept is permitted as supplementary docs.
          // Only update status if not already accepted/declined.
          if (handoff.status === 'offered') {
            handoff.status = 'context_sent';
          }
          handoff.contextContentType = record.contentType;
        }
        if (this.phase === 'OfferPending') this.phase = 'ContextSharing';
        break;
      }
      case 'HandoffAccept': {
        const record = payload as { handoffId: string; acceptedBy: string; implicit?: boolean };
        const handoff = this.handoffs.get(record.handoffId);
        if (handoff) {
          handoff.status = 'accepted';
          handoff.acceptedBy = record.acceptedBy;
          // proto3 bool defaults are materialized to `false` on decode
          // (proto-registry), so this is always a real boolean once proto 0.1.6
          // is loaded — `true` marks a runtime synthetic implicit accept.
          handoff.implicit = record.implicit ?? false;
        }
        this.phase = 'Accepted';
        break;
      }
      case 'HandoffDecline': {
        const record = payload as { handoffId: string; declinedBy: string };
        const handoff = this.handoffs.get(record.handoffId);
        if (handoff) {
          handoff.status = 'declined';
          handoff.declinedBy = record.declinedBy;
        }
        this.phase = 'Declined';
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

  getHandoff(handoffId: string): HandoffRecord | undefined {
    return this.handoffs.get(handoffId);
  }

  isAccepted(handoffId: string): boolean {
    return this.handoffs.get(handoffId)?.status === 'accepted';
  }

  isDeclined(handoffId: string): boolean {
    return this.handoffs.get(handoffId)?.status === 'declined';
  }

  /**
   * `true` when the handoff was resolved by a runtime-emitted synthetic implicit
   * accept (RFC-MACP-0010 §5.1) rather than an explicit target accept. Returns
   * `false` for explicitly-accepted or not-yet-accepted handoffs.
   */
  isImplicitlyAccepted(handoffId: string): boolean {
    const handoff = this.handoffs.get(handoffId);
    return handoff?.status === 'accepted' && handoff.implicit === true;
  }

  pendingHandoffs(): HandoffRecord[] {
    return [...this.handoffs.values()].filter((h) => h.status === 'offered' || h.status === 'context_sent');
  }

  hasAcceptedOffer(handoffId?: string): boolean {
    if (handoffId) return this.handoffs.get(handoffId)?.status === 'accepted';
    return [...this.handoffs.values()].some((h) => h.status === 'accepted');
  }

  activeOffer(): HandoffRecord | undefined {
    const all = [...this.handoffs.values()];
    for (let i = all.length - 1; i >= 0; i--) {
      const record = all[i];
      if (record && (record.status === 'offered' || record.status === 'context_sent')) {
        return record;
      }
    }
    return undefined;
  }
}
