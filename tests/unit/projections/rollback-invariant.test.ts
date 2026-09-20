/**
 * Phase 1 of plans/sdk-parity-typescript.md (P0 -- live data-loss bug):
 * rollback invariant at all six `applyEnvelope` entry points.
 *
 * Every `applyEnvelope` implementation adds the envelope's `message_id` to
 * the redelivery-dedup set and pushes the envelope onto `transcript` BEFORE
 * the one fallible operation in the method: the protobuf payload decode. If
 * decode throws, those two mutations must be rolled back and the error
 * re-thrown -- otherwise a legitimate retry of the exact same `message_id`
 * is silently swallowed as a redelivery (the dedup guard at the top of the
 * method sees the id already present) and the envelope's effect is lost
 * forever, while `transcript` still claims a partial, un-decoded entry is
 * present. This mirrors `macp-sdk-python`'s `base_projection.py`
 * `apply_envelope` and its `test_projection_rollback_invariant.py`.
 *
 * Deliberately narrow scope, pinned by the last test below: only
 * `transcript` and the `message_id` dedup set are guaranteed rolled back.
 * Mode/subclass-owned state (`phase`, `votes`, `tasks`, a synthetic ext-mode
 * subclass's own fields, ...) is NOT rolled back. This is safe only because
 * every projection performs its one fallible operation (decode) strictly
 * before any state mutation, and record construction from an already-decoded
 * payload cannot throw.
 */
import { describe, expect, it } from 'vitest';
import { MODE_DECISION, MODE_HANDOFF, MODE_PROPOSAL, MODE_QUORUM, MODE_TASK } from '../../../src/constants';
import { buildEnvelope } from '../../../src/envelope';
import { ProtoRegistry } from '../../../src/proto-registry';
import { BaseProjection } from '../../../src/projections/base';
import { DecisionProjection } from '../../../src/projections/decision';
import { HandoffProjection } from '../../../src/projections/handoff';
import { ProposalProjection } from '../../../src/projections/proposal';
import { QuorumProjection } from '../../../src/projections/quorum';
import { TaskProjection } from '../../../src/projections/task';
import type { Envelope } from '../../../src/types';

const registry = new ProtoRegistry();

// A length-delimited field (tag 1, wire type 2) claiming a 15-byte value with
// zero bytes actually present. protobufjs's reader throws "index out of
// range" decoding this, regardless of which message type it's decoded as --
// empirically confirmed against the real `Commitment` type before this file
// was written.
const MALFORMED_PAYLOAD = Buffer.from([0x0a, 0x0f]);

function makeMalformedEnvelope(mode: string, messageType: string, messageId: string): Envelope {
  return buildEnvelope({
    mode,
    messageType,
    sessionId: 'test-session',
    sender: 'agent-a',
    messageId,
    payload: MALFORMED_PAYLOAD,
  });
}

function makeValidEnvelope(
  mode: string,
  messageType: string,
  payload: Record<string, unknown>,
  messageId: string,
): Envelope {
  return buildEnvelope({
    mode,
    messageType,
    sessionId: 'test-session',
    sender: 'agent-a',
    messageId,
    payload: registry.encodeKnownPayload(mode, messageType, payload),
  });
}

// ── The five mode projections ──────────────────────────────────────────────

const MODE_CASES = [
  {
    name: 'DecisionProjection',
    mode: MODE_DECISION,
    factory: () => new DecisionProjection(),
    messageType: 'Proposal',
    validPayload: { proposalId: 'p1', option: 'a' },
  },
  {
    name: 'ProposalProjection',
    mode: MODE_PROPOSAL,
    factory: () => new ProposalProjection(),
    messageType: 'Proposal',
    validPayload: { proposalId: 'p1', title: 'Plan A' },
  },
  {
    name: 'TaskProjection',
    mode: MODE_TASK,
    factory: () => new TaskProjection(),
    messageType: 'TaskRequest',
    validPayload: { taskId: 't1', title: 'Build feature', instructions: 'implement it' },
  },
  {
    name: 'HandoffProjection',
    mode: MODE_HANDOFF,
    factory: () => new HandoffProjection(),
    messageType: 'HandoffOffer',
    validPayload: { handoffId: 'h1', targetParticipant: 'bob', scope: 'frontend' },
  },
  {
    name: 'QuorumProjection',
    mode: MODE_QUORUM,
    factory: () => new QuorumProjection(),
    messageType: 'ApprovalRequest',
    validPayload: { requestId: 'r1', action: 'deploy', summary: 'deploy v2', requiredApprovals: 2 },
  },
] as const;

describe.each(MODE_CASES)(
  '$name — applyEnvelope rollback on failed decode',
  ({ mode, factory, messageType, validPayload }) => {
    it('a failed decode throws and leaves transcript unchanged', () => {
      const projection = factory();
      const envelope = makeMalformedEnvelope(mode, messageType, 'm1');

      expect(() => projection.applyEnvelope(envelope, registry)).toThrow();
      expect(projection.transcript).toHaveLength(0);
    });

    it('retrying the SAME envelope after a failed decode throws again (not silently swallowed)', () => {
      const projection = factory();
      const envelope = makeMalformedEnvelope(mode, messageType, 'm1');

      expect(() => projection.applyEnvelope(envelope, registry)).toThrow();
      expect(() => projection.applyEnvelope(envelope, registry)).toThrow();
      expect(projection.transcript).toHaveLength(0);
    });

    it('replacing the payload with a valid one under the SAME message_id succeeds — proves the id was released', () => {
      const projection = factory();
      const badEnvelope = makeMalformedEnvelope(mode, messageType, 'm1');
      expect(() => projection.applyEnvelope(badEnvelope, registry)).toThrow();

      const goodEnvelope = makeValidEnvelope(mode, messageType, validPayload, 'm1');
      expect(() => projection.applyEnvelope(goodEnvelope, registry)).not.toThrow();
      expect(projection.transcript).toHaveLength(1);
    });

    it('redelivering that successfully-applied envelope is still a no-op — dedup guard intact', () => {
      const projection = factory();
      const badEnvelope = makeMalformedEnvelope(mode, messageType, 'm1');
      expect(() => projection.applyEnvelope(badEnvelope, registry)).toThrow();

      const goodEnvelope = makeValidEnvelope(mode, messageType, validPayload, 'm1');
      projection.applyEnvelope(goodEnvelope, registry);
      projection.applyEnvelope(goodEnvelope, registry); // redelivery

      expect(projection.transcript).toHaveLength(1);
    });

    it('an empty message_id failed apply rolls back transcript with no dedup-set corruption', () => {
      const projection = factory();
      const envelope = makeMalformedEnvelope(mode, messageType, '');

      expect(() => projection.applyEnvelope(envelope, registry)).toThrow();
      expect(projection.transcript).toHaveLength(0);

      // Empty ids are never deduped — a second empty-id envelope (this time
      // valid) must apply normally, proving no phantom id was left in the set.
      const goodEnvelope = makeValidEnvelope(mode, messageType, validPayload, '');
      expect(() => projection.applyEnvelope(goodEnvelope, registry)).not.toThrow();
      expect(projection.transcript).toHaveLength(1);
    });
  },
);

// ── Seeded-state retention: prior good state survives a later failed apply ─

describe('seeded state survives a failed apply', () => {
  it('DecisionProjection retains a prior applied Vote across a failed apply', () => {
    const projection = new DecisionProjection();
    projection.applyEnvelope(
      makeValidEnvelope(MODE_DECISION, 'Proposal', { proposalId: 'p1', option: 'a' }, 'm-proposal'),
      registry,
    );
    projection.applyEnvelope(
      makeValidEnvelope(MODE_DECISION, 'Vote', { proposalId: 'p1', vote: 'approve' }, 'm-vote'),
      registry,
    );
    expect(projection.votes.get('p1')?.size).toBe(1);

    const badEnvelope = makeMalformedEnvelope(MODE_DECISION, 'Evaluation', 'm-bad');
    expect(() => projection.applyEnvelope(badEnvelope, registry)).toThrow();

    // Seeded state from before the failed apply is untouched.
    expect(projection.votes.get('p1')?.size).toBe(1);
    expect(projection.votes.get('p1')?.get('agent-a')?.vote).toBe('approve');
    // Only the two accepted envelopes remain — the failed one was rolled back.
    expect(projection.transcript).toHaveLength(2);
  });

  it('QuorumProjection retains a prior applied ballot across a failed apply', () => {
    const projection = new QuorumProjection();
    projection.applyEnvelope(
      makeValidEnvelope(
        MODE_QUORUM,
        'ApprovalRequest',
        { requestId: 'r1', action: 'deploy', summary: 'deploy v2', requiredApprovals: 2 },
        'm-req',
      ),
      registry,
    );
    projection.applyEnvelope(makeValidEnvelope(MODE_QUORUM, 'Approve', { requestId: 'r1' }, 'm-approve'), registry);
    expect(projection.approvalCount('r1')).toBe(1);

    const badEnvelope = makeMalformedEnvelope(MODE_QUORUM, 'Reject', 'm-bad');
    expect(() => projection.applyEnvelope(badEnvelope, registry)).toThrow();

    expect(projection.approvalCount('r1')).toBe(1);
    expect(projection.transcript).toHaveLength(2);
  });
});

// ── BaseProjection (the sixth entry point), via a synthetic third-party
// subclass — the five built-in mode projections do NOT extend it, so this is
// the only place BaseProjection.applyEnvelope's own rollback is exercised. ─

class SmokeProjection extends BaseProjection {
  protected readonly mode = MODE_DECISION;
  readonly events: string[] = [];
  throwOnApplyMode = false;

  protected applyMode(envelope: Envelope): void {
    if (this.throwOnApplyMode) {
      throw new Error('synthetic applyMode failure');
    }
    this.events.push(envelope.messageType);
  }
}

describe('BaseProjection rollback (sixth entry point)', () => {
  it('Commitment decode branch: a failed decode throws and rolls back transcript/dedup', () => {
    const projection = new SmokeProjection();
    const envelope = makeMalformedEnvelope(MODE_DECISION, 'Commitment', 'm1');

    expect(() => projection.applyEnvelope(envelope, registry)).toThrow();
    expect(projection.transcript).toHaveLength(0);
    expect(projection.isCommitted).toBe(false);

    // Same message_id, now with a valid Commitment payload, succeeds — the
    // id was released by the rollback, not left stuck in the dedup set.
    const goodEnvelope = makeValidEnvelope(MODE_DECISION, 'Commitment', { outcomePositive: true }, 'm1');
    expect(() => projection.applyEnvelope(goodEnvelope, registry)).not.toThrow();
    expect(projection.transcript).toHaveLength(1);
    expect(projection.isCommitted).toBe(true);
  });

  it('applyMode-throws branch: subclass failure rolls back transcript/dedup and re-throws', () => {
    const projection = new SmokeProjection();
    projection.throwOnApplyMode = true;
    const envelope = makeValidEnvelope(MODE_DECISION, 'Proposal', { proposalId: 'p1', option: 'a' }, 'm1');

    expect(() => projection.applyEnvelope(envelope, registry)).toThrow('synthetic applyMode failure');
    expect(projection.transcript).toHaveLength(0);
    expect(projection.events).toHaveLength(0);

    // Same message_id, applyMode no longer throwing, succeeds — the id was
    // released.
    projection.throwOnApplyMode = false;
    expect(() => projection.applyEnvelope(envelope, registry)).not.toThrow();
    expect(projection.transcript).toHaveLength(1);
    expect(projection.events).toEqual(['Proposal']);
  });

  it('narrow-scope pin: applyMode mutates its own state then throws — subclass state is NOT rolled back while transcript IS', () => {
    class PartialMutationProjection extends BaseProjection {
      protected readonly mode = MODE_DECISION;
      mutated = false;

      protected applyMode(): void {
        this.mutated = true;
        throw new Error('fails after mutating');
      }
    }
    const projection = new PartialMutationProjection();
    const envelope = makeValidEnvelope(MODE_DECISION, 'Proposal', { proposalId: 'p1', option: 'a' }, 'm1');

    expect(() => projection.applyEnvelope(envelope, registry)).toThrow('fails after mutating');

    // Subclass-owned state is deliberately NOT rolled back — only
    // `transcript` and the dedup set are guaranteed reverted.
    expect(projection.mutated).toBe(true);
    expect(projection.transcript).toHaveLength(0);
    // ...and because the dedup set WAS rolled back (not left stuck with a
    // phantom id), retrying the same message_id throws again from a clean
    // slate — the same failure, not "redelivery ignored" — rather than
    // silently swallowing the retry.
    expect(() => projection.applyEnvelope(envelope, registry)).toThrow('fails after mutating');
    expect(projection.transcript).toHaveLength(0);
  });
});
