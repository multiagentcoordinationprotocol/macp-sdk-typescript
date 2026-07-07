import type { AuthConfig } from '../auth';
import type { MacpClient } from '../client';
import { MODE_DECISION, MODE_HANDOFF, MODE_PROPOSAL, MODE_QUORUM, MODE_TASK } from '../constants';
import { DecisionSession } from '../decision';
import { HandoffSession } from '../handoff';
import { logger } from '../logging';
import { DecisionProjection } from '../projections/decision';
import { ProposalSession } from '../proposal';
import { QuorumSession } from '../quorum';
import { TaskSession } from '../task';
import type { Envelope } from '../types';
import { startCancelCallbackServer, type CancelCallbackServer } from './cancel-callback';
import { Dispatcher } from './dispatcher';
import { GrpcTransportAdapter, type TransportAdapter } from './transports';
import type {
  HandlerContext,
  IncomingMessage,
  MessageHandler,
  PhaseChangeHandler,
  ProjectionLike,
  SessionActions,
  SessionInfo,
  TerminalHandler,
  TerminalResult,
} from './types';

const TERMINAL_PHASES = new Set(['Committed', 'Accepted', 'Declined', 'Cancelled', 'TerminalRejected']);

export interface InitiatorConfig {
  sessionStart: {
    intent: string;
    participants: string[];
    ttlMs: number;
    /** Per-session max-suspend cap (ms, proto ≥ 0.1.5). 0/absent = runtime default. */
    maxSuspendMs?: number;
    contextId?: string;
    extensions?: Record<string, Buffer>;
    context?: Record<string, unknown>;
    roots?: Array<{ uri: string; name?: string }>;
  };
  kickoff?: {
    messageType: string;
    payload: Record<string, unknown>;
  };
}

export interface ParticipantConfig {
  participantId: string;
  sessionId: string;
  mode: string;
  client: MacpClient;
  auth?: AuthConfig;
  participants?: string[];
  modeVersion?: string;
  configurationVersion?: string;
  policyVersion?: string;
  transport?: TransportAdapter;
  initiator?: InitiatorConfig;
  /**
   * Bind a cancel-callback HTTP endpoint (RFC-0001 §7.2 Option A) when
   * this participant's event loop starts. The server is closed
   * automatically when {@link Participant.stop} is called. Parity with
   * python-sdk's bootstrap `cancel_callback` field.
   */
  cancelCallback?: { host: string; port: number; path: string };
}

type ModeSession = DecisionSession | ProposalSession | TaskSession | HandoffSession | QuorumSession;

export class Participant {
  readonly participantId: string;
  readonly sessionId: string;
  readonly mode: string;
  readonly client: MacpClient;
  readonly auth?: AuthConfig;
  readonly projection: ProjectionLike;
  readonly actions: SessionActions;

  private readonly dispatcher: Dispatcher;
  private readonly session: ModeSession | null;
  private readonly transport: TransportAdapter;
  private readonly initiatorConfig?: InitiatorConfig;
  private readonly participants: string[];
  private readonly modeVersion?: string;
  private readonly configurationVersion?: string;
  private readonly policyVersion?: string;
  private running = false;
  private lastPhase: string;
  private cancelCallbackServer?: CancelCallbackServer;
  private readonly cancelCallbackConfig?: { host: string; port: number; path: string };

  constructor(config: ParticipantConfig) {
    this.participantId = config.participantId;
    this.sessionId = config.sessionId;
    this.mode = config.mode;
    this.client = config.client;
    this.auth = config.auth;
    this.dispatcher = new Dispatcher();

    const sessionOpts = {
      sessionId: config.sessionId,
      modeVersion: config.modeVersion,
      configurationVersion: config.configurationVersion,
      policyVersion: config.policyVersion,
      auth: config.auth,
    };

    const { session, projection } = this.createModeSession(config.mode, config.client, sessionOpts);
    this.session = session;
    this.projection = projection;
    this.lastPhase = projection.phase;
    this.actions = this.buildActions();
    this.transport = config.transport ?? new GrpcTransportAdapter(config.client, config.sessionId, config.auth);
    this.initiatorConfig = config.initiator;
    this.participants = config.participants ?? [];
    this.modeVersion = config.modeVersion;
    this.configurationVersion = config.configurationVersion;
    this.policyVersion = config.policyVersion;
    this.cancelCallbackConfig = config.cancelCallback;
  }

  private createModeSession(
    mode: string,
    client: MacpClient,
    opts: {
      sessionId: string;
      modeVersion?: string;
      configurationVersion?: string;
      policyVersion?: string;
      auth?: AuthConfig;
    },
  ): { session: ModeSession | null; projection: ProjectionLike } {
    switch (mode) {
      case MODE_DECISION: {
        const s = new DecisionSession(client, opts);
        return { session: s, projection: s.projection };
      }
      case MODE_PROPOSAL: {
        const s = new ProposalSession(client, opts);
        return { session: s, projection: s.projection };
      }
      case MODE_TASK: {
        const s = new TaskSession(client, opts);
        return { session: s, projection: s.projection };
      }
      case MODE_HANDOFF: {
        const s = new HandoffSession(client, opts);
        return { session: s, projection: s.projection };
      }
      case MODE_QUORUM: {
        const s = new QuorumSession(client, opts);
        return { session: s, projection: s.projection };
      }
      default: {
        const fallback = new DecisionProjection();
        return { session: null, projection: fallback };
      }
    }
  }

  private buildActions(): SessionActions {
    const participantId = this.participantId;
    const actions: SessionActions = {};

    if (this.session instanceof DecisionSession) {
      const ds = this.session;
      actions.evaluate = async (input) => {
        await ds.evaluate({ ...input, sender: participantId });
      };
      actions.vote = async (input) => {
        await ds.vote({ ...input, sender: participantId });
      };
      actions.raiseObjection = async (input) => {
        await ds.raiseObjection({ ...input, sender: participantId });
      };
      actions.propose = async (input) => {
        await ds.propose({ ...input, sender: participantId });
      };
      actions.commit = async (input) => {
        await ds.commit({ ...input, sender: participantId });
      };
    }

    if (this.session instanceof ProposalSession) {
      const ps = this.session;
      actions.propose = async (input) => {
        await ps.propose({
          proposalId: input.proposalId,
          title: input.option,
          summary: input.rationale,
          sender: participantId,
        });
      };
      actions.commit = async (input) => {
        await ps.commit({ ...input, sender: participantId });
      };
    }

    if (this.session instanceof TaskSession) {
      const ts = this.session;
      actions.commit = async (input) => {
        await ts.commit({ ...input, sender: participantId });
      };
    }

    if (this.session instanceof HandoffSession) {
      const hs = this.session;
      actions.commit = async (input) => {
        await hs.commit({ ...input, sender: participantId });
      };
    }

    if (this.session instanceof QuorumSession) {
      const qs = this.session;
      actions.commit = async (input) => {
        await qs.commit({ ...input, sender: participantId });
      };
    }

    const mode = this.mode;
    const sessionId = this.sessionId;
    const client = this.client;
    const auth = this.auth;
    actions.send = async (messageType: string, payload: Record<string, unknown>) => {
      const { buildEnvelope } = await import('../envelope.js');
      const envelope = buildEnvelope({
        mode,
        messageType,
        sessionId,
        sender: participantId,
        payload: client.protoRegistry.encodeKnownPayload(mode, messageType, payload),
      });
      await client.send(envelope, { auth });
    };

    return actions;
  }

  on(messageType: string, handler: MessageHandler): Participant {
    this.dispatcher.on(messageType, handler);
    return this;
  }

  onPhaseChange(phase: string, handler: PhaseChangeHandler): Participant {
    this.dispatcher.onPhaseChange(phase, handler);
    return this;
  }

  onTerminal(handler: TerminalHandler): Participant {
    this.dispatcher.onTerminal(handler);
    return this;
  }

  /** Whether {@link stop} has been called (or the loop has exited). */
  get isStopped(): boolean {
    return !this.running;
  }

  async run(): Promise<void> {
    if (this.running) return;
    this.running = true;

    if (this.cancelCallbackConfig && !this.cancelCallbackServer) {
      this.cancelCallbackServer = await startCancelCallbackServer({
        host: this.cancelCallbackConfig.host,
        port: this.cancelCallbackConfig.port,
        path: this.cancelCallbackConfig.path,
        onCancel: () => {
          void this.stop();
        },
      });
    }

    if (this.initiatorConfig && this.session) {
      await this.emitInitiatorEnvelopes();
    }

    try {
      for await (const message of this.transport.start()) {
        if (!this.running) break;
        const reachedTerminal = await this.processMessage(message);
        if (reachedTerminal) break;
      }
    } finally {
      this.running = false;
    }
  }

  /**
   * Manually process a single envelope. Parity with python-sdk's
   * {@code Participant.process_event}. Useful for deterministic unit tests
   * and for driving the participant from a foreign event loop without
   * installing a {@link TransportAdapter}.
   */
  async processEvent(envelope: Envelope): Promise<void> {
    const payload =
      this.client.protoRegistry.decodeKnownPayload(envelope.mode, envelope.messageType, envelope.payload) ?? {};
    const message: IncomingMessage = {
      messageType: envelope.messageType,
      sender: envelope.sender,
      payload,
      proposalId: (payload as Record<string, string>).proposalId ?? (payload as Record<string, string>).proposal_id,
      raw: envelope,
      seq: 0,
    };
    await this.processMessage(message);
  }

  private buildHandlerContext(): HandlerContext {
    const sessionInfo: SessionInfo = {
      sessionId: this.sessionId,
      mode: this.mode,
      participants: this.participants,
      modeVersion: this.modeVersion,
      configurationVersion: this.configurationVersion,
      policyVersion: this.policyVersion,
    };
    return {
      participant: this,
      projection: this.projection,
      actions: this.actions,
      session: sessionInfo,
      log: (msg: string, details?: Record<string, unknown>) => {
        logger.debug(`[${this.participantId}] ${msg}`, details ?? '');
      },
    };
  }

  /** Returns true if a terminal state was reached. */
  private async processMessage(message: IncomingMessage): Promise<boolean> {
    const ctx = this.buildHandlerContext();

    if (this.session && message.raw) {
      const applyMethod = (this.session as { projection: { applyEnvelope: (...args: unknown[]) => void } }).projection
        .applyEnvelope;
      if (typeof applyMethod === 'function') {
        applyMethod.call(
          (this.session as { projection: ProjectionLike }).projection,
          message.raw,
          this.client.protoRegistry,
        );
      }
    }

    await this.dispatcher.dispatch(message, ctx);

    const currentPhase = this.projection.phase;
    if (currentPhase !== this.lastPhase) {
      this.lastPhase = currentPhase;
      await this.dispatcher.dispatchPhaseChange(currentPhase, ctx);

      if (TERMINAL_PHASES.has(currentPhase)) {
        const terminalResult: TerminalResult = {
          state: currentPhase,
          commitment: (this.projection as { commitment?: Record<string, unknown> }).commitment,
        };
        await this.dispatcher.dispatchTerminal(terminalResult);
        return true;
      }
    }

    return false;
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.transport.stop();
    if (this.cancelCallbackServer) {
      const srv = this.cancelCallbackServer;
      this.cancelCallbackServer = undefined;
      try {
        await srv.close();
      } catch (err) {
        logger.debug('cancel_callback close failed', err);
      }
    }
  }

  /**
   * Attach a running cancel-callback HTTP server to this participant.
   * The server is closed automatically when {@link stop} is called.
   * Parity with python-sdk's `Participant.attach_cancel_callback_server`.
   */
  attachCancelCallbackServer(server: CancelCallbackServer): void {
    this.cancelCallbackServer = server;
  }

  private async emitInitiatorEnvelopes(): Promise<void> {
    if (!this.initiatorConfig || !this.session) return;
    const ss = this.initiatorConfig.sessionStart;

    if ('start' in this.session && typeof this.session.start === 'function') {
      await this.session.start({
        intent: ss.intent,
        participants: ss.participants,
        ttlMs: ss.ttlMs,
        maxSuspendMs: ss.maxSuspendMs,
        contextId: ss.contextId,
        extensions: ss.extensions,
        roots: ss.roots,
      });
    }

    const kickoff = this.initiatorConfig.kickoff;
    if (!kickoff) return;

    if (kickoff.messageType === 'Proposal' && this.session instanceof DecisionSession) {
      const payload = kickoff.payload;
      await this.session.propose({
        proposalId: String(payload.proposalId ?? payload.proposal_id ?? `${this.sessionId}-kickoff`),
        option: String(payload.option ?? 'decide'),
        rationale: payload.rationale !== undefined ? String(payload.rationale) : undefined,
      });
    }
  }
}
