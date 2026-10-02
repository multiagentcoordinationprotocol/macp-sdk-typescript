import { afterEach, describe, expect, it, vi } from 'vitest';
import { Auth } from '../../src/auth';
import { BaseSession } from '../../src/base-session';
import { MacpClient } from '../../src/client';
import { BaseProjection } from '../../src/projections/base';
import type { ProtoRegistry } from '../../src/proto-registry';
import type { Envelope } from '../../src/types';

const EXT_MODE = 'ext.smoke.v1';

class SmokeProjection extends BaseProjection {
  protected readonly mode = EXT_MODE;
  readonly events: string[] = [];

  protected applyMode(envelope: Envelope, _registry: ProtoRegistry): void {
    this.events.push(envelope.messageType);
  }
}

/** Exposes the protected `setPhase` choke point directly, for Phase 1 of
 * plans/issue-150-154-fixes.md (issues #150/#153) — a synthetic subclass
 * distinct from `SmokeProjection` so these tests don't entangle with the
 * dispatcher/session wiring tests that class already serves. */
class PhaseExposingProjection extends BaseProjection {
  protected readonly mode = EXT_MODE;
  protected applyMode(): void {
    // no-op: phase is driven directly via setPhaseForTest below, not via envelopes
  }
  setPhaseForTest(phase: string): void {
    this.setPhase(phase);
  }
}

class SmokeSession extends BaseSession<SmokeProjection> {
  protected readonly mode = EXT_MODE;

  protected createProjection(): SmokeProjection {
    return new SmokeProjection();
  }
}

function makeClient(): MacpClient {
  return new MacpClient({
    address: '127.0.0.1:50051',
    secure: false,
    allowInsecure: true,
    auth: Auth.bearer('alice-token', { expectedSender: 'alice' }),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('BaseSession / BaseProjection extension point', () => {
  it('fills defaults and wires the subclass projection', () => {
    const session = new SmokeSession(makeClient());
    expect(session.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(session.modeVersion).toBe('1.0.0');
    expect(session.policyVersion).toBe('policy.default');
    expect(session.projection).toBeInstanceOf(SmokeProjection);
    expect(session.projection.isCommitted).toBe(false);
  });

  it('start() calls client.send with a SessionStart envelope in the custom mode', async () => {
    const client = makeClient();
    const sendSpy = vi.spyOn(client, 'send').mockResolvedValue({ ok: true, messageId: 'm1', sessionId: 'sid' });
    const session = new SmokeSession(client, { sessionId: '550e8400-e29b-41d4-a716-446655440000' });

    const ack = await session.start({
      intent: 'test',
      participants: ['alice', 'bob'],
      ttlMs: 30_000,
    });

    expect(ack.ok).toBe(true);
    expect(sendSpy).toHaveBeenCalledOnce();
    const [envelope] = sendSpy.mock.calls[0];
    expect((envelope as Envelope).mode).toBe(EXT_MODE);
    expect((envelope as Envelope).messageType).toBe('SessionStart');
    expect((envelope as Envelope).sessionId).toBe('550e8400-e29b-41d4-a716-446655440000');
  });

  it('commit() does not feed the projection when the runtime NACKs', async () => {
    const client = makeClient();
    vi.spyOn(client, 'send').mockResolvedValue({
      ok: false,
      error: { code: 'POLICY_DENIED', message: 'no' },
    });
    const session = new SmokeSession(client);
    const ack = await session.commit({ action: 'done', authorityScope: 'session', reason: 'smoke' });
    expect(ack.ok).toBe(false);
    expect(session.projection.isCommitted).toBe(false);
  });

  it('senderFor() enforces the auth.expectedSender guard', () => {
    const client = makeClient();
    const session = new SmokeSession(client);
    // Accessing the protected method via subclass in a one-off
    const leak = session as unknown as { senderFor: (s: string | undefined) => string };
    expect(() => leak.senderFor('mallory')).toThrow(/does not match/);
  });

  it('validates an explicit sessionId and keeps a valid one', () => {
    expect(() => new SmokeSession(makeClient(), { sessionId: 'not-a-uuid' })).toThrow();
    const session = new SmokeSession(makeClient(), { sessionId: '550e8400-e29b-41d4-a716-446655440000' });
    expect(session.sessionId).toBe('550e8400-e29b-41d4-a716-446655440000');
  });

  it('start() validates maxSuspendMs before hitting the wire', async () => {
    const client = makeClient();
    const sendSpy = vi.spyOn(client, 'send').mockResolvedValue({ ok: true });
    const session = new SmokeSession(client);

    await expect(
      session.start({ intent: 'test', participants: ['alice'], ttlMs: 30_000, maxSuspendMs: -1 }),
    ).rejects.toThrow();
    expect(sendSpy).not.toHaveBeenCalled();
  });

  // Issue #108.4/4d: start() now calls the full validateSessionStart, bringing
  // this extension point up to parity with the five built-in mode sessions
  // (which already validated all of this). Fails on old code: previously
  // start() only checked participant count + maxSuspendMs, so an
  // empty/duplicate participants, or an out-of-range ttlMs reached the wire
  // unvalidated. (Empty intent moved out of this table -- see below, issue
  // #124 item 3: it's now accepted, not rejected.)
  it.each([
    ['empty participants', { intent: 'test', participants: [], ttlMs: 30_000 }],
    ['duplicate participants', { intent: 'test', participants: ['alice', 'alice'], ttlMs: 30_000 }],
    ['ttlMs of 0', { intent: 'test', participants: ['alice'], ttlMs: 0 }],
    ['negative ttlMs', { intent: 'test', participants: ['alice'], ttlMs: -1 }],
  ] as const)('start() rejects %s before hitting the wire', async (_label, input) => {
    const client = makeClient();
    const sendSpy = vi.spyOn(client, 'send').mockResolvedValue({ ok: true });
    const session = new SmokeSession(client);

    await expect(session.start(input)).rejects.toThrow();
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('start() accepts an empty intent (issue #124 item 3 -- RFC-MACP-0001 §7.1: a runtime "MUST NOT reject a SessionStart solely because intent is empty")', async () => {
    const client = makeClient();
    const sendSpy = vi.spyOn(client, 'send').mockResolvedValue({ ok: true });
    const session = new SmokeSession(client);

    await expect(session.start({ intent: '', participants: ['alice'], ttlMs: 30_000 })).resolves.toMatchObject({
      ok: true,
    });
    expect(sendSpy).toHaveBeenCalledOnce();
  });

  it('commit() success feeds the projection: phase Committed, commitment decoded', async () => {
    const client = makeClient();
    vi.spyOn(client, 'send').mockResolvedValue({ ok: true });
    const session = new SmokeSession(client);

    // The real ProtoRegistry resolves Commitment via the core payload map for
    // unknown ext modes, so the projection decodes a real protobuf payload.
    await session.commit({ action: 'done', authorityScope: 'session', reason: 'smoke', outcomePositive: true });

    expect(session.projection.isCommitted).toBe(true);
    expect(session.projection.phase).toBe('Committed');
    expect(session.projection.commitment).toMatchObject({ action: 'done', reason: 'smoke' });
    expect(session.projection.isPositiveOutcome).toBe(true);
  });

  it('metadata()/cancel()/suspend()/resume() delegate to the client with the session id', async () => {
    const client = makeClient();
    const session = new SmokeSession(client);
    const getSpy = vi.spyOn(client, 'getSession').mockResolvedValue({ metadata: { sessionId: session.sessionId } });
    const cancelSpy = vi.spyOn(client, 'cancelSession').mockResolvedValue({ ok: true });
    const suspendSpy = vi.spyOn(client, 'suspendSession').mockResolvedValue({ ok: true });
    const resumeSpy = vi.spyOn(client, 'resumeSession').mockResolvedValue({ ok: true });

    await session.metadata();
    await session.cancel('done');
    await session.suspend('pausing');
    await session.resume('back');

    expect(getSpy).toHaveBeenCalledWith(session.sessionId, expect.any(Object));
    expect(cancelSpy).toHaveBeenCalledWith(session.sessionId, 'done', expect.any(Object));
    expect(suspendSpy).toHaveBeenCalledWith(session.sessionId, 'pausing', expect.any(Object));
    expect(resumeSpy).toHaveBeenCalledWith(session.sessionId, 'back', expect.any(Object));
  });

  it('openStream() forwards session auth to client.openStream', () => {
    const client = makeClient();
    const sentinel = {};
    const streamSpy = vi.spyOn(client, 'openStream').mockReturnValue(sentinel as ReturnType<MacpClient['openStream']>);
    const session = new SmokeSession(client);

    expect(session.openStream()).toBe(sentinel);
    expect(streamSpy).toHaveBeenCalledWith({ auth: undefined });
  });

  it('BaseProjection ignores envelopes from other modes (transcript untouched)', () => {
    const registry = new (class {
      decodeKnownPayload() {
        return {};
      }
    })() as unknown as ProtoRegistry;
    const projection = new SmokeProjection();
    projection.applyEnvelope(
      {
        macpVersion: '1.0',
        mode: 'macp.mode.decision.v1', // not EXT_MODE
        messageType: 'Proposal',
        messageId: 'm',
        sessionId: 's',
        sender: 'alice',
        timestampUnixMs: '1',
        payload: Buffer.alloc(0),
      },
      registry,
    );
    expect(projection.transcript).toHaveLength(0);
    expect(projection.events).toHaveLength(0);
  });

  // isPositiveOutcome branch table: undefined without commitment; defaults to
  // true when the field is absent; respects explicit false; accepts the
  // snake_case wire spelling.
  it.each([
    ['no commitment', undefined, undefined],
    ['field absent (proto3 default)', {}, true],
    ['explicit outcomePositive: false', { outcomePositive: false }, false],
    ['snake_case outcome_positive: false', { outcome_positive: false }, false],
    ['explicit outcomePositive: true', { outcomePositive: true }, true],
  ] as const)('BaseProjection.isPositiveOutcome — %s', (_label, commitment, expected) => {
    const projection = new SmokeProjection();
    if (commitment !== undefined) {
      (projection as { commitment?: Record<string, unknown> }).commitment = commitment as Record<string, unknown>;
    }
    expect(projection.isPositiveOutcome).toBe(expected);
  });

  // Issues #150/#153, plans/issue-150-154-fixes.md Phase 1: `setPhase` is the
  // shared choke point every mode subclass now routes phase writes through.
  describe('BaseProjection.setPhase', () => {
    it('assigns normally when not yet Committed', () => {
      const projection = new PhaseExposingProjection();
      projection.setPhaseForTest('Evaluation');
      expect(projection.phase).toBe('Evaluation');
    });

    it('no-ops once phase is Committed, regardless of what is requested next', () => {
      const projection = new PhaseExposingProjection();
      projection.setPhaseForTest('Committed');
      projection.setPhaseForTest('Evaluation');
      expect(projection.phase).toBe('Committed');
    });
  });
});
