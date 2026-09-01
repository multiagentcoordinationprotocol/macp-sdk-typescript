import { describe, it, expect, beforeEach } from 'vitest';
import { HandoffProjection } from '../../../src/projections/handoff';
import { ProtoRegistry } from '../../../src/proto-registry';
import { buildEnvelope } from '../../../src/envelope';
import { MODE_HANDOFF } from '../../../src/constants';

const registry = new ProtoRegistry();

function makeEnvelope(messageType: string, payload: Record<string, unknown>, sender = 'coordinator') {
  return buildEnvelope({
    mode: MODE_HANDOFF,
    messageType,
    sessionId: 'test-session',
    sender,
    payload: registry.encodeKnownPayload(MODE_HANDOFF, messageType, payload),
  });
}

describe('HandoffProjection', () => {
  let projection: HandoffProjection;

  beforeEach(() => {
    projection = new HandoffProjection();
  });

  it('starts in Pending phase', () => {
    expect(projection.phase).toBe('Pending');
  });

  it('tracks handoff offers and transitions to OfferPending phase', () => {
    projection.applyEnvelope(
      makeEnvelope('HandoffOffer', { handoffId: 'h1', targetParticipant: 'bob', scope: 'frontend', reason: 'busy' }),
      registry,
    );
    expect(projection.handoffs.size).toBe(1);
    expect(projection.getHandoff('h1')).toMatchObject({
      handoffId: 'h1',
      targetParticipant: 'bob',
      scope: 'frontend',
      status: 'offered',
    });
    expect(projection.phase).toBe('OfferPending');
  });

  it('tracks context sharing', () => {
    projection.applyEnvelope(
      makeEnvelope('HandoffOffer', { handoffId: 'h1', targetParticipant: 'bob', scope: 'frontend' }),
      registry,
    );
    projection.applyEnvelope(
      makeEnvelope('HandoffContext', { handoffId: 'h1', contentType: 'application/json' }),
      registry,
    );
    expect(projection.getHandoff('h1')?.status).toBe('context_sent');
    expect(projection.getHandoff('h1')?.contextContentType).toBe('application/json');
    expect(projection.phase).toBe('ContextSharing');
  });

  it('tracks acceptance', () => {
    projection.applyEnvelope(
      makeEnvelope('HandoffOffer', { handoffId: 'h1', targetParticipant: 'bob', scope: 'frontend' }),
      registry,
    );
    projection.applyEnvelope(makeEnvelope('HandoffAccept', { handoffId: 'h1', acceptedBy: 'bob' }, 'bob'), registry);
    expect(projection.isAccepted('h1')).toBe(true);
    expect(projection.getHandoff('h1')?.acceptedBy).toBe('bob');
    expect(projection.phase).toBe('Accepted');
  });

  it('marks an explicit accept as not implicit', () => {
    projection.applyEnvelope(
      makeEnvelope('HandoffOffer', { handoffId: 'h1', targetParticipant: 'bob', scope: 'frontend' }),
      registry,
    );
    projection.applyEnvelope(makeEnvelope('HandoffAccept', { handoffId: 'h1', acceptedBy: 'bob' }, 'bob'), registry);
    expect(projection.getHandoff('h1')?.implicit).toBe(false);
    expect(projection.isImplicitlyAccepted('h1')).toBe(false);
  });

  it('carries the implicit flag from a runtime-emitted synthetic accept', () => {
    // Future-proofing for RFC-MACP-0010 §5.1: the runtime timer will emit a
    // synthetic accept where sender = target participant, messageId =
    // `implicit-accept:<handoff_id>`, and implicit = true. Projections are
    // sender-agnostic, so this replays cleanly today even though v0.5.0 does
    // not yet emit it.
    projection.applyEnvelope(
      makeEnvelope('HandoffOffer', { handoffId: 'h1', targetParticipant: 'bob', scope: 'frontend' }),
      registry,
    );
    const synthetic = buildEnvelope({
      mode: MODE_HANDOFF,
      messageType: 'HandoffAccept',
      sessionId: 'test-session',
      sender: 'bob',
      messageId: 'implicit-accept:h1',
      payload: registry.encodeKnownPayload(MODE_HANDOFF, 'HandoffAccept', {
        handoffId: 'h1',
        acceptedBy: 'bob',
        implicit: true,
      }),
    });
    projection.applyEnvelope(synthetic, registry);
    expect(projection.isAccepted('h1')).toBe(true);
    expect(projection.getHandoff('h1')?.acceptedBy).toBe('bob');
    expect(projection.getHandoff('h1')?.implicit).toBe(true);
    expect(projection.isImplicitlyAccepted('h1')).toBe(true);
  });

  // RFC-MACP-0010 §5 rule 4 (`:68`) + §5.1(4) (`:113-116`): once a
  // handoff_id has been accepted, a competing decline is invalid.
  it('settle-once: a decline after an accept does not overwrite status', () => {
    projection.applyEnvelope(
      makeEnvelope('HandoffOffer', { handoffId: 'h1', targetParticipant: 'bob', scope: 'frontend' }),
      registry,
    );
    projection.applyEnvelope(makeEnvelope('HandoffAccept', { handoffId: 'h1', acceptedBy: 'bob' }, 'bob'), registry);
    projection.applyEnvelope(
      makeEnvelope('HandoffDecline', { handoffId: 'h1', declinedBy: 'bob', reason: 'too late' }, 'bob'),
      registry,
    );

    expect(projection.getHandoff('h1')?.status).toBe('accepted');
    expect(projection.isAccepted('h1')).toBe(true);
    expect(projection.isDeclined('h1')).toBe(false);
    expect(projection.phase).toBe('Accepted');
  });

  // Symmetric direction: once declined, a competing accept is invalid too.
  it('settle-once: an accept after a decline does not overwrite status', () => {
    projection.applyEnvelope(
      makeEnvelope('HandoffOffer', { handoffId: 'h1', targetParticipant: 'bob', scope: 'frontend' }),
      registry,
    );
    projection.applyEnvelope(
      makeEnvelope('HandoffDecline', { handoffId: 'h1', declinedBy: 'bob', reason: 'no capacity' }, 'bob'),
      registry,
    );
    projection.applyEnvelope(makeEnvelope('HandoffAccept', { handoffId: 'h1', acceptedBy: 'bob' }, 'bob'), registry);

    expect(projection.getHandoff('h1')?.status).toBe('declined');
    expect(projection.isDeclined('h1')).toBe(true);
    expect(projection.isAccepted('h1')).toBe(false);
    expect(projection.phase).toBe('Declined');
  });

  // Old (wrong) behaviour: both HandoffAccept and HandoffDecline overwrote
  // `status` unconditionally, so a later contradictory message flipped an
  // already-settled handoff (Phase 3, site 9 — a shipped violation).
  it('does not let a later contradictory message flip an already-settled handoff', () => {
    projection.applyEnvelope(
      makeEnvelope('HandoffOffer', { handoffId: 'h1', targetParticipant: 'bob', scope: 'frontend' }),
      registry,
    );
    projection.applyEnvelope(makeEnvelope('HandoffAccept', { handoffId: 'h1', acceptedBy: 'bob' }, 'bob'), registry);
    projection.applyEnvelope(
      makeEnvelope('HandoffDecline', { handoffId: 'h1', declinedBy: 'bob', reason: 'too late' }, 'bob'),
      registry,
    );

    expect(projection.getHandoff('h1')?.status).not.toBe('declined');
  });

  // RFC-MACP-0010 §5 rule 2: HandoffDecline MUST reference an existing
  // handoff_id. A decline for a never-offered handoff_id is invalid input
  // (e.g. an unfiltered transcript) and must not mutate `phase` — even
  // though `h1` is already settled to 'accepted'.
  it('does not let a decline for an unknown handoff_id mutate phase', () => {
    projection.applyEnvelope(
      makeEnvelope('HandoffOffer', { handoffId: 'h1', targetParticipant: 'bob', scope: 'frontend' }),
      registry,
    );
    projection.applyEnvelope(makeEnvelope('HandoffAccept', { handoffId: 'h1', acceptedBy: 'bob' }, 'bob'), registry);
    expect(projection.phase).toBe('Accepted');

    projection.applyEnvelope(
      makeEnvelope('HandoffDecline', { handoffId: 'ghost', declinedBy: 'bob', reason: 'never offered' }, 'bob'),
      registry,
    );

    expect(projection.getHandoff('h1')?.status).toBe('accepted');
    expect(projection.getHandoff('ghost')).toBeUndefined();
    expect(projection.phase).toBe('Accepted');
  });

  it('tracks decline', () => {
    projection.applyEnvelope(
      makeEnvelope('HandoffOffer', { handoffId: 'h1', targetParticipant: 'bob', scope: 'frontend' }),
      registry,
    );
    projection.applyEnvelope(
      makeEnvelope('HandoffDecline', { handoffId: 'h1', declinedBy: 'bob', reason: 'no capacity' }, 'bob'),
      registry,
    );
    expect(projection.isDeclined('h1')).toBe(true);
    expect(projection.phase).toBe('Declined');
  });

  it('pendingHandoffs filters correctly', () => {
    projection.applyEnvelope(
      makeEnvelope('HandoffOffer', { handoffId: 'h1', targetParticipant: 'bob', scope: 'a' }),
      registry,
    );
    projection.applyEnvelope(
      makeEnvelope('HandoffOffer', { handoffId: 'h2', targetParticipant: 'carol', scope: 'b' }),
      registry,
    );
    projection.applyEnvelope(makeEnvelope('HandoffAccept', { handoffId: 'h1', acceptedBy: 'bob' }, 'bob'), registry);

    const pending = projection.pendingHandoffs();
    expect(pending).toHaveLength(1);
    expect(pending[0].handoffId).toBe('h2');
  });

  it('commitment transitions to Committed', () => {
    projection.applyEnvelope(
      makeEnvelope('Commitment', {
        commitmentId: 'c1',
        action: 'handoff.accepted',
        authorityScope: 'team',
        reason: 'transferred',
        modeVersion: '1.0.0',
        configurationVersion: 'config.default',
      }),
      registry,
    );
    expect(projection.phase).toBe('Committed');
    expect(projection.commitment).toBeDefined();
  });

  it('hasAcceptedOffer returns true when an offer is accepted', () => {
    projection.applyEnvelope(
      makeEnvelope('HandoffOffer', { handoffId: 'h1', targetParticipant: 'bob', scope: 'frontend' }),
      registry,
    );
    expect(projection.hasAcceptedOffer()).toBe(false);
    projection.applyEnvelope(makeEnvelope('HandoffAccept', { handoffId: 'h1', acceptedBy: 'bob' }, 'bob'), registry);
    expect(projection.hasAcceptedOffer()).toBe(true);
    expect(projection.hasAcceptedOffer('h1')).toBe(true);
    expect(projection.hasAcceptedOffer('h-other')).toBe(false);
  });

  it('context after accept does not overwrite accepted status', () => {
    projection.applyEnvelope(
      makeEnvelope('HandoffOffer', { handoffId: 'h1', targetParticipant: 'bob', scope: 'frontend' }),
      registry,
    );
    projection.applyEnvelope(makeEnvelope('HandoffAccept', { handoffId: 'h1', acceptedBy: 'bob' }, 'bob'), registry);
    expect(projection.getHandoff('h1')?.status).toBe('accepted');

    // Per RFC-MACP-0010 §2.1: HandoffContext after accept is supplementary docs
    projection.applyEnvelope(
      makeEnvelope('HandoffContext', { handoffId: 'h1', contentType: 'text/plain' }, 'coordinator'),
      registry,
    );
    expect(projection.getHandoff('h1')?.status).toBe('accepted');
    expect(projection.getHandoff('h1')?.contextContentType).toBe('text/plain');
  });
});
