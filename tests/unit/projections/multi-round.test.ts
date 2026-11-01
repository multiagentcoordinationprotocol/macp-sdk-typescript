/**
 * MultiRoundProjection against the ext.multi_round.v1 semantics (spec #241,
 * multi_round.proto) and macp-runtime's multi_round.rs. The test names match
 * macp-sdk-python's tests/test_multi_round.py.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { MultiRoundProjection } from '../../../src/projections/multi-round';
import { ProtoRegistry } from '../../../src/proto-registry';
import { buildEnvelope } from '../../../src/envelope';
import { MODE_MULTI_ROUND } from '../../../src/constants';

const registry = new ProtoRegistry();
const PARTICIPANTS = ['agent://alice', 'agent://bob'];

function start(participants = PARTICIPANTS, sender = 'agent://coordinator') {
  return buildEnvelope({
    mode: MODE_MULTI_ROUND,
    messageType: 'SessionStart',
    sessionId: 's1',
    sender,
    payload: registry.encodeKnownPayload(MODE_MULTI_ROUND, 'SessionStart', {
      intent: 'converge',
      participants,
      modeVersion: '1.0.0',
      configurationVersion: 'cfg-1',
      ttlMs: 60_000,
    }),
  });
}

function contribute(sender: string, value: string) {
  return raw(sender, registry.encodeKnownPayload(MODE_MULTI_ROUND, 'Contribute', { value }));
}

function raw(sender: string, payload: Buffer) {
  return buildEnvelope({ mode: MODE_MULTI_ROUND, messageType: 'Contribute', sessionId: 's1', sender, payload });
}

describe('MultiRoundProjection', () => {
  let p: MultiRoundProjection;

  beforeEach(() => {
    p = new MultiRoundProjection();
    p.applyEnvelope(start(), registry);
  });

  it('learns participants and initiator from SessionStart', () => {
    expect(p.participants).toEqual(PARTICIPANTS);
    expect(p.initiator).toBe('agent://coordinator');
    expect(p.phase).toBe('Contributing');
    expect(p.pendingParticipants()).toEqual(PARTICIPANTS);
  });

  it('starts Pending, with nothing known', () => {
    const fresh = new MultiRoundProjection();
    expect([fresh.phase, fresh.round, fresh.converged, fresh.convergedValue, fresh.initiator]).toEqual([
      'Pending',
      0,
      false,
      undefined,
      undefined,
    ]);
    expect(fresh.participants).toEqual([]);
  });

  it('first contribution advances round', () => {
    p.applyEnvelope(contribute('agent://alice', 'option_a'), registry);
    expect(p.round).toBe(1);
    expect(p.contributions.get('agent://alice')).toBe('option_a');
    expect(p.converged).toBe(false);
  });

  it('same value does not advance', () => {
    p.applyEnvelope(contribute('agent://alice', 'option_a'), registry);
    p.applyEnvelope(contribute('agent://alice', 'option_a'), registry);
    expect(p.round).toBe(1);
    expect(p.transcript).toHaveLength(3); // still accepted history
  });

  it('changed value advances', () => {
    p.applyEnvelope(contribute('agent://alice', 'option_a'), registry);
    p.applyEnvelope(contribute('agent://alice', 'option_b'), registry);
    expect(p.round).toBe(2);
    expect(p.contributions.get('agent://alice')).toBe('option_b');
  });

  it('converges when all equal', () => {
    p.applyEnvelope(contribute('agent://alice', 'option_a'), registry);
    p.applyEnvelope(contribute('agent://bob', 'option_b'), registry);
    expect(p.converged).toBe(false);
    expect(p.pendingParticipants()).toEqual([]);
    p.applyEnvelope(contribute('agent://bob', 'option_a'), registry);
    expect([p.round, p.converged, p.convergedValue, p.phase]).toEqual([3, true, 'option_a', 'Converged']);
  });

  it('does not converge while a participant has not contributed', () => {
    p.applyEnvelope(contribute('agent://alice', 'option_a'), registry);
    expect(p.converged).toBe(false);
    expect(p.pendingParticipants()).toEqual(['agent://bob']);
  });

  it('convergence is sticky', () => {
    p.applyEnvelope(contribute('agent://alice', 'x'), registry);
    p.applyEnvelope(contribute('agent://bob', 'x'), registry);
    p.applyEnvelope(contribute('agent://bob', 'y'), registry);
    p.applyEnvelope(contribute('agent://alice', 'x'), registry);
    expect([p.round, p.converged, p.convergedValue]).toEqual([2, true, 'x']);
    expect(p.contributions.get('agent://bob')).toBe('x');
  });

  it('non participant contribution ignored', () => {
    p.applyEnvelope(contribute('agent://coordinator', 'option_a'), registry);
    expect(p.round).toBe(0);
    expect(p.contributions.size).toBe(0);
    expect(p.transcript).toHaveLength(2);
  });

  it.each([
    ['an empty payload', Buffer.alloc(0)],
    ['an empty proto value', registry.encodeKnownPayload(MODE_MULTI_ROUND, 'Contribute', { value: '' })],
    ['a legacy JSON value that is not a string', Buffer.from('{"value": 5}')],
    ['a legacy JSON object with no value', Buffer.from('{"other": "x"}')],
    ['bytes that are neither JSON nor protobuf', Buffer.from([0xff, 0xff, 0xff])],
  ])('ignores %s without a round change', (_name, payload) => {
    p.applyEnvelope(raw('agent://alice', payload), registry);
    expect(p.round).toBe(0);
    expect(p.contributions.size).toBe(0);
    expect(p.transcript).toHaveLength(2);
  });

  it('reads a legacy JSON contribution', () => {
    p.applyEnvelope(raw('agent://alice', Buffer.from('{"value":"option_a"}')), registry);
    expect(p.contributions.get('agent://alice')).toBe('option_a');
  });

  it('applies a redelivered Contribute once', () => {
    const envelope = contribute('agent://alice', 'option_a');
    p.applyEnvelope(envelope, registry);
    p.applyEnvelope(contribute('agent://alice', 'option_b'), registry);
    p.applyEnvelope(envelope, registry);
    expect(p.round).toBe(2);
    expect(p.contributions.get('agent://alice')).toBe('option_b');
  });

  it('is Committed after the Commitment, keeping the convergence', () => {
    p.applyEnvelope(contribute('agent://alice', 'x'), registry);
    p.applyEnvelope(contribute('agent://bob', 'x'), registry);
    p.applyEnvelope(
      buildEnvelope({
        mode: MODE_MULTI_ROUND,
        messageType: 'Commitment',
        sessionId: 's1',
        sender: 'agent://coordinator',
        payload: registry.encodeKnownPayload(MODE_MULTI_ROUND, 'Commitment', {
          commitmentId: 'c1',
          action: 'multi_round.converged',
          authorityScope: 'test',
          reason: 'done',
          modeVersion: '1.0.0',
          configurationVersion: 'cfg-1',
          outcomePositive: true,
        }),
      }),
      registry,
    );
    expect([p.phase, p.isCommitted, p.isPositiveOutcome, p.convergedValue]).toEqual(['Committed', true, true, 'x']);
  });

  it('ignores envelopes of another mode', () => {
    p.applyEnvelope({ ...contribute('agent://alice', 'x'), mode: 'macp.mode.decision.v1' }, registry);
    expect(p.transcript).toHaveLength(1);
  });
});

describe('MultiRoundProjection seeded without a SessionStart', () => {
  it('converges over the seeded participants', () => {
    const p = new MultiRoundProjection({ participants: PARTICIPANTS, initiator: 'agent://coordinator' });
    expect(p.initiator).toBe('agent://coordinator');
    p.applyEnvelope(contribute('agent://alice', 'v'), registry);
    p.applyEnvelope(contribute('agent://bob', 'v'), registry);
    expect([p.converged, p.convergedValue]).toEqual([true, 'v']);
  });

  it('copies the seeded participants', () => {
    const seed = [...PARTICIPANTS];
    const p = new MultiRoundProjection({ participants: seed });
    seed.push('agent://carol');
    expect(p.participants).toEqual(PARTICIPANTS);
  });

  it('tracks rounds but never converges with no participants known', () => {
    const p = new MultiRoundProjection();
    p.applyEnvelope(contribute('agent://alice', 'v'), registry);
    p.applyEnvelope(contribute('agent://zed', 'v'), registry);
    expect([p.round, p.converged, p.contributions.size]).toEqual([2, false, 2]);
  });

  it('a SessionStart with an empty sender keeps a known initiator', () => {
    const p = new MultiRoundProjection({ initiator: 'agent://coordinator' });
    p.applyEnvelope(start(PARTICIPANTS, ''), registry);
    expect([p.participants, p.initiator]).toEqual([PARTICIPANTS, 'agent://coordinator']);
  });

  it('a later SessionStart overwrites the seed', () => {
    const p = new MultiRoundProjection({ participants: ['agent://x'], initiator: 'agent://y' });
    p.applyEnvelope(start(PARTICIPANTS, 'agent://coordinator'), registry);
    expect([p.participants, p.initiator]).toEqual([PARTICIPANTS, 'agent://coordinator']);
  });
});
