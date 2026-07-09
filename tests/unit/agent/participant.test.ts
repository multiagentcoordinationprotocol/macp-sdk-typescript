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

function makeIncomingMessage(messageType: string, payload: Record<string, unknown> = {}): IncomingMessage {
  return {
    messageType,
    sender: 'agent-a',
    payload,
    raw: {
      macpVersion: '1.0',
      mode: MODE_DECISION,
      messageType,
      messageId: 'msg-1',
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

  describe('cancel-callback server wiring', () => {
    afterEach(() => {
      vi.mocked(startCancelCallbackServer).mockReset();
    });

    it('run() starts the server from config and stop() closes it', async () => {
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

      await participant.run();
      await participant.stop();

      expect(startCancelCallbackServer).toHaveBeenCalledWith(
        expect.objectContaining({ host: '127.0.0.1', port: 8099, path: '/cancel' }),
      );
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
  });
});
