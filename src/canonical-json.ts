/**
 * Canonical JSON mapping of MACP Envelopes and Acks (RFC-MACP-0001 §10), the
 * JSON form an A2A `data` Part (RFC-MACP-0014) and other JSON transports carry.
 *
 * Node-free on purpose: no `node:*`, gRPC or protobufjs import, and payloads
 * are `Uint8Array`, so a browser bundle can use it like `./receipt`. Payload
 * schemas come from `generated/macp-schema.json`, built from the installed
 * `@multiagentcoordinationprotocol/proto` by `npm run gen:schema`.
 *
 * Payload form (§10.12, agreed with macp-sdk-python):
 * - a Core message type (Signal, Progress, SessionStart, SessionCancel,
 *   SessionSuspend, SessionResume, Commitment) is always `payload`, in any
 *   mode, including an empty-mode Signal;
 * - a message type of one of the five standard modes is `payload`;
 * - everything else, every `ext.*` or reverse-domain mode included, is
 *   `payload_b64`.
 *
 * Exact bytes: re-encoding a JSON `payload` follows §10.13, but bytes the
 * encoder didn't produce (unknown fields, non-canonical order) do not survive
 * the trip through JSON, and other Protobuf libraries need not produce the
 * same bytes. A caller that needs the exact bytes back (to check a receipt's
 * `commitment_wire_b64`, say) passes `payloadEncoding: 'b64'` (§10.13,
 * RFC-MACP-0014 §5.3).
 */
import { MacpSdkError } from './errors';
import { MODE_DECISION, MODE_HANDOFF, MODE_PROPOSAL, MODE_QUORUM, MODE_TASK } from './constants';
import schemaJson from './generated/macp-schema.json';
import type { Ack, Envelope, MacpErrorShape, SessionState } from './types';

export interface SchemaField {
  name: string;
  id: number;
  type: string;
  kind: 'scalar' | 'enum' | 'message';
  repeated?: true;
  keyType?: string;
  presence?: true;
}

export interface MacpSchema {
  proto_version: string;
  messages: Record<string, SchemaField[]>;
  enums: Record<string, Record<string, number>>;
}

const GENERATED_SCHEMA = schemaJson as unknown as MacpSchema;
let SCHEMA = GENERATED_SCHEMA;

/**
 * Test seam: swaps the payload schema, so field kinds no current payload
 * message uses (enums, packed numerics, non-string map keys) can be tested
 * before a proto release adds one. `undefined` restores the generated schema.
 * Not exported from the package root.
 */
export function setSchemaForTesting(schema: MacpSchema | undefined): void {
  SCHEMA = schema ?? GENERATED_SCHEMA;
}

/** An Envelope as the codec reads and returns it: the payload is plain bytes. */
export type CanonicalEnvelope = Omit<Envelope, 'payload'> & { payload: Uint8Array };

export interface CanonicalJsonOptions {
  /**
   * `'auto'` (default) follows §10.12; `'b64'` always emits `payload_b64`,
   * Core and standard-mode payloads included, so the exact bytes survive.
   */
  payloadEncoding?: 'auto' | 'b64';
}

/** A malformed canonical JSON object, or bytes that can't be mapped to one. */
export class CanonicalJsonError extends MacpSdkError {
  readonly code = 'INVALID_ENVELOPE';

  constructor(message: string) {
    super(message);
    this.name = 'CanonicalJsonError';
  }
}

// ── Payload selection (§10.12) ───────────────────────────────────────

const CORE_PAYLOADS: Record<string, string> = {
  Signal: 'macp.v1.SignalPayload',
  Progress: 'macp.v1.ProgressPayload',
  SessionStart: 'macp.v1.SessionStartPayload',
  SessionCancel: 'macp.v1.SessionCancelPayload',
  SessionSuspend: 'macp.v1.SessionSuspendPayload',
  SessionResume: 'macp.v1.SessionResumePayload',
  Commitment: 'macp.v1.CommitmentPayload',
};

const STANDARD_MODE_PAYLOADS: Record<string, Record<string, string>> = {
  [MODE_DECISION]: {
    Proposal: 'macp.modes.decision.v1.ProposalPayload',
    Evaluation: 'macp.modes.decision.v1.EvaluationPayload',
    Objection: 'macp.modes.decision.v1.ObjectionPayload',
    Vote: 'macp.modes.decision.v1.VotePayload',
  },
  [MODE_PROPOSAL]: {
    Proposal: 'macp.modes.proposal.v1.ProposalPayload',
    CounterProposal: 'macp.modes.proposal.v1.CounterProposalPayload',
    Accept: 'macp.modes.proposal.v1.AcceptPayload',
    Reject: 'macp.modes.proposal.v1.RejectPayload',
    Withdraw: 'macp.modes.proposal.v1.WithdrawPayload',
  },
  [MODE_TASK]: {
    TaskRequest: 'macp.modes.task.v1.TaskRequestPayload',
    TaskAccept: 'macp.modes.task.v1.TaskAcceptPayload',
    TaskReject: 'macp.modes.task.v1.TaskRejectPayload',
    TaskUpdate: 'macp.modes.task.v1.TaskUpdatePayload',
    TaskComplete: 'macp.modes.task.v1.TaskCompletePayload',
    TaskFail: 'macp.modes.task.v1.TaskFailPayload',
  },
  [MODE_HANDOFF]: {
    HandoffOffer: 'macp.modes.handoff.v1.HandoffOfferPayload',
    HandoffContext: 'macp.modes.handoff.v1.HandoffContextPayload',
    HandoffAccept: 'macp.modes.handoff.v1.HandoffAcceptPayload',
    HandoffDecline: 'macp.modes.handoff.v1.HandoffDeclinePayload',
  },
  [MODE_QUORUM]: {
    ApprovalRequest: 'macp.modes.quorum.v1.ApprovalRequestPayload',
    Approve: 'macp.modes.quorum.v1.ApprovePayload',
    Reject: 'macp.modes.quorum.v1.RejectPayload',
    Abstain: 'macp.modes.quorum.v1.AbstainPayload',
  },
};

/** The payload message a JSON `payload` holds for `(mode, messageType)`, if any. */
function payloadTypeFor(mode: string, messageType: string): string | undefined {
  if (Object.prototype.hasOwnProperty.call(CORE_PAYLOADS, messageType)) return CORE_PAYLOADS[messageType];
  const modeMap = Object.prototype.hasOwnProperty.call(STANDARD_MODE_PAYLOADS, mode)
    ? STANDARD_MODE_PAYLOADS[mode]!
    : undefined;
  return modeMap && Object.prototype.hasOwnProperty.call(modeMap, messageType) ? modeMap[messageType] : undefined;
}

// ── Envelope ─────────────────────────────────────────────────────────

/**
 * The canonical JSON object for an Envelope: snake_case keys, `timestamp` as
 * an RFC 3339 UTC string, every string field present, and the payload as
 * `payload` or `payload_b64` (see the module comment; `payloadEncoding:
 * 'b64'` forces `payload_b64`). Throws {@link CanonicalJsonError} when a
 * `payload`-form payload doesn't parse as its schema, or the timestamp is
 * outside years 0001–9999.
 */
export function envelopeToCanonicalJson(
  envelope: CanonicalEnvelope,
  options: CanonicalJsonOptions = {},
): Record<string, unknown> {
  const payloadEncoding = options.payloadEncoding ?? 'auto';
  if (payloadEncoding !== 'auto' && payloadEncoding !== 'b64') {
    throw new MacpSdkError(`payloadEncoding must be 'auto' or 'b64', not ${JSON.stringify(payloadEncoding)}`);
  }
  const mode = envelope.mode ?? '';
  const messageType = envelope.messageType ?? '';
  const out: Record<string, unknown> = {
    macp_version: envelope.macpVersion ?? '',
    mode,
    message_type: messageType,
    message_id: envelope.messageId ?? '',
    session_id: envelope.sessionId ?? '',
    sender: envelope.sender ?? '',
    timestamp: formatTimestamp(parseInt64Text(String(envelope.timestampUnixMs ?? '0'), 'timestampUnixMs')),
  };
  const payload = envelope.payload ?? new Uint8Array();
  const typeName = payloadEncoding === 'auto' ? payloadTypeFor(mode, messageType) : undefined;
  if (typeName) out.payload = messageToJson(typeName, payload, 'payload');
  else out.payload_b64 = encodeBase64(payload);
  return out;
}

/**
 * Parses a canonical JSON Envelope. Exactly one of `payload` and
 * `payload_b64` must be present (`null` counts as absent); a JSON `payload`
 * for a `(mode, message_type)` with no known schema is rejected, as §10.12
 * requires. Unknown members, lowerCamelCase spellings included, are ignored
 * (§10.6, §10.8). A missing string is `""` and a missing `timestamp` is 0.
 * Throws {@link CanonicalJsonError}.
 */
export function envelopeFromCanonicalJson(json: unknown): CanonicalEnvelope {
  const obj = asObject(json, 'envelope');
  const mode = readString(obj, 'mode');
  const messageType = readString(obj, 'message_type');
  const timestamp = obj.timestamp ?? null;
  if (timestamp !== null && typeof timestamp !== 'string') {
    throw new CanonicalJsonError('timestamp must be an RFC 3339 string');
  }
  const hasPayload = (obj.payload ?? null) !== null;
  const hasB64 = (obj.payload_b64 ?? null) !== null;
  if (hasPayload === hasB64) {
    throw new CanonicalJsonError('an envelope needs exactly one of payload and payload_b64');
  }
  let payload: Uint8Array;
  if (hasB64) {
    payload = decodeBase64(obj.payload_b64, 'payload_b64');
  } else {
    const typeName = payloadTypeFor(mode, messageType);
    if (!typeName) {
      throw new CanonicalJsonError(
        `no payload schema for (${JSON.stringify(mode)}, ${JSON.stringify(messageType)}); send payload_b64`,
      );
    }
    payload = messageFromJson(typeName, obj.payload, 'payload');
  }
  return {
    macpVersion: readString(obj, 'macp_version'),
    mode,
    messageType,
    messageId: readString(obj, 'message_id'),
    sessionId: readString(obj, 'session_id'),
    sender: readString(obj, 'sender'),
    timestampUnixMs: timestamp === null ? '0' : parseTimestamp(timestamp).toString(),
    payload,
  };
}

// ── Ack ──────────────────────────────────────────────────────────────

/**
 * The canonical JSON object for an Ack: all seven fields, `session_state` by
 * name, `accepted_at_unix_ms` a number (quoted above 2^53−1), and `error`
 * only when set, with all five MACPError fields (`details` as base64).
 */
export function ackToCanonicalJson(ack: Ack): Record<string, unknown> {
  const out: Record<string, unknown> = {
    ok: ack.ok ?? false,
    duplicate: ack.duplicate ?? false,
    message_id: ack.messageId ?? '',
    session_id: ack.sessionId ?? '',
    accepted_at_unix_ms: int64ToJson(parseInt64Text(String(ack.acceptedAtUnixMs ?? '0'), 'acceptedAtUnixMs')),
    session_state: ack.sessionState ?? 'SESSION_STATE_UNSPECIFIED',
  };
  if (ack.error) {
    out.error = {
      code: ack.error.code ?? '',
      message: ack.error.message ?? '',
      session_id: ack.error.sessionId ?? '',
      message_id: ack.error.messageId ?? '',
      details: encodeBase64(ack.error.details ?? new Uint8Array()),
    };
  }
  return out;
}

/**
 * Parses a canonical JSON Ack into the SDK's `Ack` shape. An integer
 * `session_state` is accepted and mapped to its name; an unknown name or
 * value leaves it `SESSION_STATE_UNSPECIFIED` (§10.4). `error.details` is
 * returned as a `Uint8Array`. Throws {@link CanonicalJsonError}.
 */
export function ackFromCanonicalJson(json: unknown): Ack & { error?: MacpErrorShape } {
  const obj = asObject(json, 'ack');
  const ack: Ack = {
    ok: readBool(obj, 'ok'),
    duplicate: readBool(obj, 'duplicate'),
    messageId: readString(obj, 'message_id'),
    sessionId: readString(obj, 'session_id'),
    acceptedAtUnixMs: readInt64(obj.accepted_at_unix_ms ?? null, 'int64', 'accepted_at_unix_ms').toString(),
    sessionState: sessionStateFromJson(obj.session_state ?? null),
  };
  if ((obj.error ?? null) !== null) {
    const err = asObject(obj.error, 'error');
    ack.error = {
      code: readString(err, 'code'),
      message: readString(err, 'message'),
      sessionId: readString(err, 'session_id'),
      messageId: readString(err, 'message_id'),
      details: (err.details ?? null) === null ? new Uint8Array() : decodeBase64(err.details, 'error.details'),
    } as MacpErrorShape;
  }
  return ack;
}

function sessionStateFromJson(value: unknown): SessionState {
  const values = SCHEMA.enums['macp.v1.SessionState']!;
  if (value === null) return 'SESSION_STATE_UNSPECIFIED';
  const number = enumNumberFromJson(values, value, 'session_state');
  const name = number === undefined ? undefined : Object.keys(values).find((key) => values[key] === number);
  return (name ?? 'SESSION_STATE_UNSPECIFIED') as SessionState;
}

// ── Messages: Protobuf bytes → JSON (§10.8–§10.10) ───────────────────

function messageFields(typeName: string): SchemaField[] {
  const fields = SCHEMA.messages[typeName];
  if (!fields) throw new CanonicalJsonError(`unknown message type ${typeName}`);
  return fields;
}

type Wire =
  { wireType: 0; value: bigint } | { wireType: 1 | 5; value: Uint8Array } | { wireType: 2; value: Uint8Array };

/** Decodes Protobuf bytes of `typeName` into its canonical JSON object. */
function messageToJson(typeName: string, bytes: Uint8Array, where: string): Record<string, unknown> {
  const fields = messageFields(typeName);
  const byId = new Map(fields.map((field) => [field.id, field]));
  const singles = new Map<number, unknown>();
  const repeated = new Map<number, unknown[]>();
  const maps = new Map<number, Map<string, unknown>>();
  // A message field seen more than once merges; concatenated bytes decode to the merge.
  const messageChunks = new Map<number, Uint8Array[]>();

  for (const { id, wire } of readWire(bytes, where)) {
    const field = byId.get(id);
    if (!field) continue; // unknown field: no JSON form (§10.6)
    const at = `${where}.${field.name}`;
    if (field.keyType) {
      if (wire.wireType !== 2) continue;
      const [key, value] = mapEntryToJson(field, wire.value, at);
      if (!maps.has(id)) maps.set(id, new Map());
      maps.get(id)!.set(key, value);
    } else if (field.kind === 'message') {
      if (wire.wireType !== 2) continue;
      if (field.repeated) {
        if (!repeated.has(id)) repeated.set(id, []);
        repeated.get(id)!.push(messageToJson(field.type, wire.value, at));
      } else {
        if (!messageChunks.has(id)) messageChunks.set(id, []);
        messageChunks.get(id)!.push(wire.value);
      }
    } else if (field.repeated) {
      const values = scalarsFromWire(field, wire, at);
      if (values === undefined) continue;
      if (!repeated.has(id)) repeated.set(id, []);
      repeated.get(id)!.push(...values);
    } else {
      const values = scalarsFromWire(field, wire, at);
      if (values === undefined || values.length !== 1) continue;
      singles.set(id, values[0]);
    }
  }
  for (const [id, chunks] of messageChunks) {
    singles.set(id, messageToJson(byId.get(id)!.type, concat(chunks), `${where}.${byId.get(id)!.name}`));
  }

  const out: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.keyType) {
      const entries = maps.get(field.id) ?? new Map<string, unknown>();
      out[field.name] = Object.fromEntries([...entries].sort(([a], [b]) => compareUtf8(a, b)));
    } else if (field.repeated) {
      out[field.name] = repeated.get(field.id) ?? [];
    } else if (singles.has(field.id)) {
      out[field.name] = singles.get(field.id);
    } else if (field.kind !== 'message' && !field.presence) {
      out[field.name] = defaultJson(field);
    }
  }
  return out;
}

function mapEntryToJson(field: SchemaField, bytes: Uint8Array, where: string): [string, unknown] {
  const keyField: SchemaField = { name: 'key', id: 1, type: field.keyType!, kind: 'scalar' };
  const valueField: SchemaField = { name: 'value', id: 2, type: field.type, kind: field.kind };
  let key: unknown = defaultJson(keyField);
  let value: unknown =
    field.kind === 'message' ? messageToJson(field.type, new Uint8Array(), where) : defaultJson(valueField);
  for (const { id, wire } of readWire(bytes, where)) {
    if (id === 1) {
      const values = scalarsFromWire(keyField, wire, where);
      if (values?.length === 1) key = values[0];
    } else if (id === 2) {
      if (field.kind === 'message') {
        if (wire.wireType === 2) value = messageToJson(field.type, wire.value, where);
      } else {
        const values = scalarsFromWire(valueField, wire, where);
        if (values?.length === 1) value = values[0];
      }
    }
  }
  return [String(key), value];
}

const VARINT_TYPES = new Set(['int32', 'int64', 'uint32', 'uint64', 'sint32', 'sint64', 'bool']);
const FIXED64_TYPES = new Set(['fixed64', 'sfixed64', 'double']);
const FIXED32_TYPES = new Set(['fixed32', 'sfixed32', 'float']);

function scalarWireType(field: SchemaField): 0 | 1 | 2 | 5 {
  if (field.kind === 'enum' || VARINT_TYPES.has(field.type)) return 0;
  if (FIXED64_TYPES.has(field.type)) return 1;
  if (FIXED32_TYPES.has(field.type)) return 5;
  return 2;
}

/** JSON values for one wire record of a scalar/enum field; a packed record yields several. */
function scalarsFromWire(field: SchemaField, wire: Wire, where: string): unknown[] | undefined {
  const expected = scalarWireType(field);
  if (wire.wireType === expected) return [scalarToJson(field, wire, where)];
  if (field.repeated && wire.wireType === 2 && expected !== 2) {
    const out: unknown[] = [];
    const reader = new WireReader(wire.value, where);
    while (!reader.done()) {
      const item: Wire =
        expected === 0
          ? { wireType: 0, value: reader.varint() }
          : { wireType: expected, value: reader.take(expected === 1 ? 8 : 4) };
      out.push(scalarToJson(field, item, where));
    }
    return out;
  }
  return undefined; // wire type mismatch: treated as an unknown field
}

function scalarToJson(field: SchemaField, wire: Wire, where: string): unknown {
  if (field.kind === 'enum') {
    const number = Number(BigInt.asIntN(32, wire.value as bigint));
    const values = SCHEMA.enums[field.type] ?? {};
    return Object.keys(values).find((key) => values[key] === number) ?? number;
  }
  switch (field.type) {
    case 'string':
      try {
        return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(wire.value as Uint8Array);
      } catch {
        throw new CanonicalJsonError(`${where}: invalid UTF-8 in a string field`);
      }
    case 'bytes':
      return encodeBase64(wire.value as Uint8Array);
    case 'bool':
      return (wire.value as bigint) !== 0n;
    case 'int32':
      return Number(BigInt.asIntN(32, wire.value as bigint));
    case 'uint32':
      return Number(BigInt.asUintN(32, wire.value as bigint));
    case 'sint32':
      return Number(zigzagDecode(BigInt.asUintN(32, wire.value as bigint)));
    case 'int64':
      return int64ToJson(BigInt.asIntN(64, wire.value as bigint));
    case 'uint64':
      return int64ToJson(BigInt.asUintN(64, wire.value as bigint));
    case 'sint64':
      return int64ToJson(zigzagDecode(BigInt.asUintN(64, wire.value as bigint)));
    case 'fixed32':
      return view(wire.value as Uint8Array).getUint32(0, true);
    case 'sfixed32':
      return view(wire.value as Uint8Array).getInt32(0, true);
    case 'float':
      return doubleToJson(view(wire.value as Uint8Array).getFloat32(0, true));
    case 'fixed64':
      return int64ToJson(view(wire.value as Uint8Array).getBigUint64(0, true));
    case 'sfixed64':
      return int64ToJson(view(wire.value as Uint8Array).getBigInt64(0, true));
    case 'double':
      return doubleToJson(view(wire.value as Uint8Array).getFloat64(0, true));
    default:
      throw new CanonicalJsonError(`${where}: unsupported field type ${field.type}`);
  }
}

function defaultJson(field: SchemaField): unknown {
  if (field.kind === 'enum') {
    const values = SCHEMA.enums[field.type] ?? {};
    return Object.keys(values).find((key) => values[key] === 0) ?? 0;
  }
  switch (field.type) {
    case 'string':
    case 'bytes':
      return '';
    case 'bool':
      return false;
    default:
      return 0;
  }
}

function int64ToJson(value: bigint): number | string {
  return value > MAX_SAFE || value < -MAX_SAFE ? value.toString() : Number(value);
}

function doubleToJson(value: number): number | string {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Infinity) return 'Infinity';
  if (value === -Infinity) return '-Infinity';
  return value;
}

function zigzagDecode(value: bigint): bigint {
  return (value >> 1n) ^ -(value & 1n);
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

class WireReader {
  private pos = 0;

  constructor(
    private readonly bytes: Uint8Array,
    private readonly where: string,
  ) {}

  done(): boolean {
    return this.pos >= this.bytes.length;
  }

  varint(): bigint {
    let result = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      if (this.pos >= this.bytes.length) throw this.malformed('truncated varint');
      const byte = this.bytes[this.pos++]!;
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return BigInt.asUintN(64, result);
    }
    throw this.malformed('varint longer than 10 bytes');
  }

  take(length: number): Uint8Array {
    if (length > this.bytes.length - this.pos) throw this.malformed('truncated field');
    const out = this.bytes.subarray(this.pos, this.pos + length);
    this.pos += length;
    return out;
  }

  malformed(reason: string): CanonicalJsonError {
    return new CanonicalJsonError(`${this.where}: malformed Protobuf bytes (${reason})`);
  }
}

function* readWire(bytes: Uint8Array, where: string): Generator<{ id: number; wire: Wire }> {
  const reader = new WireReader(bytes, where);
  while (!reader.done()) {
    const tag = reader.varint();
    const id = Number(tag >> 3n);
    const wireType = Number(tag & 7n);
    if (id < 1 || id > 0x1fffffff) throw reader.malformed(`field number ${id}`);
    if (wireType === 0) yield { id, wire: { wireType, value: reader.varint() } };
    else if (wireType === 1) yield { id, wire: { wireType, value: reader.take(8) } };
    else if (wireType === 5) yield { id, wire: { wireType, value: reader.take(4) } };
    else if (wireType === 2) {
      const length = reader.varint();
      if (length > BigInt(bytes.length)) throw reader.malformed('truncated field');
      yield { id, wire: { wireType, value: reader.take(Number(length)) } };
    } else throw reader.malformed(`wire type ${wireType}`);
  }
}

// ── Messages: JSON → Protobuf bytes (§10.13) ─────────────────────────

/** Encodes the canonical JSON object `json` of `typeName` as §10.13 bytes. */
function messageFromJson(typeName: string, json: unknown, where: string): Uint8Array {
  const obj = asObject(json, where);
  const writer = new WireWriter();
  for (const field of messageFields(typeName)) {
    if (!Object.prototype.hasOwnProperty.call(obj, field.name)) continue;
    const value = obj[field.name];
    if (value === null || value === undefined) continue;
    const at = `${where}.${field.name}`;
    if (field.keyType) {
      const entries = Object.entries(asObject(value, at)).sort(([a], [b]) => compareUtf8(a, b));
      for (const [key, entryValue] of entries) {
        if (entryValue === null) throw new CanonicalJsonError(`${at}[${JSON.stringify(key)}]: null map value`);
        const entry = new WireWriter();
        writeScalar(
          entry,
          { name: 'key', id: 1, type: field.keyType, kind: 'scalar' },
          mapKeyFromJson(field.keyType, key, at),
        );
        if (field.kind === 'message')
          entry.bytesField(2, messageFromJson(field.type, entryValue, `${at}[${JSON.stringify(key)}]`));
        else {
          const valueField: SchemaField = { name: 'value', id: 2, type: field.type, kind: field.kind };
          const scalar = scalarFromJson(valueField, entryValue, `${at}[${JSON.stringify(key)}]`);
          writeScalar(entry, valueField, scalar ?? scalarDefault(valueField));
        }
        writer.bytesField(field.id, entry.finish());
      }
    } else if (field.repeated) {
      if (!Array.isArray(value)) throw new CanonicalJsonError(`${at}: expected an array`);
      if (field.kind === 'message') {
        value.forEach((item, i) => writer.bytesField(field.id, messageFromJson(field.type, item, `${at}[${i}]`)));
        continue;
      }
      const items: Scalar[] = [];
      value.forEach((item, i) => {
        if (item === null) throw new CanonicalJsonError(`${at}[${i}]: null in a repeated field`);
        const scalar = scalarFromJson(field, item, `${at}[${i}]`);
        if (scalar !== undefined) items.push(scalar); // an unknown enum name drops the element (§10.4)
      });
      if (items.length === 0) continue;
      if (scalarWireType(field) === 2) {
        for (const item of items) writeScalar(writer, field, item);
      } else {
        const packed = new WireWriter();
        for (const item of items) writeScalarValue(packed, field, item);
        writer.bytesField(field.id, packed.finish());
      }
    } else if (field.kind === 'message') {
      writer.bytesField(field.id, messageFromJson(field.type, value, at));
    } else {
      const scalar = scalarFromJson(field, value, at);
      if (scalar === undefined) continue;
      if (!field.presence && isScalarDefault(field, scalar)) continue;
      writeScalar(writer, field, scalar);
    }
  }
  return writer.finish();
}

/** Internal scalar forms: string, Uint8Array, boolean, number (32-bit, enum, float), bigint (64-bit). */
type Scalar = string | Uint8Array | boolean | number | bigint;

const INT_RANGES: Record<string, [bigint, bigint]> = {
  int32: [-(2n ** 31n), 2n ** 31n - 1n],
  sint32: [-(2n ** 31n), 2n ** 31n - 1n],
  sfixed32: [-(2n ** 31n), 2n ** 31n - 1n],
  uint32: [0n, 2n ** 32n - 1n],
  fixed32: [0n, 2n ** 32n - 1n],
  int64: [-(2n ** 63n), 2n ** 63n - 1n],
  sint64: [-(2n ** 63n), 2n ** 63n - 1n],
  sfixed64: [-(2n ** 63n), 2n ** 63n - 1n],
  uint64: [0n, 2n ** 64n - 1n],
  fixed64: [0n, 2n ** 64n - 1n],
};
const SIXTY_FOUR = new Set(['int64', 'sint64', 'sfixed64', 'uint64', 'fixed64']);
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const FLOAT_MAX = 3.4028234663852886e38;

/** `undefined` only for an unknown enum name, which §10.4 treats as unset. */
function scalarFromJson(field: SchemaField, value: unknown, where: string): Scalar | undefined {
  if (field.kind === 'enum') return enumNumberFromJson(SCHEMA.enums[field.type] ?? {}, value, where);
  const type = field.type;
  if (type === 'string') {
    if (typeof value !== 'string') throw new CanonicalJsonError(`${where}: expected a string`);
    if (!isWellFormed(value)) throw new CanonicalJsonError(`${where}: string has a lone surrogate`);
    return value;
  }
  if (type === 'bytes') return decodeBase64(value, where);
  if (type === 'bool') {
    if (typeof value !== 'boolean') throw new CanonicalJsonError(`${where}: expected true or false`);
    return value;
  }
  if (type === 'double' || type === 'float') {
    let number: number;
    if (typeof value === 'number') number = value;
    else if (value === 'NaN') number = NaN;
    else if (value === 'Infinity') number = Infinity;
    else if (value === '-Infinity') number = -Infinity;
    else if (typeof value === 'string' && /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$/.test(value)) {
      number = Number(value);
      if (!Number.isFinite(number)) throw new CanonicalJsonError(`${where}: number out of range`);
    } else throw new CanonicalJsonError(`${where}: expected a number`);
    if (type === 'float' && Number.isFinite(number) && Math.abs(number) > FLOAT_MAX) {
      throw new CanonicalJsonError(`${where}: out of float range`);
    }
    return number;
  }
  if (Object.prototype.hasOwnProperty.call(INT_RANGES, type)) {
    const big = readInt64(value, type, where);
    return SIXTY_FOUR.has(type) ? big : Number(big);
  }
  throw new CanonicalJsonError(`${where}: unsupported field type ${type}`);
}

/** An integer from a JSON number or a quoted decimal string, range-checked for `type` (§10.9). */
function readInt64(value: unknown, type: string, where: string): bigint {
  if (value === null) return 0n;
  let big: bigint;
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) throw new CanonicalJsonError(`${where}: expected an integer`);
    if (!Number.isSafeInteger(value)) {
      throw new CanonicalJsonError(`${where}: ${value} is above 2^53-1 and must be quoted`);
    }
    big = BigInt(value);
  } else if (typeof value === 'string' && /^-?[0-9]+$/.test(value)) {
    big = BigInt(value);
  } else {
    throw new CanonicalJsonError(`${where}: expected an integer`);
  }
  const [min, max] = INT_RANGES[type]!;
  if (big < min || big > max) throw new CanonicalJsonError(`${where}: ${big} is out of ${type} range`);
  return big;
}

function enumNumberFromJson(values: Record<string, number>, value: unknown, where: string): number | undefined {
  if (typeof value === 'string') {
    return Object.prototype.hasOwnProperty.call(values, value) ? values[value] : undefined;
  }
  if (typeof value === 'number') return Number(readInt64(value, 'int32', where));
  throw new CanonicalJsonError(`${where}: expected an enum name or number`);
}

function mapKeyFromJson(keyType: string, key: string, where: string): Scalar {
  if (keyType === 'string') return key;
  if (keyType === 'bool') {
    if (key === 'true' || key === 'false') return key === 'true';
    throw new CanonicalJsonError(`${where}: bad map key ${JSON.stringify(key)}`);
  }
  const big = readInt64(key, keyType, where);
  return SIXTY_FOUR.has(keyType) ? big : Number(big);
}

function scalarDefault(field: SchemaField): Scalar {
  if (field.kind === 'enum') return 0;
  if (field.type === 'string') return '';
  if (field.type === 'bytes') return new Uint8Array();
  if (field.type === 'bool') return false;
  return SIXTY_FOUR.has(field.type) ? 0n : 0;
}

function isScalarDefault(field: SchemaField, value: Scalar): boolean {
  if (value instanceof Uint8Array) return value.length === 0;
  if (typeof value === 'number') return value === 0 && !Object.is(value, -0); // -0.0 is emitted (§10.13 rule 2)
  if (typeof value === 'bigint') return value === 0n;
  return value === scalarDefault(field);
}

function writeScalar(writer: WireWriter, field: SchemaField, value: Scalar): void {
  writer.tag(field.id, scalarWireType(field));
  writeScalarValue(writer, field, value);
}

function writeScalarValue(writer: WireWriter, field: SchemaField, value: Scalar): void {
  if (field.kind === 'enum') return writer.varint(BigInt.asUintN(64, BigInt(value as number)));
  switch (field.type) {
    case 'string':
      return writer.lengthDelimited(new TextEncoder().encode(value as string));
    case 'bytes':
      return writer.lengthDelimited(value as Uint8Array);
    case 'bool':
      return writer.varint(value ? 1n : 0n);
    case 'int32':
    case 'int64':
      return writer.varint(BigInt.asUintN(64, BigInt(value as number | bigint)));
    case 'uint32':
    case 'uint64':
      return writer.varint(BigInt(value as number | bigint));
    case 'sint32':
    case 'sint64': {
      const v = BigInt(value as number | bigint);
      return writer.varint(BigInt.asUintN(64, (v << 1n) ^ (v >> 63n)));
    }
    case 'fixed32':
      return writer.fixed(4, (dv) => dv.setUint32(0, value as number, true));
    case 'sfixed32':
      return writer.fixed(4, (dv) => dv.setInt32(0, value as number, true));
    case 'float':
      return writer.fixed(4, (dv) =>
        Number.isNaN(value) ? dv.setUint32(0, 0x7fc00000, true) : dv.setFloat32(0, value as number, true),
      );
    case 'fixed64':
      return writer.fixed(8, (dv) => dv.setBigUint64(0, value as bigint, true));
    case 'sfixed64':
      return writer.fixed(8, (dv) => dv.setBigInt64(0, value as bigint, true));
    case 'double':
      return writer.fixed(8, (dv) =>
        Number.isNaN(value) ? dv.setBigUint64(0, 0x7ff8000000000000n, true) : dv.setFloat64(0, value as number, true),
      );
  }
}

class WireWriter {
  private readonly chunks: Uint8Array[] = [];

  tag(id: number, wireType: number): void {
    this.varint((BigInt(id) << 3n) | BigInt(wireType));
  }

  varint(value: bigint): void {
    const out: number[] = [];
    let v = value;
    do {
      const byte = Number(v & 0x7fn);
      v >>= 7n;
      out.push(v ? byte | 0x80 : byte);
    } while (v);
    this.chunks.push(Uint8Array.from(out));
  }

  fixed(size: 4 | 8, set: (dv: DataView) => void): void {
    const bytes = new Uint8Array(size);
    set(view(bytes));
    this.chunks.push(bytes);
  }

  lengthDelimited(bytes: Uint8Array): void {
    this.varint(BigInt(bytes.length));
    this.chunks.push(bytes);
  }

  bytesField(id: number, bytes: Uint8Array): void {
    this.tag(id, 2);
    this.lengthDelimited(bytes);
  }

  finish(): Uint8Array {
    return concat(this.chunks);
  }
}

// ── Shared helpers ───────────────────────────────────────────────────

function asObject(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CanonicalJsonError(`${where}: expected a JSON object`);
  }
  return value as Record<string, unknown>;
}

function readString(obj: Record<string, unknown>, key: string): string {
  const value = obj[key] ?? null;
  if (value === null) return '';
  if (typeof value !== 'string') throw new CanonicalJsonError(`${key}: expected a string`);
  return value;
}

function readBool(obj: Record<string, unknown>, key: string): boolean {
  const value = obj[key] ?? null;
  if (value === null) return false;
  if (typeof value !== 'boolean') throw new CanonicalJsonError(`${key}: expected true or false`);
  return value;
}

function parseInt64Text(text: string, where: string): bigint {
  if (!/^-?[0-9]+$/.test(text)) throw new CanonicalJsonError(`${where}: ${JSON.stringify(text)} is not an integer`);
  const big = BigInt(text);
  const [min, max] = INT_RANGES.int64!;
  if (big < min || big > max) throw new CanonicalJsonError(`${where}: out of int64 range`);
  return big;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, chunk) => n + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

const utf8 = new TextEncoder();

/** Orders strings by their UTF-8 bytes, as §10.13 rule 5 orders map keys. */
function compareUtf8(a: string, b: string): number {
  const x = utf8.encode(a);
  const y = utf8.encode(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] !== y[i]) return x[i]! - y[i]!;
  }
  return x.length - y.length;
}

function isWellFormed(text: string): boolean {
  return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);
}

// ── Timestamps (§10.11 rule 1) ───────────────────────────────────────

// Date.UTC maps years 0-99 to 1900-1999, so these are spelled out.
const MIN_MS = -62135596800000; // 0001-01-01T00:00:00Z
const MAX_MS = 253402300799999; // 9999-12-31T23:59:59.999Z

/** `YYYY-MM-DDTHH:MM:SSZ`, or with exactly three fraction digits when ms ≠ 0. */
function formatTimestamp(ms: bigint): string {
  if (ms < BigInt(MIN_MS) || ms > BigInt(MAX_MS)) {
    throw new CanonicalJsonError(`timestamp ${ms} ms is outside years 0001-9999`);
  }
  const date = new Date(Number(ms));
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  const base =
    `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
  const millis = date.getUTCMilliseconds();
  return millis === 0 ? `${base}Z` : `${base}.${pad(millis, 3)}Z`;
}

const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:([Zz])|([+-])(\d{2}):(\d{2}))$/;

/** Milliseconds since the epoch for any RFC 3339 timestamp; fraction digits below ms are truncated. */
function parseTimestamp(text: string): bigint {
  const m = RFC3339.exec(text);
  if (!m) throw new CanonicalJsonError(`timestamp ${JSON.stringify(text)} is not RFC 3339`);
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const daysInMonth = [31, isLeap(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const offsetHours = m[10] === undefined ? 0 : Number(m[10]);
  const offsetMinutes = m[11] === undefined ? 0 : Number(m[11]);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth[month - 1]! ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHours > 23 ||
    offsetMinutes > 59
  ) {
    throw new CanonicalJsonError(`timestamp ${JSON.stringify(text)} is not a valid RFC 3339 date-time`);
  }
  const millis = m[7] === undefined ? 0 : Number(m[7].slice(0, 3).padEnd(3, '0'));
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, millis);
  const offset = (offsetHours * 60 + offsetMinutes) * 60_000 * (m[9] === '-' ? -1 : 1);
  return BigInt(date.getTime() - offset);
}

function isLeap(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

// ── Base64 (§10.3) ───────────────────────────────────────────────────

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Standard alphabet with padding (RFC 4648 §4). */
function encodeBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    const chars = Math.ceil((Math.min(3, bytes.length - i) * 8) / 6);
    for (let c = 0; c < 4; c++) out += c < chars ? B64[(n >> (18 - 6 * c)) & 63] : '=';
  }
  return out;
}

/** Standard or URL-safe alphabet, padded or not. */
function decodeBase64(value: unknown, where: string): Uint8Array {
  if (typeof value !== 'string') throw new CanonicalJsonError(`${where}: expected a base64 string`);
  const padded = /^([A-Za-z0-9+/_-]*)(={0,2})$/.exec(value);
  const digits = padded?.[1];
  if (
    digits === undefined ||
    (/[+/]/.test(digits) && /[-_]/.test(digits)) ||
    digits.length % 4 === 1 ||
    (padded![2]!.length > 0 && (digits.length + padded![2]!.length) % 4 !== 0)
  ) {
    throw new CanonicalJsonError(`${where}: not valid base64`);
  }
  const out = new Uint8Array(Math.floor((digits.length * 6) / 8));
  let acc = 0;
  let bits = 0;
  let j = 0;
  for (const ch of digits) {
    const index = ch === '-' ? 62 : ch === '_' ? 63 : B64.indexOf(ch);
    acc = ((acc << 6) | index) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[j++] = (acc >> bits) & 0xff;
    }
  }
  return out;
}
