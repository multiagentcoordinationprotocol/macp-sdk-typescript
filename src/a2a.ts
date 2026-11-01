/**
 * A2A extension binding codec (RFC-MACP-0014 1.1.x): MACP Envelopes and Acks
 * as A2A 1.0 Parts, Messages and Artifacts, MACP session state as A2A Task
 * state, the AgentCard extension, and the MACP ErrorInfo in an A2A error.
 *
 * A pure wire binding: plain JSON objects in and out, no A2A client or server,
 * no transport, no dependency on an A2A SDK. Pass the objects to one (see
 * docs/guides/a2a-binding.md). Node-free like `./canonical-json`, whose
 * canonical JSON mapping (RFC-MACP-0001 §10) the `data` Parts use, so it is
 * published as the browser-safe `./a2a` subpath.
 *
 * Every decoder throws {@link MacpA2aError}, whose `layer` and `code` say how
 * a server answers: `a2a` codes reject the A2A request as a whole, `macp`
 * codes travel in band in an Ack, and `codec` codes are local to this codec
 * (RFC-MACP-0014 assigns them no wire code).
 */

import {
  ackFromCanonicalJson,
  ackToCanonicalJson,
  base64DecodedLength,
  CanonicalJsonError,
  decodeBase64,
  encodeBase64,
  envelopeFromCanonicalJson,
  envelopeFromProtobuf,
  envelopeToCanonicalJson,
  envelopeToProtobuf,
  type CanonicalEnvelope,
} from './canonical-json';
import { MacpSdkError } from './errors';
import type { Ack, MacpErrorShape, SessionState } from './types';

/** The extension URI (RFC-MACP-0014 §3); also the prefix of its metadata keys. */
export const MACP_A2A_EXTENSION_URI = 'https://multiagentcoordinationprotocol.io/a2a/extensions/macp/v1';
/** mediaType of a `data` Envelope Part: the canonical JSON Envelope (§5.1). */
export const MEDIA_TYPE_ENVELOPE_JSON = 'application/macp-envelope+json';
/** mediaType of a `raw` Envelope Part: the Protobuf Envelope, base64 (§5.1). */
export const MEDIA_TYPE_ENVELOPE_PROTO = 'application/macp-envelope+proto';
/** The A2A protocol version this binding targets (the `A2A-Version` header). */
export const A2A_VERSION = '1.0';

const KEY_KIND = `${MACP_A2A_EXTENSION_URI}/kind`;
const KEY_SEQUENCE = `${MACP_A2A_EXTENSION_URI}/sequence`;
const KEY_SESSION_STATE = `${MACP_A2A_EXTENSION_URI}/sessionState`;
const TRANSPORT = 'macp.transport.a2a.v1';
const ERROR_INFO_TYPE = 'type.googleapis.com/google.rpc.ErrorInfo';
const MACP_DOMAIN = 'multiagentcoordinationprotocol.io';
/** §5.4, and the runtime's `MACP_MAX_PAYLOAD_BYTES` default. */
const DEFAULT_MAX_PAYLOAD_BYTES = 1048576;

// ── A2A 1.0 JSON shapes (only the members this binding reads or writes) ──

/** An A2A Part. An Envelope Part has `mediaType` and exactly one of `data` and `raw`. */
export interface A2aPart {
  mediaType?: string;
  /** Any JSON value; an Envelope or Ack Part carries an object. */
  data?: unknown;
  /** Base64 bytes. */
  raw?: string;
  text?: string;
  url?: string;
  filename?: string;
  metadata?: Record<string, unknown>;
}

export interface A2aMessage {
  messageId: string;
  role: string;
  parts: A2aPart[];
  taskId?: string;
  contextId?: string;
  extensions?: string[];
  metadata?: Record<string, unknown>;
  referenceTaskIds?: string[];
}

export interface A2aArtifact {
  artifactId: string;
  name?: string;
  description?: string;
  parts: A2aPart[];
  metadata?: Record<string, unknown>;
  extensions?: string[];
}

export interface A2aTask {
  id: string;
  contextId?: string;
  status: { state: string; timestamp?: string; message?: A2aMessage };
  artifacts?: A2aArtifact[];
  history?: A2aMessage[];
  metadata?: Record<string, unknown>;
}

/** An entry of an AgentCard's `capabilities.extensions`. */
export interface A2aAgentExtension {
  uri: string;
  description?: string;
  required?: boolean;
  params?: Record<string, unknown>;
}

/** The MACP ErrorInfo of an A2A error (RFC-MACP-0014 §11.1, §12). */
export interface A2aErrorInfo {
  reason: string;
  domain: string;
  metadata: Record<string, unknown>;
  /** True only when `metadata.duplicate` is the string `"true"` (§12). */
  duplicate: boolean;
}

export type MacpA2aErrorLayer = 'a2a' | 'macp' | 'codec';

/**
 * A refused A2A object. `layer` `a2a`: reject the request (JSON-RPC -32602,
 * §11.3). `macp`: answer in band with an Ack carrying `code`
 * (`INVALID_ENVELOPE`, `PAYLOAD_TOO_LARGE`). `codec`: local to this codec
 * (`NOT_A_MACP_MESSAGE`, `INVALID_ACK`, `INVALID_SEQUENCE`,
 * `INVALID_SESSION_STATE`).
 */
export class MacpA2aError extends MacpSdkError {
  readonly layer: MacpA2aErrorLayer;
  readonly code: string;

  constructor(layer: MacpA2aErrorLayer, code: string, message: string) {
    super(message);
    this.name = 'MacpA2aError';
    this.layer = layer;
    this.code = code;
  }
}

export interface A2aEncodeOptions {
  /** `'json'` (default): a `data` Part; `'proto'`: a `raw` Part. */
  encoding?: 'json' | 'proto';
}

export interface A2aDecodeOptions {
  /**
   * Upper bound on the decoded payload bytes, not the base64 text or the
   * whole Envelope (§5.4). A JSON `payload` is measured after its Protobuf
   * conversion. Default 1048576, the runtime's default.
   */
  maxPayloadBytes?: number;
}

export interface A2aMessageOptions extends A2aEncodeOptions {
  /** Default: the Envelope's `messageId` (§5.1 SHOULD). */
  messageId?: string;
  contextId?: string;
}

export interface A2aAckMessageOptions {
  /** Default: a random UUID. */
  messageId?: string;
  /** The Task the Ack answers; omitted when empty (a SessionStart rejected before a Task exists, a Signal). */
  taskId?: string;
  contextId?: string;
}

export interface MacpAgentExtensionOptions {
  macpVersions: string[];
  modes: string[];
  required?: boolean;
  manifestUrl?: string;
}

// ── Envelope Parts (§5.1, §5.3, §5.4) ────────────────────────────────

/** An Envelope as an A2A Part: canonical JSON in `data`, or Protobuf in `raw`. */
export function envelopeToA2aPart(envelope: CanonicalEnvelope, options: A2aEncodeOptions = {}): A2aPart {
  // Either form refuses what its decoder would (e.g. a timestamp outside
  // years 0001-9999) as macp/INVALID_ENVELOPE.
  const encoding = options.encoding ?? 'json';
  if (encoding === 'json') {
    return { mediaType: MEDIA_TYPE_ENVELOPE_JSON, data: asInvalidEnvelope(() => envelopeToCanonicalJson(envelope)) };
  }
  if (encoding === 'proto') {
    return {
      mediaType: MEDIA_TYPE_ENVELOPE_PROTO,
      raw: asInvalidEnvelope(() => encodeBase64(envelopeToProtobuf(envelope))),
    };
  }
  throw new RangeError(`encoding must be 'json' or 'proto', not ${JSON.stringify(encoding)}`);
}

/**
 * The Envelope in an Envelope Part. A Part of another mediaType is
 * `codec`/`NOT_A_MACP_MESSAGE`; a malformed Envelope, or an arm that doesn't
 * match the mediaType, is `macp`/`INVALID_ENVELOPE`; a payload over
 * `maxPayloadBytes` is `macp`/`PAYLOAD_TOO_LARGE`.
 */
export function envelopeFromA2aPart(part: A2aPart, options: A2aDecodeOptions = {}): CanonicalEnvelope {
  const limit = maxPayloadBytes(options);
  if (!isEnvelopePart(part)) throw new MacpA2aError('codec', 'NOT_A_MACP_MESSAGE', 'not an Envelope Part');
  let envelope: CanonicalEnvelope;
  if (part.mediaType === MEDIA_TYPE_ENVELOPE_JSON) {
    if (!isObject(part.data)) throw invalidEnvelope(`a ${MEDIA_TYPE_ENVELOPE_JSON} Part carries no data object`);
    const data = part.data;
    checkB64PayloadSize(data, limit);
    envelope = asInvalidEnvelope(() => envelopeFromCanonicalJson(data));
  } else {
    if (part.raw === undefined || part.raw === null) {
      throw invalidEnvelope(`a ${MEDIA_TYPE_ENVELOPE_PROTO} Part carries no raw bytes`);
    }
    envelope = asInvalidEnvelope(() => envelopeFromProtobuf(decodeBase64(part.raw, 'raw')));
  }
  if (envelope.payload.length > limit) throw payloadTooLarge(envelope.payload.length, limit);
  return envelope;
}

// ── Messages (§5.1, §6) ──────────────────────────────────────────────

/**
 * A ROLE_USER Message carrying one Envelope Part. `taskId` is the
 * `sessionId`, except for a SessionStart (A2A doesn't let a client name a new
 * Task, §6.1) and a Signal (§6.2), which have none.
 */
export function envelopeToA2aMessage(envelope: CanonicalEnvelope, options: A2aMessageOptions = {}): A2aMessage {
  const message: A2aMessage = {
    messageId: options.messageId || envelope.messageId || randomUuid(),
    role: 'ROLE_USER',
    parts: [envelopeToA2aPart(envelope, options)],
    extensions: [MACP_A2A_EXTENSION_URI],
  };
  const taskId = expectedTaskId(envelope);
  if (taskId) message.taskId = taskId;
  if (options.contextId) message.contextId = options.contextId;
  return message;
}

/**
 * The Envelope in a Message. Parts of other mediaTypes are ignored; two
 * Envelope Parts are `a2a`/`INVALID_REQUEST`, none is
 * `codec`/`NOT_A_MACP_MESSAGE`, and a `taskId` naming another session is
 * `macp`/`INVALID_ENVELOPE` (§6.1). A `taskId` on a SessionStart or Signal is
 * the server's to judge from its Task state (§11.3) and isn't checked here.
 */
export function envelopeFromA2aMessage(message: A2aMessage, options: A2aDecodeOptions = {}): CanonicalEnvelope {
  if (!isObject(message)) throw new MacpA2aError('codec', 'NOT_A_MACP_MESSAGE', 'not an A2A Message');
  const envelope = envelopeFromA2aPart(singleEnvelopePart(message.parts), options);
  const expected = expectedTaskId(envelope);
  if (expected && (message.taskId ?? '') !== expected) {
    throw invalidEnvelope('Message.taskId does not match the Envelope (RFC-MACP-0014 §6.1)');
  }
  return envelope;
}

// ── Acks (§5.2) ──────────────────────────────────────────────────────

/** A ROLE_AGENT Message carrying the Ack as an `application/json` Part marked `kind: ack`. */
export function ackToA2aMessage(ack: Ack, options: A2aAckMessageOptions = {}): A2aMessage {
  if (ack.ok !== undefined && typeof ack.ok !== 'boolean') throw new TypeError('ack.ok must be a boolean');
  checkAckShape(ack.ok === true, ack.error != null);
  const message: A2aMessage = {
    messageId: options.messageId || randomUuid(),
    role: 'ROLE_AGENT',
    extensions: [MACP_A2A_EXTENSION_URI],
    parts: [{ mediaType: 'application/json', data: ackToCanonicalJson(ack), metadata: { [KEY_KIND]: 'ack' } }],
  };
  if (options.taskId) message.taskId = options.taskId;
  if (options.contextId) message.contextId = options.contextId;
  return message;
}

/**
 * The Ack in an Ack Message. No Ack Part is `codec`/`NOT_A_MACP_MESSAGE`; two,
 * a malformed Ack, or `error` not present exactly when `ok` is false (§5.2)
 * is `codec`/`INVALID_ACK`.
 */
export function ackFromA2aMessage(message: A2aMessage): Ack & { error?: MacpErrorShape } {
  const parts = isObject(message) && Array.isArray(message.parts) ? message.parts : [];
  const acks = parts.filter((part) => isObject(part) && isObject(part.metadata) && part.metadata[KEY_KIND] === 'ack');
  if (acks.length === 0) throw new MacpA2aError('codec', 'NOT_A_MACP_MESSAGE', 'no Ack Part');
  if (acks.length > 1) throw invalidAck('two Ack Parts');
  let ack: Ack & { error?: MacpErrorShape };
  try {
    ack = ackFromCanonicalJson(acks[0]!.data);
  } catch (error) {
    if (error instanceof CanonicalJsonError) throw invalidAck(error.message);
    throw error;
  }
  checkAckShape(Boolean(ack.ok), ack.error !== undefined);
  return ack;
}

// ── Observation Artifacts (§9.1) ─────────────────────────────────────

/**
 * An accepted Envelope as an Observation Artifact. `sequence` is its 1-based
 * accepted-envelope ordinal (RFC-MACP-0006 §3.2); anything else is
 * `codec`/`INVALID_SEQUENCE`.
 */
export function envelopeToA2aArtifact(envelope: CanonicalEnvelope, sequence: number): A2aArtifact {
  return {
    artifactId: `macp:${envelope.messageId ?? ''}`,
    name: envelope.messageType ?? '',
    parts: [envelopeToA2aPart(envelope)],
    metadata: { [KEY_SEQUENCE]: checkSequence(sequence) },
    extensions: [MACP_A2A_EXTENSION_URI],
  };
}

/**
 * The Envelope and sequence of an Observation Artifact. A `sequence` that is
 * missing, not an integer (the integral float `2.0` is one) or below 1 is
 * `codec`/`INVALID_SEQUENCE`. Dropping a repeated sequence and detecting a gap
 * (§9.2) is the caller's job.
 */
export function envelopeFromA2aArtifact(
  artifact: A2aArtifact,
  options: A2aDecodeOptions = {},
): { envelope: CanonicalEnvelope; sequence: number } {
  if (!isObject(artifact)) throw new MacpA2aError('codec', 'NOT_A_MACP_MESSAGE', 'not an A2A Artifact');
  const metadata = isObject(artifact.metadata) ? artifact.metadata : {};
  if (!Object.prototype.hasOwnProperty.call(metadata, KEY_SEQUENCE)) {
    throw new MacpA2aError('codec', 'INVALID_SEQUENCE', 'EXT/sequence is missing');
  }
  const sequence = checkSequence(metadata[KEY_SEQUENCE]);
  return { envelope: envelopeFromA2aPart(singleEnvelopePart(artifact.parts), options), sequence };
}

// ── Session state (§8) ───────────────────────────────────────────────

const STATE_MAP: Record<string, [taskState: string, bare: string]> = {
  SESSION_STATE_OPEN: ['TASK_STATE_WORKING', 'OPEN'],
  SESSION_STATE_SUSPENDED: ['TASK_STATE_WORKING', 'SUSPENDED'],
  SESSION_STATE_RESOLVED: ['TASK_STATE_COMPLETED', 'RESOLVED'],
  SESSION_STATE_EXPIRED: ['TASK_STATE_FAILED', 'EXPIRED'],
  SESSION_STATE_CANCELLED: ['TASK_STATE_CANCELED', 'CANCELLED'],
};

const SESSION_STATE_NUMBERS: Record<number, SessionState> = {
  0: 'SESSION_STATE_UNSPECIFIED',
  1: 'SESSION_STATE_OPEN',
  2: 'SESSION_STATE_RESOLVED',
  3: 'SESSION_STATE_EXPIRED',
  4: 'SESSION_STATE_SUSPENDED',
  5: 'SESSION_STATE_CANCELLED',
};

/**
 * The A2A TaskState for a session state, and the Task metadata carrying the
 * exact MACP state (SUSPENDED and OPEN share TASK_STATE_WORKING). A name or
 * its enum number; UNSPECIFIED or an unknown state is
 * `codec`/`INVALID_SESSION_STATE`.
 */
export function sessionStateToA2a(state: SessionState | number): {
  taskState: string;
  metadata: Record<string, string>;
} {
  const name = typeof state === 'number' ? SESSION_STATE_NUMBERS[state] : state;
  const entry =
    typeof name === 'string' && Object.prototype.hasOwnProperty.call(STATE_MAP, name) ? STATE_MAP[name] : undefined;
  if (!entry) throw new MacpA2aError('codec', 'INVALID_SESSION_STATE', `${JSON.stringify(state)} has no A2A mapping`);
  return { taskState: entry[0], metadata: { [KEY_SESSION_STATE]: entry[1] } };
}

/**
 * The session state in a Task's or an (unwrapped) TaskStatusUpdateEvent's
 * metadata. Missing, or not one of the bare names (`OPEN`, ...), is
 * `codec`/`INVALID_SESSION_STATE`: never derived from the TaskState (§8).
 */
export function sessionStateFromA2a(taskOrEvent: A2aTask | { metadata?: Record<string, unknown> }): SessionState {
  const metadata = isObject(taskOrEvent) && isObject(taskOrEvent.metadata) ? taskOrEvent.metadata : undefined;
  const value = metadata?.[KEY_SESSION_STATE];
  for (const [name, [, bare]] of Object.entries(STATE_MAP)) {
    if (value === bare) return name as SessionState;
  }
  throw new MacpA2aError('codec', 'INVALID_SESSION_STATE', `EXT/sessionState is ${JSON.stringify(value)}`);
}

// ── AgentCard extension (§3) and ErrorInfo (§11.1, §12) ──────────────

/** The AgentCard `capabilities.extensions` entry declaring MACP. */
export function macpAgentExtension(options: MacpAgentExtensionOptions): A2aAgentExtension {
  const strings = (value: unknown, name: string): string[] => {
    if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
      throw new TypeError(`${name} must be an array of strings`);
    }
    return [...value];
  };
  if (options.required !== undefined && typeof options.required !== 'boolean') {
    throw new TypeError('required must be a boolean');
  }
  const params: Record<string, unknown> = {
    macpVersions: strings(options.macpVersions, 'macpVersions'),
    modes: strings(options.modes, 'modes'),
    transport: TRANSPORT,
  };
  if (options.manifestUrl) params.manifestUrl = options.manifestUrl;
  return { uri: MACP_A2A_EXTENSION_URI, required: options.required ?? false, params };
}

/**
 * The MACP ErrorInfo of an A2A error: a JSON-RPC `error` object (its `data`)
 * or a bare details array (HTTP+JSON, gRPC). Selected by `@type` and
 * `domain`, so A2A's own ErrorInfo beside it is skipped; `null` when there is
 * none.
 */
export function errorInfoFromA2a(errorOrDetails: unknown): A2aErrorInfo | null {
  const details = Array.isArray(errorOrDetails)
    ? errorOrDetails
    : isObject(errorOrDetails) && Array.isArray(errorOrDetails.data)
      ? errorOrDetails.data
      : [];
  const info = details.find(
    (detail): detail is Record<string, unknown> =>
      isObject(detail) && detail['@type'] === ERROR_INFO_TYPE && detail.domain === MACP_DOMAIN,
  );
  if (!info) return null;
  const metadata = isObject(info.metadata) ? info.metadata : {};
  return {
    reason: typeof info.reason === 'string' ? info.reason : '',
    domain: MACP_DOMAIN,
    metadata,
    duplicate: metadata.duplicate === 'true',
  };
}

// ── Helpers ──────────────────────────────────────────────────────────

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isEnvelopePart(part: unknown): part is A2aPart {
  return (
    isObject(part) && (part.mediaType === MEDIA_TYPE_ENVELOPE_JSON || part.mediaType === MEDIA_TYPE_ENVELOPE_PROTO)
  );
}

function singleEnvelopePart(parts: unknown): A2aPart {
  if (!Array.isArray(parts)) throw new MacpA2aError('codec', 'NOT_A_MACP_MESSAGE', 'no parts');
  const found = parts.filter(isEnvelopePart);
  if (found.length > 1) {
    throw new MacpA2aError('a2a', 'INVALID_REQUEST', 'two or more Envelope Parts (RFC-MACP-0014 §5.1, §11.3)');
  }
  if (found.length === 0) throw new MacpA2aError('codec', 'NOT_A_MACP_MESSAGE', 'no Envelope Part');
  return found[0]!;
}

/**
 * A random (v4) UUID. `crypto.getRandomValues` rather than
 * `crypto.randomUUID`, which browsers expose only in secure contexts.
 */
function randomUuid(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function expectedTaskId(envelope: CanonicalEnvelope): string {
  const type = envelope.messageType ?? '';
  return type === 'SessionStart' || type === 'Signal' ? '' : (envelope.sessionId ?? '');
}

function maxPayloadBytes(options: A2aDecodeOptions): number {
  const limit = options.maxPayloadBytes === undefined ? DEFAULT_MAX_PAYLOAD_BYTES : options.maxPayloadBytes;
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new RangeError(`maxPayloadBytes must be a non-negative integer, not ${String(limit)}`);
  }
  return limit;
}

/**
 * Refuses an oversized `payload_b64` without decoding it, after everything a
 * smaller payload would be refused for: the other members (decoded with an
 * empty `payload_b64`), then the base64 text itself. So a malformed Envelope
 * is INVALID_ENVELOPE whatever its payload size, and PAYLOAD_TOO_LARGE means
 * the Envelope was otherwise valid. Same order as macp-sdk-python.
 */
function checkB64PayloadSize(data: Record<string, unknown>, limit: number): void {
  const b64 = data.payload_b64;
  if (typeof b64 !== 'string' || (data.payload ?? null) !== null) return;
  asInvalidEnvelope(() => envelopeFromCanonicalJson({ ...data, payload_b64: '' }));
  const size = asInvalidEnvelope(() => base64DecodedLength(b64, 'payload_b64'));
  if (size > limit) throw payloadTooLarge(size, limit);
}

function checkSequence(value: unknown): number {
  if (typeof value !== 'number') throw new MacpA2aError('codec', 'INVALID_SEQUENCE', 'EXT/sequence is not a number');
  if (!Number.isInteger(value)) throw new MacpA2aError('codec', 'INVALID_SEQUENCE', 'EXT/sequence is not an integer');
  if (value < 1 || value > Number.MAX_SAFE_INTEGER) {
    throw new MacpA2aError('codec', 'INVALID_SEQUENCE', `EXT/sequence ${value} is not in 1..2^53-1`);
  }
  return value;
}

function checkAckShape(ok: boolean, hasError: boolean): void {
  if (ok === hasError) throw invalidAck('error must be present exactly when ok is false (RFC-MACP-0014 §5.2)');
}

function asInvalidEnvelope<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof CanonicalJsonError) throw invalidEnvelope(error.message);
    throw error;
  }
}

function invalidEnvelope(message: string): MacpA2aError {
  return new MacpA2aError('macp', 'INVALID_ENVELOPE', message);
}

function invalidAck(message: string): MacpA2aError {
  return new MacpA2aError('codec', 'INVALID_ACK', message);
}

function payloadTooLarge(size: number, limit: number): MacpA2aError {
  return new MacpA2aError('macp', 'PAYLOAD_TOO_LARGE', `${size} payload bytes exceed ${limit} (RFC-MACP-0014 §5.4)`);
}
