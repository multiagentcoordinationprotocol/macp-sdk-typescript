import { assertSenderMatchesIdentity, authSender, type AuthConfig } from './auth';
import type { MacpClient, MacpStream } from './client';
import { DEFAULT_CONFIGURATION_VERSION, DEFAULT_MODE_VERSION, DEFAULT_POLICY_VERSION, MODE_HANDOFF } from './constants';
import {
  buildCommitmentPayload,
  buildEnvelope,
  buildSessionStartPayload,
  newSessionId,
  toProtoPayload,
} from './envelope';
import { HandoffProjection } from './projections/handoff';
import { validateRequiredField, validateSessionId, validateSessionStart } from './validation';
import type {
  Ack,
  Envelope,
  HandoffAcceptPayload,
  HandoffContextPayload,
  HandoffDeclinePayload,
  HandoffOfferPayload,
  SessionMetadata,
} from './types';

interface HandoffSessionOptions {
  sessionId?: string;
  modeVersion?: string;
  configurationVersion?: string;
  policyVersion?: string;
  auth?: AuthConfig;
}

export class HandoffSession {
  readonly client: MacpClient;
  readonly sessionId: string;
  readonly modeVersion: string;
  readonly configurationVersion: string;
  readonly policyVersion: string;
  readonly auth?: AuthConfig;
  readonly projection = new HandoffProjection();

  constructor(client: MacpClient, options: HandoffSessionOptions = {}) {
    this.client = client;
    if (options.sessionId) validateSessionId(options.sessionId);
    this.sessionId = options.sessionId ?? newSessionId();
    this.modeVersion = options.modeVersion ?? DEFAULT_MODE_VERSION;
    this.configurationVersion = options.configurationVersion ?? DEFAULT_CONFIGURATION_VERSION;
    this.policyVersion = options.policyVersion ?? DEFAULT_POLICY_VERSION;
    this.auth = options.auth;
  }

  private senderFor(sender: string | undefined, auth?: AuthConfig): string {
    const effectiveAuth = auth ?? this.auth ?? this.client.auth;
    assertSenderMatchesIdentity(effectiveAuth, sender);
    return sender ?? authSender(effectiveAuth) ?? '';
  }

  private async sendAndTrack(envelope: Envelope, auth?: AuthConfig): Promise<Ack> {
    const ack = await this.client.send(envelope, { auth: auth ?? this.auth });
    if (ack.ok) this.projection.applyEnvelope(envelope, this.client.protoRegistry);
    return ack;
  }

  async start(input: {
    intent: string;
    participants: string[];
    ttlMs: number;
    contextId?: string;
    extensions?: Record<string, Buffer>;
    roots?: { uri: string; name?: string }[];
    sender?: string;
  }): Promise<Ack> {
    validateSessionStart({
      intent: input.intent,
      participants: input.participants,
      ttlMs: input.ttlMs,
      modeVersion: this.modeVersion,
      configurationVersion: this.configurationVersion,
    });
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
      mode: MODE_HANDOFF,
      messageType: 'SessionStart',
      sessionId: this.sessionId,
      sender: this.senderFor(input.sender),
      payload: this.client.protoRegistry.encodeKnownPayload(MODE_HANDOFF, 'SessionStart', toProtoPayload(payload)),
    });
    return this.sendAndTrack(envelope, this.auth);
  }

  async offer(input: HandoffOfferPayload & { sender?: string; auth?: AuthConfig }): Promise<Ack> {
    validateRequiredField('handoffId', input.handoffId);
    validateRequiredField('targetParticipant', input.targetParticipant);
    const offerInput = { ...input, scope: input.scope ?? '' };
    const envelope = buildEnvelope({
      mode: MODE_HANDOFF,
      messageType: 'HandoffOffer',
      sessionId: this.sessionId,
      sender: this.senderFor(input.sender, input.auth),
      payload: this.client.protoRegistry.encodeKnownPayload(MODE_HANDOFF, 'HandoffOffer', toProtoPayload(offerInput)),
    });
    return this.sendAndTrack(envelope, input.auth);
  }

  async addContext(input: HandoffContextPayload & { sender?: string; auth?: AuthConfig }): Promise<Ack> {
    validateRequiredField('handoffId', input.handoffId);
    const envelope = buildEnvelope({
      mode: MODE_HANDOFF,
      messageType: 'HandoffContext',
      sessionId: this.sessionId,
      sender: this.senderFor(input.sender, input.auth),
      payload: this.client.protoRegistry.encodeKnownPayload(MODE_HANDOFF, 'HandoffContext', toProtoPayload(input)),
    });
    return this.sendAndTrack(envelope, input.auth);
  }

  async acceptHandoff(input: HandoffAcceptPayload & { sender?: string; auth?: AuthConfig }): Promise<Ack> {
    validateRequiredField('handoffId', input.handoffId);
    const envelope = buildEnvelope({
      mode: MODE_HANDOFF,
      messageType: 'HandoffAccept',
      sessionId: this.sessionId,
      sender: this.senderFor(input.sender, input.auth),
      payload: this.client.protoRegistry.encodeKnownPayload(MODE_HANDOFF, 'HandoffAccept', toProtoPayload(input)),
    });
    return this.sendAndTrack(envelope, input.auth);
  }

  async decline(input: HandoffDeclinePayload & { sender?: string; auth?: AuthConfig }): Promise<Ack> {
    validateRequiredField('handoffId', input.handoffId);
    const envelope = buildEnvelope({
      mode: MODE_HANDOFF,
      messageType: 'HandoffDecline',
      sessionId: this.sessionId,
      sender: this.senderFor(input.sender, input.auth),
      payload: this.client.protoRegistry.encodeKnownPayload(MODE_HANDOFF, 'HandoffDecline', toProtoPayload(input)),
    });
    return this.sendAndTrack(envelope, input.auth);
  }

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
      mode: MODE_HANDOFF,
      messageType: 'Commitment',
      sessionId: this.sessionId,
      sender: this.senderFor(input.sender, input.auth),
      payload: this.client.protoRegistry.encodeKnownPayload(MODE_HANDOFF, 'Commitment', toProtoPayload(payload)),
    });
    return this.sendAndTrack(envelope, input.auth);
  }

  metadata(auth?: AuthConfig): Promise<{ metadata: SessionMetadata }> {
    return this.client.getSession(this.sessionId, { auth: auth ?? this.auth });
  }

  async cancel(reason = '', auth?: AuthConfig): Promise<Ack> {
    return this.client.cancelSession(this.sessionId, reason, {
      auth: auth ?? this.auth,
      raiseOnNack: true,
    });
  }

  /**
   * Pause this session via `SuspendSession` (proto 0.1.3+). Non-terminal: the
   * runtime banks remaining TTL and rejects messages until {@link resume}.
   */
  async suspend(reason = '', auth?: AuthConfig): Promise<Ack> {
    return this.client.suspendSession(this.sessionId, reason, {
      auth: auth ?? this.auth,
      raiseOnNack: true,
    });
  }

  /**
   * Resume this suspended session via `ResumeSession` (proto 0.1.3+),
   * restoring `SESSION_STATE_OPEN` and the banked TTL.
   */
  async resume(reason = '', auth?: AuthConfig): Promise<Ack> {
    return this.client.resumeSession(this.sessionId, reason, {
      auth: auth ?? this.auth,
      raiseOnNack: true,
    });
  }

  openStream(auth?: AuthConfig): MacpStream {
    return this.client.openStream({ auth: auth ?? this.auth });
  }
}
