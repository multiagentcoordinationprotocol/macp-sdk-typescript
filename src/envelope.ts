import { randomUUID } from 'node:crypto';
import { DEFAULT_CONFIGURATION_VERSION, DEFAULT_MODE_VERSION, DEFAULT_POLICY_VERSION, MACP_VERSION } from './constants';
import type {
  CommitmentPayload,
  CommitmentRef,
  Envelope,
  ProgressPayload,
  Root,
  SessionStartPayload,
  SignalPayload,
} from './types';

export function newSessionId(): string {
  return randomUUID();
}

export function newMessageId(): string {
  return randomUUID();
}

export function newCommitmentId(): string {
  return randomUUID();
}

export function nowUnixMs(): number {
  return Date.now();
}

export function buildSessionStartPayload(input: {
  intent: string;
  participants: string[];
  ttlMs: number;
  modeVersion?: string;
  configurationVersion?: string;
  policyVersion?: string;
  contextId?: string;
  extensions?: Record<string, Buffer>;
  roots?: Root[];
}): SessionStartPayload {
  return {
    intent: input.intent,
    participants: input.participants,
    modeVersion: input.modeVersion ?? DEFAULT_MODE_VERSION,
    configurationVersion: input.configurationVersion ?? DEFAULT_CONFIGURATION_VERSION,
    policyVersion: input.policyVersion ?? DEFAULT_POLICY_VERSION,
    ttlMs: input.ttlMs,
    contextId: input.contextId ?? '',
    extensions: input.extensions ?? {},
    roots: input.roots ?? [],
  };
}

const NEGATIVE_SUFFIXES = ['rejected', 'failed', 'declined'];

export function inferOutcomePositive(action: string): boolean {
  const lower = action.toLowerCase();
  if (NEGATIVE_SUFFIXES.some((s) => lower.endsWith(s))) return false;
  return true;
}

/**
 * Build a {@link CommitmentRef} pointing at a prior accepted commitment, for
 * use as `buildCommitmentPayload({ supersedes })` (cross-session supersession,
 * RFC-MACP-0001 §7.3). Parity with python-sdk `build_commitment_ref`.
 */
export function buildCommitmentRef(input: { sessionId: string; commitmentHash: string }): CommitmentRef {
  return { sessionId: input.sessionId, commitmentHash: input.commitmentHash };
}

export function buildCommitmentPayload(input: {
  action: string;
  authorityScope: string;
  reason: string;
  commitmentId?: string;
  modeVersion?: string;
  configurationVersion?: string;
  policyVersion?: string;
  outcomePositive?: boolean;
  /**
   * Cross-session supersession (RFC-MACP-0001 §7.3): reference to the prior
   * commitment this one supersedes. Distinct from proposal-mode
   * `supersedesProposalId`. Absent by default. Backward-compatible.
   */
  supersedes?: CommitmentRef;
}): CommitmentPayload {
  const payload: CommitmentPayload = {
    commitmentId: input.commitmentId ?? newCommitmentId(),
    action: input.action,
    authorityScope: input.authorityScope,
    reason: input.reason,
    modeVersion: input.modeVersion ?? DEFAULT_MODE_VERSION,
    configurationVersion: input.configurationVersion ?? DEFAULT_CONFIGURATION_VERSION,
    policyVersion: input.policyVersion ?? DEFAULT_POLICY_VERSION,
    outcomePositive: input.outcomePositive ?? inferOutcomePositive(input.action),
  };
  if (input.supersedes) payload.supersedes = input.supersedes;
  return payload;
}

export function buildRoot(uri: string, name = ''): Root {
  return { uri, name };
}

export function buildSignalPayload(input: {
  signalType: string;
  data?: Buffer | Uint8Array;
  confidence?: number;
  correlationSessionId?: string;
}): SignalPayload {
  const data = input.data instanceof Buffer ? input.data : input.data ? Buffer.from(input.data) : Buffer.alloc(0);
  return {
    signalType: input.signalType,
    data,
    confidence: input.confidence ?? 0,
    correlationSessionId: input.correlationSessionId ?? '',
  };
}

export function buildProgressPayload(input: {
  progressToken: string;
  progress: number;
  total: number;
  message?: string;
  targetMessageId?: string;
}): ProgressPayload {
  return {
    progressToken: input.progressToken,
    progress: input.progress,
    total: input.total,
    message: input.message ?? '',
    targetMessageId: input.targetMessageId ?? '',
  };
}

type ProtoSerializable = { serializeBinary(): Uint8Array } | { toBinary(): Uint8Array } | { finish(): Uint8Array };

export function serializeMessage(message: ProtoSerializable | unknown): Uint8Array {
  // Parity with python-sdk `envelope.serialize_message`: invoke the protobuf
  // serializer exposed on the message. Supports objects with `serializeBinary`
  // (protoc-gen-js), `toBinary` (protobuf-es / ts-proto), or `finish`
  // (protobufjs Writer). For plain JS interface payloads, use
  // `ProtoRegistry.encodeKnownPayload(mode, messageType, payload)` instead —
  // the registry owns the mode/messageType → descriptor mapping.
  const candidate = message as Record<string, unknown>;
  if (typeof candidate?.serializeBinary === 'function') {
    return (candidate.serializeBinary as () => Uint8Array)();
  }
  if (typeof candidate?.toBinary === 'function') {
    return (candidate.toBinary as () => Uint8Array)();
  }
  if (typeof candidate?.finish === 'function') {
    return (candidate.finish as () => Uint8Array)();
  }
  throw new TypeError(
    'serializeMessage: object is not a protobuf message — expected serializeBinary(), toBinary(), or finish() method. For plain JS payloads, use ProtoRegistry.encodeKnownPayload().',
  );
}

/**
 * Type-erasure helper for protobuf payload encoders.
 *
 * `ProtoRegistry.encodeKnownPayload(mode, messageType, value)` accepts a
 * `Record<string, unknown>` because it does reflective field lookup. Our
 * mode-specific payload interfaces (e.g. `DecisionProposalPayload`) carry
 * stricter field types, so every call site otherwise ends up with
 * `input as unknown as Record<string, unknown>`. Centralising the coercion
 * keeps the `as unknown as` explanation in one place — the helper never
 * narrows, it only erases.
 */
export function toProtoPayload<T extends object>(input: T): Record<string, unknown> {
  return input as unknown as Record<string, unknown>;
}

export function buildEnvelope(input: {
  mode: string;
  messageType: string;
  sessionId: string;
  payload: Buffer;
  sender?: string;
  messageId?: string;
  macpVersion?: string;
  timestampUnixMs?: string | number;
}): Envelope {
  const ts = input.timestampUnixMs ?? nowUnixMs();
  return {
    macpVersion: input.macpVersion ?? MACP_VERSION,
    mode: input.mode,
    messageType: input.messageType,
    messageId: input.messageId ?? newMessageId(),
    sessionId: input.sessionId,
    sender: input.sender ?? '',
    timestampUnixMs: String(ts),
    payload: input.payload,
  };
}
