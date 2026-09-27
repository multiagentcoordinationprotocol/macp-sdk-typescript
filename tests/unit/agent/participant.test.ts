import { afterEach, describe, it, expect, vi } from 'vitest';
import { startCancelCallbackServer } from '../../../src/agent/cancel-callback';
import { Participant, type ParticipantConfig, type InitiatorConfig } from '../../../src/agent/participant';
import type { TransportAdapter } from '../../../src/agent/transports';
import type { IncomingMessage } from '../../../src/agent/types';
import { MODE_DECISION, MODE_PROPOSAL, MODE_TASK, MODE_HANDOFF, MODE_QUORUM } from '../../../src/constants';
import { DecisionSession } from '../../../src/decision';
import { HandoffSession } from '../../../src/handoff';
import { ProposalSession } from '../../../src/proposal';
import { QuorumSession } from '../../../src/quorum';
import { TaskSession } from '../../../src/task';
import type { Envelope } from '../../../src/types';

// Mocked so the run() cancel-callback wiring can be asserted without binding a
// real HTTP server. Only tests that pass `cancelCallback` config touch it.
vi.mock('../../../src/agent/cancel-callback', () => ({
  startCancelCallbackServer: vi.fn(),
}));

function makeMockClient(): any {
  return {
    auth: { bearerToken: 'test-agent', senderHint: 'test-agent' },
    protoRegistry: {
      encodeKnownPayload: vi.fn(() => Buffer.alloc(0)),
      decodeKnownPayload: vi.fn(() => ({})),
    },
    send: vi.fn().mockResolvedValue({ ok: true }),
    openStream: vi.fn(),
    getSession: vi.fn(),
  };
}

function makeMockTransport(messages: IncomingMessage[]): TransportAdapter {
  let stopped = false;
  return {
    async *start() {
      for (const msg of messages) {
        if (stopped) break;
        yield msg;
      }
    },
    async stop() {
      stopped = true;
    },
  };
}

/**
 * A genuinely restartable transport, for the issue #106.3 restart tests.
 * `makeMockTransport` above latches `stopped` permanently and always
 * replays from index 0, so it cannot exercise "a second `run()` resumes
 * and delivers the remaining messages" — `run()`'s `finally` now always
 * calls `teardown()` -> `transport.stop()`, so a second `run()` against
 * that mock would yield nothing. This one tracks a cursor that only
 * advances once the consumer comes back for more (mirroring
 * `GrpcTransportAdapter`'s own #66 fix in `transports.ts`), so a `break`
 * mid-stream leaves the in-flight message uncounted for the next
 * `start()` call, and `stop()` is a no-op (nothing to wake — this mock has
 * no async suspension for `Participant`'s own `stopRequested` check to
 * unblock).
 */
function makeRestartableMockTransport(messages: IncomingMessage[]): TransportAdapter & { startCallCount: number } {
  let cursor = 0;
  const transport = {
    startCallCount: 0,
    async *start() {
      transport.startCallCount++;
      while (cursor < messages.length) {
        const msg = messages[cursor];
        yield msg;
        cursor++;
      }
    },
    async stop() {},
  };
  return transport;
}

// Each call mints a DISTINCT messageId. Before Phase 2's projection-level
// `message_id` dedup (see src/projections/base.ts), every envelope this
// helper built shared the hardcoded id 'msg-1' — harmless only because
// `processMessage` dispatches handlers AFTER applying to the projection, and
// every test here asserts handler calls, never projection state, so the
// (until-now theoretical) collision was invisible. Under dedup, two calls
// sharing one id would have the second silently dropped by the projection's
// redelivery guard. See the "dedup regression" test below for the case that
// would have caught it.
let nextMessageId = 0;

function makeIncomingMessage(messageType: string, payload: Record<string, unknown> = {}): IncomingMessage {
  nextMessageId += 1;
  return {
    messageType,
    sender: 'agent-a',
    payload,
    raw: {
      macpVersion: '1.0',
      mode: MODE_DECISION,
      messageType,
      messageId: `msg-${nextMessageId}`,
      sessionId: '550e8400-e29b-41d4-a716-446655440000',
      sender: 'agent-a',
      timestampUnixMs: String(Date.now()),
      payload: Buffer.alloc(0),
    },
    seq: 0,
  };
}

describe('Participant', () => {
  describe('construction', () => {
    it('creates with decision mode', () => {
      const client = makeMockClient();
      const participant = new Participant({
        participantId: 'agent-1',
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        mode: MODE_DECISION,
        client,
        transport: makeMockTransport([]),
      });

      expect(participant.participantId).toBe('agent-1');
      expect(participant.sessionId).toBe('550e8400-e29b-41d4-a716-446655440000');
      expect(participant.mode).toBe(MODE_DECISION);
      expect(participant.projection).toBeDefined();
      expect(participant.actions).toBeDefined();
    });

    it('creates with proposal mode', () => {
      const client = makeMockClient();
      const participant = new Participant({
        participantId: 'agent-1',
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        mode: MODE_PROPOSAL,
        client,
        transport: makeMockTransport([]),
      });
      expect(participant.mode).toBe(MODE_PROPOSAL);
    });

    it('creates with task mode', () => {
      const client = makeMockClient();
      const participant = new Participant({
        participantId: 'agent-1',
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        mode: MODE_TASK,
        client,
        transport: makeMockTransport([]),
      });
      expect(participant.mode).toBe(MODE_TASK);
    });

    it('creates with handoff mode', () => {
      const client = makeMockClient();
      const participant = new Participant({
        participantId: 'agent-1',
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        mode: MODE_HANDOFF,
        client,
        transport: makeMockTransport([]),
      });
      expect(participant.mode).toBe(MODE_HANDOFF);
    });

    it('creates with quorum mode', () => {
      const client = makeMockClient();
      const participant = new Participant({
        participantId: 'agent-1',
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        mode: MODE_QUORUM,
        client,
        transport: makeMockTransport([]),
      });
      expect(participant.mode).toBe(MODE_QUORUM);
    });

    it('creates with initiator config', () => {
      const client = makeMockClient();
      const initiator: InitiatorConfig = {
        sessionStart: {
          intent: 'decide deployment',
          participants: ['agent-1', 'agent-2'],
          ttlMs: 30000,
        },
        kickoff: {
          messageType: 'Proposal',
          payload: { proposalId: 'p1', option: 'canary' },
        },
      };
      const participant = new Participant({
        participantId: 'agent-1',
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        mode: MODE_DECISION,
        client,
        transport: makeMockTransport([]),
        initiator,
      });

      expect(participant.participantId).toBe('agent-1');
      expect(participant.mode).toBe(MODE_DECISION);
    });

    it('creates with unknown mode', () => {
      const client = makeMockClient();
      const participant = new Participant({
        participantId: 'agent-1',
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        mode: 'ext.custom.v1',
        client,
        transport: makeMockTransport([]),
      });
      expect(participant.mode).toBe('ext.custom.v1');
      expect(participant.projection).toBeDefined();
    });
  });

  describe('handler registration', () => {
    it('supports fluent API for on()', () => {
      const client = makeMockClient();
      const participant = new Participant({
        participantId: 'agent-1',
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        mode: MODE_DECISION,
        client,
        transport: makeMockTransport([]),
      });

      const result = participant.on('Proposal', vi.fn());
      expect(result).toBe(participant);
    });

    it('supports fluent API for onPhaseChange()', () => {
      const client = makeMockClient();
      const participant = new Participant({
        participantId: 'agent-1',
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        mode: MODE_DECISION,
        client,
        transport: makeMockTransport([]),
      });

      const result = participant.onPhaseChange('Voting', vi.fn());
      expect(result).toBe(participant);
    });

    it('supports fluent API for onTerminal()', () => {
      const client = makeMockClient();
      const participant = new Participant({
        participantId: 'agent-1',
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        mode: MODE_DECISION,
        client,
        transport: makeMockTransport([]),
      });

      const result = participant.onTerminal(vi.fn());
      expect(result).toBe(participant);
    });
  });

  describe('run()', () => {
    it('dispatches incoming messages to handlers', async () => {
      const client = makeMockClient();
      const handler = vi.fn();

      const messages = [makeIncomingMessage('Proposal', { proposalId: 'p1', option: 'opt-a' })];
      const transport = makeMockTransport(messages);

      const participant = new Participant({
        participantId: 'agent-1',
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        mode: MODE_DECISION,
        client,
        transport,
      });

      participant.on('Proposal', handler);
      await participant.run();

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ messageType: 'Proposal' }),
        expect.objectContaining({
          participant: expect.objectContaining({ participantId: 'agent-1' }),
          actions: expect.any(Object),
          session: expect.objectContaining({ sessionId: '550e8400-e29b-41d4-a716-446655440000' }),
        }),
      );
    });

    it('propagates participants and version config into SessionInfo', async () => {
      const client = makeMockClient();
      const handler = vi.fn();

      const messages = [makeIncomingMessage('Proposal', { proposalId: 'p1', option: 'opt-a' })];
      const transport = makeMockTransport(messages);

      const participant = new Participant({
        participantId: 'agent-1',
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        mode: MODE_DECISION,
        client,
        transport,
        participants: ['agent-1', 'agent-2', 'agent-3'],
        modeVersion: '1.2.0',
        configurationVersion: 'config.strict',
        policyVersion: 'policy.strict',
      });

      participant.on('Proposal', handler);
      await participant.run();

      expect(handler).toHaveBeenCalledOnce();
      const ctx = handler.mock.calls[0][1];
      expect(ctx.session).toEqual({
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        mode: MODE_DECISION,
        participants: ['agent-1', 'agent-2', 'agent-3'],
        modeVersion: '1.2.0',
        configurationVersion: 'config.strict',
        policyVersion: 'policy.strict',
      });
    });

    it('processes multiple messages', async () => {
      const client = makeMockClient();
      const proposalHandler = vi.fn();
      const evaluationHandler = vi.fn();

      const messages = [
        makeIncomingMessage('Proposal', { proposalId: 'p1', option: 'opt-a' }),
        makeIncomingMessage('Evaluation', { proposalId: 'p1', recommendation: 'approve', confidence: 0.9 }),
      ];
      const transport = makeMockTransport(messages);

      const participant = new Participant({
        participantId: 'agent-1',
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        mode: MODE_DECISION,
        client,
        transport,
      });

      participant.on('Proposal', proposalHandler);
      participant.on('Evaluation', evaluationHandler);
      await participant.run();

      expect(proposalHandler).toHaveBeenCalledOnce();
      expect(evaluationHandler).toHaveBeenCalledOnce();
    });

    // Dedup regression (see the `makeIncomingMessage` comment above): two
    // distinct envelopes that happen to share a message type must BOTH land
    // on the real projection instance the session applies to. Handler
    // dispatch assertions alone (as in 'processes multiple messages' above)
    // would not have caught a stale `makeIncomingMessage` still minting one
    // shared id — this asserts projection *state*, not just handler calls.
    it('two distinct envelopes both land on the projection (not silently deduped)', async () => {
      const client = makeMockClient();
      const messages = [
        makeIncomingMessage('Evaluation', { proposalId: 'p1', recommendation: 'approve', confidence: 0.9 }),
        makeIncomingMessage('Evaluation', { proposalId: 'p1', recommendation: 'reject', confidence: 0.4 }),
      ];
      const transport = makeMockTransport(messages);

      const participant = new Participant({
        participantId: 'agent-1',
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        mode: MODE_DECISION,
        client,
        transport,
      });

      await participant.run();

      const projection = participant.projection as unknown as { evaluations: unknown[] };
      expect(projection.evaluations).toHaveLength(2);
    });

    it('does not dispatch to unregistered handlers', async () => {
      const client = makeMockClient();
      const handler = vi.fn();

      const messages = [makeIncomingMessage('Vote')];
      const transport = makeMockTransport(messages);

      const participant = new Participant({
        participantId: 'agent-1',
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        mode: MODE_DECISION,
        client,
        transport,
      });

      participant.on('Proposal', handler);
      await participant.run();

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('stop()', () => {
    it('stops the transport', async () => {
      const client = makeMockClient();
      const transport = makeMockTransport([]);
      const stopSpy = vi.spyOn(transport, 'stop');

      const participant = new Participant({
        participantId: 'agent-1',
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        mode: MODE_DECISION,
        client,
        transport,
      });

      await participant.stop();
      expect(stopSpy).toHaveBeenCalledOnce();
    });
  });

  describe('actions', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    function makeParticipant(mode: string, client = makeMockClient()): Participant {
      return new Participant({
        participantId: 'agent-1',
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        mode,
        client,
        transport: makeMockTransport([]),
      });
    }

    it('decision mode exposes exactly the expected action set', () => {
      const participant = makeParticipant(MODE_DECISION);
      expect(Object.keys(participant.actions).sort()).toEqual([
        'commit',
        'evaluate',
        'propose',
        'raiseObjection',
        'send',
        'vote',
      ]);
    });

    it.each([
      ['evaluate', 'evaluate', { proposalId: 'p1', recommendation: 'APPROVE', confidence: 0.9 }],
      ['vote', 'vote', { proposalId: 'p1', vote: 'approve' }],
      ['raiseObjection', 'raiseObjection', { proposalId: 'p1', reason: 'unsafe' }],
      ['propose', 'propose', { proposalId: 'p1', option: 'go' }],
      ['commit', 'commit', { action: 'deploy', authorityScope: 'prod', reason: 'majority' }],
    ] as const)(
      'decision actions.%s delegates to the session with sender=participantId',
      async (action, method, input) => {
        const spy = vi.spyOn(DecisionSession.prototype, method).mockResolvedValue({ ok: true } as any);
        const participant = makeParticipant(MODE_DECISION);

        await (participant.actions[action] as (input: unknown) => Promise<void>)(input);

        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy.mock.calls[0]![0]).toMatchObject({ ...input, sender: 'agent-1' });
      },
    );

    it('proposal-mode actions.propose maps option→title and rationale→summary', async () => {
      const spy = vi.spyOn(ProposalSession.prototype, 'propose').mockResolvedValue({ ok: true } as any);
      const participant = makeParticipant(MODE_PROPOSAL);

      await participant.actions.propose!({ proposalId: 'p1', option: 'plan-b', rationale: 'cheaper' });

      expect(spy.mock.calls[0]![0]).toEqual({
        proposalId: 'p1',
        title: 'plan-b',
        summary: 'cheaper',
        sender: 'agent-1',
      });
    });

    it.each([
      [MODE_PROPOSAL, ProposalSession],
      [MODE_TASK, TaskSession],
      [MODE_HANDOFF, HandoffSession],
      [MODE_QUORUM, QuorumSession],
    ] as const)('%s wires actions.commit to the mode session', async (mode, SessionClass) => {
      const spy = vi.spyOn(SessionClass.prototype, 'commit').mockResolvedValue({ ok: true } as any);
      const participant = makeParticipant(mode);

      await participant.actions.commit!({ action: 'close', authorityScope: 'team', reason: 'done' });

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]![0]).toMatchObject({ action: 'close', sender: 'agent-1' });
    });

    it('actions.send builds an envelope via the proto registry and calls client.send', async () => {
      const client = makeMockClient();
      const participant = makeParticipant(MODE_DECISION, client);

      await participant.actions.send!('Vote', { proposalId: 'p1', vote: 'approve' });

      expect(client.protoRegistry.encodeKnownPayload).toHaveBeenCalledWith(MODE_DECISION, 'Vote', {
        proposalId: 'p1',
        vote: 'approve',
      });
      expect(client.send).toHaveBeenCalledTimes(1);
      const [envelope, options] = client.send.mock.calls[0];
      expect(envelope).toMatchObject({
        mode: MODE_DECISION,
        messageType: 'Vote',
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        sender: 'agent-1',
      });
      expect(options).toEqual({ auth: undefined });
    });

    it('an unknown ext mode gets only the generic send action', () => {
      const participant = makeParticipant('ext.custom.v1');
      expect(Object.keys(participant.actions)).toEqual(['send']);
    });
  });

  // ── emitInitiatorEnvelopes: SDK-TS-1 ─────────────────────────────
  //
  // The initiator path compiles `InitiatorConfig.sessionStart` into the
  // actual `DecisionSession.start(...)` call. Dropping `contextId` /
  // `extensions` here means the runtime never learns about upstream context
  // or extension metadata — which was the bug the control-plane projection
  // work (CP-16/17/18) is depending on. These tests pin the wiring.
  describe('emitInitiatorEnvelopes (initiator wiring)', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('forwards contextId and extensions to the mode session start', async () => {
      const client = makeMockClient();
      const startSpy = vi
        .spyOn(DecisionSession.prototype, 'start')
        .mockResolvedValue({ ok: true, envelopeId: 'env-1' } as any);

      const initiator: InitiatorConfig = {
        sessionStart: {
          intent: 'decide rollout',
          participants: ['agent-1', 'agent-2'],
          ttlMs: 30_000,
          contextId: 'ctx-parent-run-42',
          extensions: {
            'aitp.tct': Buffer.from('{"token":"t-1"}', 'utf8'),
          },
          roots: [{ uri: 'file:///workspace' }],
        },
      };

      const participant = new Participant({
        participantId: 'agent-1',
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        mode: MODE_DECISION,
        client,
        transport: makeMockTransport([]),
        initiator,
      });

      await participant.run();

      expect(startSpy).toHaveBeenCalledTimes(1);
      const arg = startSpy.mock.calls[0]![0];
      expect(arg).toMatchObject({
        intent: 'decide rollout',
        participants: ['agent-1', 'agent-2'],
        ttlMs: 30_000,
        contextId: 'ctx-parent-run-42',
        roots: [{ uri: 'file:///workspace' }],
      });
      expect(arg.extensions).toBeDefined();
      expect(arg.extensions!['aitp.tct']).toBeInstanceOf(Buffer);
      expect(arg.extensions!['aitp.tct']!.toString('utf8')).toBe('{"token":"t-1"}');
    });

    it('omits contextId and extensions when initiator does not supply them (backwards-compatible)', async () => {
      // Guards against accidentally requiring the fields or defaulting them
      // to empty values that the runtime would reject.
      const client = makeMockClient();
      const startSpy = vi
        .spyOn(DecisionSession.prototype, 'start')
        .mockResolvedValue({ ok: true, envelopeId: 'env-1' } as any);

      const initiator: InitiatorConfig = {
        sessionStart: {
          intent: 'no context here',
          participants: ['agent-1'],
          ttlMs: 10_000,
        },
      };

      const participant = new Participant({
        participantId: 'agent-1',
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        mode: MODE_DECISION,
        client,
        transport: makeMockTransport([]),
        initiator,
      });

      await participant.run();

      expect(startSpy).toHaveBeenCalledTimes(1);
      const arg = startSpy.mock.calls[0]![0];
      expect(arg.contextId).toBeUndefined();
      expect(arg.extensions).toBeUndefined();
    });

    it('kickoff Proposal defaults proposalId to <sessionId>-kickoff and option to "decide"', async () => {
      const client = makeMockClient();
      vi.spyOn(DecisionSession.prototype, 'start').mockResolvedValue({ ok: true } as any);
      const proposeSpy = vi.spyOn(DecisionSession.prototype, 'propose').mockResolvedValue({ ok: true } as any);

      const participant = new Participant({
        participantId: 'agent-1',
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        mode: MODE_DECISION,
        client,
        transport: makeMockTransport([]),
        initiator: {
          sessionStart: { intent: 'decide', participants: ['agent-1'], ttlMs: 10_000 },
          kickoff: { messageType: 'Proposal', payload: {} },
        },
      });

      await participant.run();

      expect(proposeSpy.mock.calls[0]![0]).toEqual({
        proposalId: '550e8400-e29b-41d4-a716-446655440000-kickoff',
        option: 'decide',
        rationale: undefined,
      });
    });

    it('kickoff Proposal accepts the snake_case proposal_id spelling', async () => {
      const client = makeMockClient();
      vi.spyOn(DecisionSession.prototype, 'start').mockResolvedValue({ ok: true } as any);
      const proposeSpy = vi.spyOn(DecisionSession.prototype, 'propose').mockResolvedValue({ ok: true } as any);

      const participant = new Participant({
        participantId: 'agent-1',
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        mode: MODE_DECISION,
        client,
        transport: makeMockTransport([]),
        initiator: {
          sessionStart: { intent: 'decide', participants: ['agent-1'], ttlMs: 10_000 },
          kickoff: { messageType: 'Proposal', payload: { proposal_id: 'p-snake', option: 'canary' } },
        },
      });

      await participant.run();

      expect(proposeSpy.mock.calls[0]![0]).toMatchObject({ proposalId: 'p-snake', option: 'canary' });
    });
  });

  describe('processEvent', () => {
    it('decodes the payload and extracts proposalId from the camelCase field', async () => {
      const client = makeMockClient();
      client.protoRegistry.decodeKnownPayload.mockReturnValue({ proposalId: 'p-camel' });
      const handler = vi.fn();

      const participant = new Participant({
        participantId: 'agent-1',
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        mode: MODE_DECISION,
        client,
        transport: makeMockTransport([]),
      });
      participant.on('Proposal', handler);

      await participant.processEvent(makeIncomingMessage('Proposal').raw!);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0]![0]).toMatchObject({ messageType: 'Proposal', proposalId: 'p-camel' });
    });

    it('falls back to the snake_case proposal_id field', async () => {
      const client = makeMockClient();
      client.protoRegistry.decodeKnownPayload.mockReturnValue({ proposal_id: 'p-snake' });
      const handler = vi.fn();

      const participant = new Participant({
        participantId: 'agent-1',
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        mode: MODE_DECISION,
        client,
        transport: makeMockTransport([]),
      });
      participant.on('Proposal', handler);

      await participant.processEvent(makeIncomingMessage('Proposal').raw!);

      expect(handler.mock.calls[0]![0]).toMatchObject({ proposalId: 'p-snake' });
    });
  });

  describe('run() — terminal handling', () => {
    it('fires onPhaseChange and onTerminal on Committed, then stops consuming', async () => {
      const client = makeMockClient();
      const phaseHandler = vi.fn();
      const terminalHandler = vi.fn();
      const lateHandler = vi.fn();

      // A Commitment flips the DecisionProjection to phase 'Committed' — the
      // run loop must dispatch terminal and NOT consume the trailing Proposal.
      const messages = [makeIncomingMessage('Commitment'), makeIncomingMessage('Proposal')];

      const participant = new Participant({
        participantId: 'agent-1',
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        mode: MODE_DECISION,
        client,
        transport: makeMockTransport(messages),
      });
      participant.onPhaseChange('Committed', phaseHandler);
      participant.onTerminal(terminalHandler);
      participant.on('Proposal', lateHandler);

      await participant.run();

      expect(phaseHandler).toHaveBeenCalledTimes(1);
      expect(terminalHandler).toHaveBeenCalledTimes(1);
      expect(terminalHandler.mock.calls[0]![0]).toMatchObject({ state: 'Committed' });
      expect(terminalHandler.mock.calls[0]![0].commitment).toBeDefined();
      expect(lateHandler).not.toHaveBeenCalled();
      expect(participant.isStopped).toBe(true);
    });

    it('an unknown ext mode still dispatches handlers via the fallback projection', async () => {
      const client = makeMockClient();
      const handler = vi.fn();
      const message: IncomingMessage = {
        messageType: 'Contribute',
        sender: 'agent-a',
        payload: { value: 'option_a' },
        raw: {
          macpVersion: '1.0',
          mode: 'ext.custom.v1',
          messageType: 'Contribute',
          messageId: 'msg-1',
          sessionId: '550e8400-e29b-41d4-a716-446655440000',
          sender: 'agent-a',
          timestampUnixMs: '1',
          payload: Buffer.alloc(0),
        },
        seq: 0,
      };

      const participant = new Participant({
        participantId: 'agent-1',
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        mode: 'ext.custom.v1',
        client,
        transport: makeMockTransport([message]),
      });
      participant.on('Contribute', handler);

      await participant.run();

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('a re-entrant run() call is a no-op while the loop is active', async () => {
      const client = makeMockClient();
      const handler = vi.fn(async (_msg, ctx) => {
        // Re-entering run() from inside a handler must return immediately
        // instead of double-consuming the transport.
        await (ctx.participant as Participant).run();
      });

      const participant = new Participant({
        participantId: 'agent-1',
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        mode: MODE_DECISION,
        client,
        transport: makeMockTransport([makeIncomingMessage('Proposal', { proposalId: 'p1' })]),
      });
      participant.on('Proposal', handler);

      await participant.run();

      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  // Issue #106.1: no projection maps a `SessionCancel` control envelope to a
  // phase (it has no `mode`, so `applyEnvelope`'s mode guard discards it
  // before any subclass sees it), so before this fix a cancelled session had
  // no path to `onTerminal` at all and `run()` kept waiting.
  describe('SessionCancel fires onTerminal (issue #106.1)', () => {
    it('dispatches onTerminal with { state: "Cancelled" } and ends run()', async () => {
      const client = makeMockClient();
      const terminalHandler = vi.fn();
      const message = makeIncomingMessage('SessionCancel');

      const participant = new Participant({
        participantId: 'agent-1',
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        mode: MODE_DECISION,
        client,
        transport: makeMockTransport([message]),
      });
      participant.onTerminal(terminalHandler);

      await participant.run();

      expect(terminalHandler).toHaveBeenCalledTimes(1);
      expect(terminalHandler.mock.calls[0]![0]).toEqual({ state: 'Cancelled' });
      expect(participant.isStopped).toBe(true);
    });

    it('same via processEvent(), for the foreign-loop path', async () => {
      const client = makeMockClient();
      const terminalHandler = vi.fn();

      const participant = new Participant({
        participantId: 'agent-1',
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        mode: MODE_DECISION,
        client,
        transport: makeMockTransport([]),
      });
      participant.onTerminal(terminalHandler);

      await participant.processEvent({
        macpVersion: '1.0',
        mode: MODE_DECISION,
        messageType: 'SessionCancel',
        messageId: 'msg-cancel-1',
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        sender: 'runtime',
        timestampUnixMs: String(Date.now()),
        payload: Buffer.alloc(0),
      });

      expect(terminalHandler).toHaveBeenCalledTimes(1);
      expect(terminalHandler.mock.calls[0]![0]).toEqual({ state: 'Cancelled' });
    });

    it('does NOT fire for a non-terminal, non-SessionCancel message — the fallback is narrow, not a catch-all', async () => {
      const client = makeMockClient();
      const terminalHandler = vi.fn();
      const message = makeIncomingMessage('Proposal', { proposalId: 'p1' });

      const participant = new Participant({
        participantId: 'agent-1',
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        mode: MODE_DECISION,
        client,
        transport: makeMockTransport([message]),
      });
      participant.onTerminal(terminalHandler);

      await participant.run();

      expect(terminalHandler).not.toHaveBeenCalled();
      expect(participant.isStopped).toBe(false);
    });

    // Ordering (the phase path is primary): the existing "fires onPhaseChange
    // and onTerminal on Committed" test above already asserts
    // `terminalHandler` is called exactly once for a `Commitment` — proving
    // the phase-driven path fires and the `SessionCancel` fallback does not
    // also run. Not duplicated here.

    it('a SessionCancel on an already-terminal participant does not double-dispatch onTerminal', async () => {
      const client = makeMockClient();
      const terminalHandler = vi.fn();
      const participant = new Participant({
        participantId: 'agent-1',
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        mode: MODE_DECISION,
        client,
        transport: makeMockTransport([]),
      });
      participant.onTerminal(terminalHandler);

      const cancelEnvelope = {
        macpVersion: '1.0',
        mode: MODE_DECISION,
        messageType: 'SessionCancel',
        messageId: 'msg-cancel-1',
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        sender: 'runtime',
        timestampUnixMs: String(Date.now()),
        payload: Buffer.alloc(0),
      };
      await participant.processEvent(cancelEnvelope);
      await participant.processEvent({ ...cancelEnvelope, messageId: 'msg-cancel-2' });

      expect(terminalHandler).toHaveBeenCalledTimes(1);
    });
  });

  // Issue #106.2: `run()`'s `finally` used to only clear `running`, so a
  // normal terminal exit leaked both the transport subscription and the
  // cancel-callback TCP listener — teardown lived exclusively in `stop()`.
  describe('teardown runs on every run() exit path, not just stop() (issue #106.2)', () => {
    it('transport.stop() is invoked exactly once when run() exits via a terminal phase, with no explicit stop() call', async () => {
      const client = makeMockClient();
      const transport = makeMockTransport([makeIncomingMessage('Commitment')]);
      const stopSpy = vi.spyOn(transport, 'stop');

      const participant = new Participant({
        participantId: 'agent-1',
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        mode: MODE_DECISION,
        client,
        transport,
      });

      await participant.run();

      expect(stopSpy).toHaveBeenCalledTimes(1);
    });

    it('a transport whose stop() rejects still lets run() resolve, and the terminal handler still ran', async () => {
      const client = makeMockClient();
      const terminalHandler = vi.fn();
      const transport = makeMockTransport([makeIncomingMessage('Commitment')]);
      vi.spyOn(transport, 'stop').mockRejectedValue(new Error('boom'));

      const participant = new Participant({
        participantId: 'agent-1',
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        mode: MODE_DECISION,
        client,
        transport,
      });
      participant.onTerminal(terminalHandler);

      await expect(participant.run()).resolves.toBeUndefined();
      expect(terminalHandler).toHaveBeenCalledTimes(1);
    });
  });

  // Issue #106.3: `isStopped` computed `!this.running`, so it read `true` at
  // construction before anything had started. The obvious fix (one latching
  // `stopped` copied from python-sdk) would break the documented #66 restart
  // contract below, so `run()`/`stop()` now track three independent states.
  describe('isStopped / re-entry lifecycle (issue #106.3)', () => {
    it('isStopped is false immediately after construction', () => {
      const client = makeMockClient();
      const participant = new Participant({
        participantId: 'agent-1',
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        mode: MODE_DECISION,
        client,
        transport: makeMockTransport([]),
      });

      expect(participant.isStopped).toBe(false);
    });

    it('a second run() after a TERMINAL exit does not re-enter the transport at all', async () => {
      const client = makeMockClient();
      const transport = makeMockTransport([makeIncomingMessage('Commitment')]);
      const startSpy = vi.spyOn(transport, 'start');

      const participant = new Participant({
        participantId: 'agent-1',
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        mode: MODE_DECISION,
        client,
        transport,
      });

      await participant.run();
      expect(participant.isStopped).toBe(true);

      await participant.run();

      expect(startSpy).toHaveBeenCalledTimes(1);
    });

    it('a second run() after a non-terminal stop() DOES re-enter the transport and delivers the remaining messages — the guard against over-latching', async () => {
      const client = makeMockClient();
      const messages = [
        makeIncomingMessage('Proposal', { proposalId: 'p1' }),
        makeIncomingMessage('Proposal', { proposalId: 'p2' }),
      ];
      const transport = makeRestartableMockTransport(messages);
      const received: string[] = [];

      const participant = new Participant({
        participantId: 'agent-1',
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        mode: MODE_DECISION,
        client,
        transport,
      });
      participant.on('Proposal', async (msg, ctx) => {
        received.push((msg.payload as Record<string, string>).proposalId ?? '');
        if (received.length === 1) {
          await (ctx.participant as Participant).stop();
        }
      });

      await participant.run();
      expect(received).toEqual(['p1']);
      expect(participant.isStopped).toBe(true);

      await participant.run();
      expect(received).toEqual(['p1', 'p2']);
      expect(transport.startCallCount).toBe(2);
      expect(participant.isStopped).toBe(false);
    });

    it('stop() called before run() still lets run() run — a never-started participant is not permanently stopped', async () => {
      const client = makeMockClient();
      // Not `makeMockTransport`: its `stop()` permanently latches `stopped`
      // on the mock itself, which would make this scenario indistinguishable
      // from "stopped forever" for reasons that have nothing to do with the
      // three-field design under test here.
      const transport = makeRestartableMockTransport([makeIncomingMessage('Proposal', { proposalId: 'p1' })]);
      const handler = vi.fn();

      const participant = new Participant({
        participantId: 'agent-1',
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        mode: MODE_DECISION,
        client,
        transport,
      });
      participant.on('Proposal', handler);

      await participant.stop();
      await participant.run();

      expect(transport.startCallCount).toBe(1);
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('isStopped reads true immediately after a bare stop() call, with no run() ever started', async () => {
      const client = makeMockClient();
      const participant = new Participant({
        participantId: 'agent-1',
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        mode: MODE_DECISION,
        client,
        transport: makeMockTransport([]),
      });

      expect(participant.isStopped).toBe(false);

      await participant.stop();

      expect(participant.isStopped).toBe(true);
    });
  });

  describe('cancel-callback server wiring', () => {
    afterEach(() => {
      vi.mocked(startCancelCallbackServer).mockReset();
    });

    it('run() starts the server from config, and a stop() after run() has already exited is a no-op re-close', async () => {
      const client = makeMockClient();
      const closeSpy = vi.fn().mockResolvedValue(undefined);
      vi.mocked(startCancelCallbackServer).mockResolvedValue({ close: closeSpy } as any);

      const participant = new Participant({
        participantId: 'agent-1',
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        mode: MODE_DECISION,
        client,
        transport: makeMockTransport([]),
        cancelCallback: { host: '127.0.0.1', port: 8099, path: '/cancel' },
      });

      // `run()`'s own teardown (issue #106.2) already closes the server when
      // the transport runs out of messages, before `stop()` is ever called
      // here — so this pins that a subsequent `stop()` finds nothing left to
      // close (the reference was already cleared) rather than double-closing.
      await participant.run();
      await participant.stop();

      expect(startCancelCallbackServer).toHaveBeenCalledWith(
        expect.objectContaining({ host: '127.0.0.1', port: 8099, path: '/cancel' }),
      );
      expect(closeSpy).toHaveBeenCalledTimes(1);
    });

    it('closes exactly once when run() exits via a terminal phase, with no explicit stop() call (issue #106.2)', async () => {
      const client = makeMockClient();
      const closeSpy = vi.fn().mockResolvedValue(undefined);
      vi.mocked(startCancelCallbackServer).mockResolvedValue({ close: closeSpy } as any);

      const participant = new Participant({
        participantId: 'agent-1',
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        mode: MODE_DECISION,
        client,
        transport: makeMockTransport([makeIncomingMessage('Commitment')]),
        cancelCallback: { host: '127.0.0.1', port: 8099, path: '/cancel' },
      });

      await participant.run();

      expect(closeSpy).toHaveBeenCalledTimes(1);
    });

    it('stop() closes an attached server and swallows close errors', async () => {
      const client = makeMockClient();
      const closeSpy = vi.fn().mockRejectedValue(new Error('boom'));

      const participant = new Participant({
        participantId: 'agent-1',
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        mode: MODE_DECISION,
        client,
        transport: makeMockTransport([]),
      });
      participant.attachCancelCallbackServer({ close: closeSpy } as any);

      await expect(participant.stop()).resolves.toBeUndefined();
      expect(closeSpy).toHaveBeenCalledTimes(1);

      // The server reference is cleared — a second stop() must not re-close.
      await participant.stop();
      expect(closeSpy).toHaveBeenCalledTimes(1);
    });

    it('a cancelCallback-configured participant restarts after a non-terminal stop() — teardown closes the server, and the next run() rebinds the same host:port', async () => {
      const client = makeMockClient();
      const closeSpy1 = vi.fn().mockResolvedValue(undefined);
      const closeSpy2 = vi.fn().mockResolvedValue(undefined);
      vi.mocked(startCancelCallbackServer)
        .mockResolvedValueOnce({ close: closeSpy1 } as any)
        .mockResolvedValueOnce({ close: closeSpy2 } as any);

      const transport = makeRestartableMockTransport([
        makeIncomingMessage('Proposal', { proposalId: 'p1' }),
        makeIncomingMessage('Proposal', { proposalId: 'p2' }),
      ]);

      const participant = new Participant({
        participantId: 'agent-1',
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        mode: MODE_DECISION,
        client,
        transport,
        cancelCallback: { host: '127.0.0.1', port: 8099, path: '/cancel' },
      });
      participant.on('Proposal', async (_msg, ctx) => {
        await (ctx.participant as Participant).stop();
      });

      await participant.run();
      // Teardown on the stop()-exit already closed the first server instance.
      expect(closeSpy1).toHaveBeenCalledTimes(1);
      expect(startCancelCallbackServer).toHaveBeenCalledTimes(1);

      await participant.run();
      // run() sees no live `cancelCallbackServer` (teardown cleared it) and
      // starts a fresh one against the same config — same host:port, a new
      // listener instance.
      expect(startCancelCallbackServer).toHaveBeenCalledTimes(2);
      expect(vi.mocked(startCancelCallbackServer).mock.calls[1]![0]).toMatchObject({
        host: '127.0.0.1',
        port: 8099,
        path: '/cancel',
      });
      expect(closeSpy2).toHaveBeenCalledTimes(1);
    });

    it('the real onCancel closure run() constructs calls stop() on the same participant, not a spied stand-in', async () => {
      const client = makeMockClient();
      const closeSpy = vi.fn().mockResolvedValue(undefined);
      vi.mocked(startCancelCallbackServer).mockResolvedValue({ close: closeSpy } as any);

      const transport = makeRestartableMockTransport([
        makeIncomingMessage('Proposal', { proposalId: 'p1' }),
        makeIncomingMessage('Proposal', { proposalId: 'p2' }),
      ]);
      const received: string[] = [];

      const participant = new Participant({
        participantId: 'agent-1',
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        mode: MODE_DECISION,
        client,
        transport,
        cancelCallback: { host: '127.0.0.1', port: 8099, path: '/cancel' },
      });
      // Invokes the actual `onCancel` closure `run()` handed to
      // `startCancelCallbackServer` (not a spied `stop()` stand-in), mid-stream
      // after the first message — the same shape as the real HTTP callback
      // firing while a session is in flight.
      participant.on('Proposal', (msg) => {
        received.push((msg.payload as Record<string, string>).proposalId ?? '');
        if (received.length === 1) {
          vi.mocked(startCancelCallbackServer).mock.calls[0]![0].onCancel();
        }
      });

      await participant.run();
      expect(received).toEqual(['p1']);
      expect(participant.isStopped).toBe(true);
      expect(closeSpy).toHaveBeenCalledTimes(1);

      await participant.run();
      expect(received).toEqual(['p1', 'p2']);
    });
  });

  // Regression for #66: `run()`'s loop checked `!this.running` *after*
  // `GrpcTransportAdapter` had already counted the envelope into its resume
  // cursor, so a `stop()` that lands mid-stream (e.g. the cancel-callback
  // path, `onCancel: () => { void this.stop(); }`) permanently skipped
  // whatever envelope was in flight when the loop next asked the transport
  // for more. Before #65 added the resume cursor this was latent (the next
  // `run()` replayed from ordinal 0 and picked it back up); after #65 the
  // cursor makes the skip permanent. This drives a real `GrpcTransportAdapter`
  // (not `makeMockTransport`, which has no cursor of its own) against a fake
  // stream whose `responses()` honors whatever `afterSequence` was last
  // passed to `sendSubscribe`, so it reproduces the actual resume-after-stop
  // behavior end to end.
  describe('run() — stop() mid-stream does not lose the in-flight envelope (#66)', () => {
    function makeEnvelope(overrides: Partial<Envelope>): Envelope {
      return {
        macpVersion: '1.0',
        mode: 'ext.custom.v1',
        messageType: 'Kickoff',
        messageId: 'msg-1',
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        sender: 'agent-a',
        timestampUnixMs: String(Date.now()),
        payload: Buffer.alloc(0),
        ...overrides,
      };
    }

    // A minimal fake of the `MacpStream` surface `GrpcTransportAdapter` uses.
    // Each `openStream()` call returns a fresh stream bound to the shared
    // envelope log; `responses()` only yields envelopes at or after whatever
    // ordinal `sendSubscribe` was last called with — the same "resume, don't
    // replay" contract the real runtime honors (RFC-MACP-0006 §3.2).
    function makeResumableClient(envelopes: Envelope[]) {
      return {
        protoRegistry: {
          encodeKnownPayload: vi.fn(() => Buffer.alloc(0)),
          decodeKnownPayload: vi.fn(() => ({})),
        },
        openStream: vi.fn(() => {
          let afterSequence = 0;
          return {
            sendSubscribe: vi.fn(async (_sessionId: string, after: number) => {
              afterSequence = after;
            }),
            responses: async function* () {
              for (const e of envelopes.slice(afterSequence)) yield e;
            },
            close: vi.fn(),
          };
        }),
        send: vi.fn().mockResolvedValue({ ok: true }),
        getSession: vi.fn(),
      } as any;
    }

    it('redelivers the envelope in flight when stop() lands on the previous one, across a restart', async () => {
      const sessionId = '550e8400-e29b-41d4-a716-446655440000';
      const envelope1 = makeEnvelope({ sessionId, messageId: 'msg-1', messageType: 'Kickoff' });
      const envelope2 = makeEnvelope({ sessionId, messageId: 'msg-2', messageType: 'FollowUp' });
      const client = makeResumableClient([envelope1, envelope2]);

      const received: string[] = [];

      // No `transport` override: the Participant builds its own real
      // GrpcTransportAdapter, exactly as it would against a live client.
      const participant = new Participant({
        participantId: 'agent-1',
        sessionId,
        mode: 'ext.custom.v1',
        client,
      });

      participant.on('Kickoff', async (_msg, ctx) => {
        received.push('Kickoff');
        // Simulate the cancel-callback path stopping the participant while
        // the transport is mid-stream, exactly like
        // `onCancel: () => { void this.stop(); }` in participant.ts.
        await (ctx.participant as Participant).stop();
      });
      participant.on('FollowUp', () => {
        received.push('FollowUp');
      });

      await participant.run();
      // FollowUp was already fetched from the transport by the time `run()`
      // observed its `stopRequested` flag and broke out of its loop, but
      // must not have been processed yet.
      expect(received).toEqual(['Kickoff']);

      // Restart. If FollowUp's envelope was wrongly counted into the resume
      // cursor while it was in flight, this second subscribe skips past it
      // and it is never seen again.
      await participant.run();
      expect(received).toEqual(['Kickoff', 'FollowUp']);
    });
  });
});
