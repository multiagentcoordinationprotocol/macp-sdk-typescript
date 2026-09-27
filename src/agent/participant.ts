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
   * automatically on any exit from {@link Participant.run} — an explicit
   * {@link Participant.stop}, a terminal outcome, or the transport running
   * out of messages. Parity with python-sdk's bootstrap `cancel_callback`
   * field.
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
  /** Whether the event loop is currently inside {@link run}. */
  private running = false;
  /**
   * Latching: set once a terminal result is dispatched (a terminal phase,
   * or the {@code SessionCancel} fallback in {@link processMessage}). A
   * terminal `Participant` is single-use — {@link run} refuses to
   * re-enter, because the projection is resolved and the runtime will
   * accept nothing further for this session.
   */
  private terminal = false;
  /**
   * The cooperative cancel flag {@link stop} sets and {@link run} clears
   * on entry — the loop's break predicate. Distinct from {@link terminal}:
   * a `stop()`-exited, non-terminal `Participant` is a resumable pause
   * (see {@link isStopped}), not single-use.
   */
  private stopRequested = false;
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

  /**
   * `true` after a terminal outcome (single-use from here on), or while a
   * `stop()` request is pending/has taken effect on a `Participant` whose
   * loop has not (yet) been resumed by a later {@link run}. A `stop()`
   * exit is resumable — see {@link run} and {@link terminal}'s own doc.
   */
  get isStopped(): boolean {
    return this.terminal || this.stopRequested;
  }

  async run(): Promise<void> {
    if (this.running || this.terminal) return;
    this.stopRequested = false;
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
        if (this.stopRequested) break;
        const reachedTerminal = await this.processMessage(message);
        if (reachedTerminal) break;
      }
    } finally {
      this.running = false;
      await this.teardown();
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
    const alreadyTerminal = this.terminal;

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

    let firedTerminal = false;
    const currentPhase = this.projection.phase;
    if (currentPhase !== this.lastPhase) {
      this.lastPhase = currentPhase;
      await this.dispatcher.dispatchPhaseChange(currentPhase, ctx);

      if (TERMINAL_PHASES.has(currentPhase)) {
        this.terminal = true;
        firedTerminal = true;
        const terminalResult: TerminalResult = {
          state: currentPhase,
          commitment: (this.projection as { commitment?: Record<string, unknown> }).commitment,
        };
        await this.dispatcher.dispatchTerminal(terminalResult);
      }
    }

    // Fallback for envelopes no projection maps to a phase (issue #106.1):
    // no built-in projection maps `SessionCancel` to a terminal phase, so the
    // phase-driven path above never fires for it. Against the current
    // macp-runtime, `run()`'s streamed path never even observes this branch —
    // `cancel_session` stores `SessionCancel` as `EntryKind::Internal`
    // (runtime.rs `make_internal_entry`/`cancel_session`), and
    // `get_incoming_after` (macp-storage `log_store.rs`) filters strictly to
    // `EntryKind::Incoming`, so `StreamSession`/`GrpcTransportAdapter` never
    // delivers it; cancellation surfaces via the separate
    // `session_lifecycle_bus`/`WatchSessions` mechanism instead. This
    // fallback's real, currently-reachable value is `processEvent()` callers
    // driving their own foreign message loop (where a `SessionCancel` can be
    // handed in directly) and cross-SDK parity with `macp-sdk-python`'s
    // identical fallback — not the streamed `run()` path today. Gated on
    // `!alreadyTerminal` (captured before this call's own phase-driven
    // branch could have just set it) so a `SessionCancel` arriving on an
    // already-terminal session — one whose own terminal dispatch already
    // ran, this call or an earlier one — cannot double-dispatch
    // `onTerminal`.
    if (!firedTerminal && !alreadyTerminal && message.messageType === 'SessionCancel') {
      this.terminal = true;
      this.lastPhase = 'Cancelled';
      await this.dispatcher.dispatchTerminal({ state: 'Cancelled' });
      return true;
    }

    return firedTerminal;
  }

  /**
   * Idempotent teardown of everything {@link run} started: the transport
   * subscription and the cancel-callback HTTP listener, if any. Called
   * from both {@link stop} and every exit from {@link run}'s loop (issue
   * #106.2) — a normal terminal exit or a transport running out of
   * messages used to leak both. A rejecting `transport.stop()` is caught
   * rather than propagated, so a transport fault on teardown cannot mask
   * a clean session outcome as a thrown error from {@link run}.
   */
  private async teardown(): Promise<void> {
    try {
      await this.transport.stop();
    } catch (err) {
      logger.debug('transport stop failed', err);
    }
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
   * Request that {@link run}'s loop stop. This SDK's {@link TransportAdapter}
   * has no `cancel()` — `stop()` on the transport is the only thing that can
   * wake a loop suspended awaiting the next envelope, so teardown (including
   * the transport) runs here unconditionally, not just the flag. Safe to
   * call whether or not `run()` is currently active; does not itself flip
   * {@link running} — only `run()`'s own loop exit does that, since it is
   * the only place that actually knows the loop has left.
   */
  async stop(): Promise<void> {
    this.stopRequested = true;
    await this.teardown();
  }

  /**
   * Attach a running cancel-callback HTTP server to this participant.
   * The server is closed automatically on any exit from {@link run} — see
   * {@link teardown}.
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
