import { afterEach, describe, it, expect, vi } from 'vitest';
import { Participant, type ParticipantConfig, type InitiatorConfig } from '../../../src/agent/participant';
import type { TransportAdapter } from '../../../src/agent/transports';
import type { IncomingMessage } from '../../../src/agent/types';
import { MODE_DECISION, MODE_PROPOSAL, MODE_TASK, MODE_HANDOFF, MODE_QUORUM } from '../../../src/constants';
import { DecisionSession } from '../../../src/decision';
import type { Envelope } from '../../../src/types';

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

  describe('actions (decision mode)', () => {
    it('provides evaluate action', () => {
      const client = makeMockClient();
      const participant = new Participant({
        participantId: 'agent-1',
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        mode: MODE_DECISION,
        client,
        transport: makeMockTransport([]),
      });
      expect(participant.actions.evaluate).toBeDefined();
    });

    it('provides vote action', () => {
      const client = makeMockClient();
      const participant = new Participant({
        participantId: 'agent-1',
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        mode: MODE_DECISION,
        client,
        transport: makeMockTransport([]),
      });
      expect(participant.actions.vote).toBeDefined();
    });

    it('provides propose action', () => {
      const client = makeMockClient();
      const participant = new Participant({
        participantId: 'agent-1',
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        mode: MODE_DECISION,
        client,
        transport: makeMockTransport([]),
      });
      expect(participant.actions.propose).toBeDefined();
    });

    it('provides commit action', () => {
      const client = makeMockClient();
      const participant = new Participant({
        participantId: 'agent-1',
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        mode: MODE_DECISION,
        client,
        transport: makeMockTransport([]),
      });
      expect(participant.actions.commit).toBeDefined();
    });

    it('provides raiseObjection action', () => {
      const client = makeMockClient();
      const participant = new Participant({
        participantId: 'agent-1',
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        mode: MODE_DECISION,
        client,
        transport: makeMockTransport([]),
      });
      expect(participant.actions.raiseObjection).toBeDefined();
    });

    it('provides send action', () => {
      const client = makeMockClient();
      const participant = new Participant({
        participantId: 'agent-1',
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        mode: MODE_DECISION,
        client,
        transport: makeMockTransport([]),
      });
      expect(participant.actions.send).toBeDefined();
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
  });
});
