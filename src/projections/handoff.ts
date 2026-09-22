import { MODE_HANDOFF } from '../constants';
import { BaseProjection } from './base';
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

export class HandoffProjection extends BaseProjection {
  protected readonly mode = MODE_HANDOFF;
  readonly handoffs = new Map<string, HandoffRecord>();
  phase: 'Pending' | 'OfferPending' | 'ContextSharing' | 'Accepted' | 'Declined' | 'Committed' = 'Pending';

  /** Handle a Handoff-mode envelope. See `BaseProjection.applyEnvelope` for the accepted-only input contract and redelivery/rollback semantics shared by all built-in modes. */
  protected applyMode(envelope: Envelope, protoRegistry: ProtoRegistry): void {
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
        if (!handoff) {
          // RFC-MACP-0010 §5 rule 2 (`:65`): "HandoffContext, HandoffAccept,
          // and HandoffDecline MUST reference an existing handoff_id." An
          // accept for an unknown/never-offered handoff_id is invalid input
          // (e.g. an unfiltered transcript) and MUST NOT mutate `phase` or
          // fabricate a handoff record. An anomaly would be recorded here,
          // but `ProjectionAnomalyKind` (`base.ts:8-9`) is deliberately
          // frozen pending cross-SDK agreement with macp-sdk-python.
          break;
        }
        // RFC-MACP-0010 §5 rule 4 (`:68`): "Once an offer has been
        // accepted, no competing accept for that same `handoff_id` is
        // valid." §5.1(4) (`:113-116`) settles the decline-after-accept
        // direction too: a `handoff_id` transitions
        // offered -> accepted | declined exactly once. Only settle if this
        // handoff hasn't already resolved — the same shape as the
        // HandoffContext guard just above. An anomaly would be recorded when
        // this guard discards a competing accept, but `ProjectionAnomalyKind`
        // (`base.ts:8-9`) is deliberately frozen pending cross-SDK agreement
        // with macp-sdk-python.
        if (handoff.status === 'offered' || handoff.status === 'context_sent') {
          handoff.status = 'accepted';
          handoff.acceptedBy = record.acceptedBy;
          // proto3 bool defaults are materialized to `false` on decode
          // (proto-registry), so this is always a real boolean once proto 0.1.6
          // is loaded — `true` marks a runtime synthetic implicit accept.
          handoff.implicit = record.implicit ?? false;
          this.phase = 'Accepted';
        }
        break;
      }
      case 'HandoffDecline': {
        const record = payload as { handoffId: string; declinedBy: string };
        const handoff = this.handoffs.get(record.handoffId);
        if (!handoff) {
          // RFC-MACP-0010 §5 rule 2 (`:65`): "HandoffContext, HandoffAccept,
          // and HandoffDecline MUST reference an existing handoff_id." A
          // decline for an unknown/never-offered handoff_id is invalid input
          // (e.g. an unfiltered transcript) and MUST NOT mutate `phase` or
          // fabricate a handoff record. An anomaly would be recorded here,
          // but `ProjectionAnomalyKind` (`base.ts:8-9`) is deliberately
          // frozen pending cross-SDK agreement with macp-sdk-python.
          break;
        }
        // RFC-MACP-0010 §5 rule 4 (`:68`) + §5.1(4) (`:113-116`): a
        // `handoff_id` settles once. A decline after the handoff already
        // settled (accepted or declined) is invalid and ignored. An anomaly
        // would be recorded here too, but `ProjectionAnomalyKind`
        // (`base.ts:8-9`) is deliberately frozen pending cross-SDK agreement
        // with macp-sdk-python.
        if (handoff.status === 'offered' || handoff.status === 'context_sent') {
          handoff.status = 'declined';
          handoff.declinedBy = record.declinedBy;
          this.phase = 'Declined';
        }
        break;
      }
      default:
        break;
    }
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
