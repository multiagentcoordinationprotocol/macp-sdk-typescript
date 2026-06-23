import { assertSenderMatchesIdentity, authSender, type AuthConfig } from './auth';
import type { MacpClient, MacpStream } from './client';
import { DEFAULT_CONFIGURATION_VERSION, DEFAULT_MODE_VERSION, DEFAULT_POLICY_VERSION } from './constants';
import {
  buildCommitmentPayload,
  buildEnvelope,
  buildSessionStartPayload,
  newSessionId,
  toProtoPayload,
} from './envelope';
import { logger } from './logging';
import type { BaseProjection } from './projections/base';
import { validateParticipantCount, validateSessionId } from './validation';
import type { Ack, Envelope, Root, SessionMetadata } from './types';

export interface BaseSessionOptions {
  sessionId?: string;
  modeVersion?: string;
  configurationVersion?: string;
  policyVersion?: string;
  auth?: AuthConfig;
}

/**
 * Abstract base class for mode session helpers — parity with python-sdk's
 * `macp_sdk.base_session.BaseSession`. Provides the shared lifecycle
 * (start, commit, cancel, metadata, openStream) and the two identity-guarded
 * helpers (`senderFor`, `sendAndTrack`) that every mode session needs.
 *
 * Concrete session classes (DecisionSession, etc.) pre-date this base class
 * and implement their own equivalents; BaseSession is the recommended
 * extension point for custom modes registered via `registerExtMode`.
 */
export abstract class BaseSession<P extends BaseProjection> {
  readonly client: MacpClient;
  readonly sessionId: string;
  readonly modeVersion: string;
  readonly configurationVersion: string;
  readonly policyVersion: string;
  readonly auth?: AuthConfig;
  readonly projection: P;

  protected abstract readonly mode: string;

  constructor(client: MacpClient, options: BaseSessionOptions = {}) {
    this.client = client;
    if (options.sessionId) validateSessionId(options.sessionId);
    this.sessionId = options.sessionId ?? newSessionId();
    this.modeVersion = options.modeVersion ?? DEFAULT_MODE_VERSION;
    this.configurationVersion = options.configurationVersion ?? DEFAULT_CONFIGURATION_VERSION;
    this.policyVersion = options.policyVersion ?? DEFAULT_POLICY_VERSION;
    this.auth = options.auth;
    this.projection = this.createProjection();
  }

  /** Return a new projection instance. Subclasses construct their mode-specific projection here. */
  protected abstract createProjection(): P;

  /** Resolve the envelope sender, raising {@link MacpIdentityMismatchError} on conflict. */
  protected senderFor(sender: string | undefined, auth?: AuthConfig): string {
    const effectiveAuth = auth ?? this.auth ?? this.client.auth;
    assertSenderMatchesIdentity(effectiveAuth, sender);
    return sender ?? authSender(effectiveAuth) ?? '';
  }

  /** Send an envelope and, on ACK, feed it to the projection. */
  protected async sendAndTrack(envelope: Envelope, auth?: AuthConfig): Promise<Ack> {
    logger.debug('send', {
      session: envelope.sessionId,
      messageType: envelope.messageType,
      sender: envelope.sender,
    });
    const ack = await this.client.send(envelope, { auth: auth ?? this.auth });
    if (ack.ok) this.projection.applyEnvelope(envelope, this.client.protoRegistry);
    else logger.warn('nack', { session: envelope.sessionId, code: ack.error?.code });
    return ack;
  }

  /** Send SessionStart and begin tracking via the projection. */
  async start(input: {
    intent: string;
    participants: string[];
    ttlMs: number;
    contextId?: string;
    extensions?: Record<string, Buffer>;
    roots?: Root[];
    sender?: string;
    auth?: AuthConfig;
  }): Promise<Ack> {
    validateParticipantCount(input.participants.length);
    const payload = buildSessionStartPayload({
      intent: input.intent,
      participants: input.participants,
      ttlMs: input.ttlMs,
      contextId: input.contextId,
      extensions: input.extensions,
      roots: input.roots,
      modeVersion: this.modeVersion,
      configurationVersion: this.configurationVersion,
      policyVersion: this.policyVersion,
    });
    const envelope = buildEnvelope({
      mode: this.mode,
      messageType: 'SessionStart',
      sessionId: this.sessionId,
      sender: this.senderFor(input.sender, input.auth),
      payload: this.client.protoRegistry.encodeKnownPayload(this.mode, 'SessionStart', toProtoPayload(payload)),
    });
    return this.sendAndTrack(envelope, input.auth ?? this.auth);
  }

  /** Send a Commitment envelope to resolve the session. */
  async commit(input: {
    action: string;
    authorityScope: string;
    reason: string;
    commitmentId?: string;
    outcomePositive?: boolean;
    sender?: string;
    auth?: AuthConfig;
  }): Promise<Ack> {
    const payload = buildCommitmentPayload({
      action: input.action,
      authorityScope: input.authorityScope,
      reason: input.reason,
      commitmentId: input.commitmentId,
      outcomePositive: input.outcomePositive,
      modeVersion: this.modeVersion,
      configurationVersion: this.configurationVersion,
      policyVersion: this.policyVersion,
    });
    const envelope = buildEnvelope({
      mode: this.mode,
      messageType: 'Commitment',
      sessionId: this.sessionId,
      sender: this.senderFor(input.sender, input.auth),
      payload: this.client.protoRegistry.encodeKnownPayload(this.mode, 'Commitment', toProtoPayload(payload)),
    });
    return this.sendAndTrack(envelope, input.auth);
  }

  metadata(auth?: AuthConfig): Promise<{ metadata: SessionMetadata }> {
    return this.client.getSession(this.sessionId, { auth: auth ?? this.auth });
  }

  cancel(reason = '', auth?: AuthConfig): Promise<Ack> {
    return this.client.cancelSession(this.sessionId, reason, { auth: auth ?? this.auth });
  }

  /**
   * Pause this session via `SuspendSession` (proto 0.1.3+). Non-terminal: TTL
   * is banked and messages are rejected until {@link resume}. See
   * {@link MacpClient.suspendSession}.
   */
  suspend(reason = '', auth?: AuthConfig): Promise<Ack> {
    return this.client.suspendSession(this.sessionId, reason, { auth: auth ?? this.auth });
  }

  /**
   * Resume this suspended session via `ResumeSession` (proto 0.1.3+),
   * restoring OPEN and the banked TTL. See {@link MacpClient.resumeSession}.
   */
  resume(reason = '', auth?: AuthConfig): Promise<Ack> {
    return this.client.resumeSession(this.sessionId, reason, { auth: auth ?? this.auth });
  }

  openStream(auth?: AuthConfig): MacpStream {
    return this.client.openStream({ auth: auth ?? this.auth });
  }
}
