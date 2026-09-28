import * as path from 'node:path';
import protobuf from 'protobufjs';
import { MODE_DECISION, MODE_HANDOFF, MODE_MULTI_ROUND, MODE_PROPOSAL, MODE_QUORUM, MODE_TASK } from './constants';

const CORE_MAP: Record<string, string> = {
  SessionStart: 'macp.v1.SessionStartPayload',
  Commitment: 'macp.v1.CommitmentPayload',
  Signal: 'macp.v1.SignalPayload',
  Progress: 'macp.v1.ProgressPayload',
};

// The one mapping whose historical payloads may be legacy JSON. Runtime replays
// pre-proto histories byte-identically, so decode must accept both encodings.
const MULTI_ROUND_CONTRIBUTE = 'macp.modes.multi_round.v1.ContributePayload';

const MODE_MAP: Record<string, Record<string, string>> = {
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
  [MODE_MULTI_ROUND]: {
    // Canonical protobuf as of proto 0.1.4 / runtime 0.5.0. Encode is always
    // protobuf; decode tries legacy JSON (`{"value":"..."}`) first, then
    // protobuf — see `MULTI_ROUND_CONTRIBUTE` handling in decodeKnownPayload.
    Contribute: MULTI_ROUND_CONTRIBUTE,
  },
};

const PROTO_FILES = [
  'macp/v1/core.proto',
  'macp/v1/envelope.proto',
  'macp/v1/policy.proto',
  'macp/modes/decision/v1/decision.proto',
  'macp/modes/proposal/v1/proposal.proto',
  'macp/modes/task/v1/task.proto',
  'macp/modes/handoff/v1/handoff.proto',
  'macp/modes/quorum/v1/quorum.proto',
  'macp/modes/multi_round/v1/multi_round.proto',
];

export class ProtoRegistry {
  readonly protoDir: string;
  private root: protobuf.Root;

  constructor(protoDir?: string) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { protoDir: defaultProtoDir } = require('@multiagentcoordinationprotocol/proto');
    this.protoDir = path.resolve(protoDir ?? defaultProtoDir);
    this.root = new protobuf.Root();
    this.root.resolvePath = (_origin, target) => {
      if (path.isAbsolute(target)) return target;
      return path.join(this.protoDir, target);
    };
    this.root.loadSync(PROTO_FILES.map((file) => path.join(this.protoDir, file)));
    this.root.resolveAll();
  }

  getKnownTypeName(mode: string, messageType: string): string | undefined {
    return MODE_MAP[mode]?.[messageType] ?? CORE_MAP[messageType];
  }

  encodeMessage(typeName: string, value: Record<string, unknown>): Buffer {
    const type = this.lookupType(typeName);
    const message = type.fromObject(value);
    return Buffer.from(type.encode(message).finish());
  }

  decodeMessage(typeName: string, payload: Buffer): Record<string, unknown> {
    const type = this.lookupType(typeName);
    const decoded = type.decode(payload);
    const obj = type.toObject(decoded, {
      longs: String,
      enums: String,
      bytes: Buffer,
      defaults: false,
    }) as Record<string, unknown>;
    // proto3 omits default-valued scalars on the wire; protobufjs (>=8.6) drops
    // them again on decode with `defaults:false`. For a `bool` that means an
    // explicit `false` — e.g. `Commitment.outcome_positive` on a negative
    // (decline) outcome — decodes as *absent*, indistinguishable from unset and
    // silently mis-read as positive. Materialize proto3 bool defaults so the
    // read-model always sees the real boolean, mirroring Python protobuf where a
    // schema bool field is always present.
    for (const field of type.fieldsArray) {
      if (field.type === 'bool' && !field.repeated && obj[field.name] === undefined) {
        obj[field.name] = false;
      }
    }
    return obj;
  }

  encodeKnownPayload(mode: string, messageType: string, value: Record<string, unknown>): Buffer {
    const typeName = this.getKnownTypeName(mode, messageType);
    if (!typeName) throw new Error(`unknown payload mapping for ${mode}/${messageType}`);
    if (typeName === '__json__') return Buffer.from(JSON.stringify(value), 'utf8');
    return this.encodeMessage(typeName, value);
  }

  decodeKnownPayload(mode: string, messageType: string, payload: Buffer): Record<string, unknown> | undefined {
    const typeName = this.getKnownTypeName(mode, messageType);
    if (!typeName) return this.tryDecodeUtf8(payload);
    if (typeName === '__json__') return this.tryDecodeUtf8(payload);
    if (typeName === MULTI_ROUND_CONTRIBUTE) return this.decodeMultiRoundContribute(payload);
    return this.decodeMessage(typeName, payload);
  }

  /**
   * Decode an `ext.multi_round.v1` `Contribute` payload, accepting both wire
   * formats: legacy JSON (`{"value":"..."}`, still replayed verbatim from
   * pre-proto histories) and canonical protobuf (`ContributePayload`). Both
   * normalize to `{ value }`, but only the protobuf path's `value` is always
   * a `string` — the legacy-JSON path passes `parsed.value` through exactly
   * as `JSON.parse` produced it (issue #124: no `String(...)` coercion, no
   * `?? ''` fallback for an absent key), so `value` may be `undefined`,
   * `null`, a number, a boolean, or an object/array for malformed-but-valid
   * legacy JSON. This method's own contract is observational, not a gate —
   * see the `contribute_acceptance` note below.
   *
   * Parse-then-fallback (issue #93), not a first-byte shortcut: JSON is always
   * attempted first, and only a `JSON.parse` failure falls through to
   * protobuf. A first-byte check (`{` = 0x7b vs proto field-1 tag 0x0A) does
   * not generalize — e.g. legacy JSON with leading whitespace has neither byte
   * first, and used to reach `decodeMessage` and throw. Parity with
   * `macp-sdk-python`'s `_decode_json_first_then_proto`, which has always
   * worked this way.
   *
   * **A successful `JSON.parse` is not proof the bytes are legacy JSON**
   * (issue #104 — this method's prior "essentially never also syntactically
   * valid JSON" claim was false, not merely imprecise): the canonical proto
   * tag byte for field 1 (`0x0A`) is itself insignificant JSON whitespace, so
   * for specific value byte-lengths the length varint — or, when the varint
   * is itself whitespace, the value's own leading byte — becomes the first
   * significant character `JSON.parse` sees, and a genuine `ContributePayload`
   * silently misreads as a JSON number/string/object. Verified directly
   * (encode-then-decode sweep, value lengths 1-127, seven value shapes): every
   * one of lengths 9, 10, 13, 32, 34, 45, 48, 49-57, and 123 corrupted before
   * `isCanonicalProto` below, most to total silent data loss
   * (`String(undefined ?? '') === ''`), zero corrupt after.
   *
   * `isCanonicalProto` resolves the ambiguity by tie-break, not by refusing
   * to try JSON first: bytes that parse as JSON *and* are the exact canonical
   * proto encoding are treated as proto. This has a narrow, priced cost on
   * the reverse direction (legacy JSON misread as proto) that it introduces
   * rather than merely fails to close — see `isCanonicalProto`'s own
   * docblock.
   *
   * An empty payload falls through the same path: `JSON.parse('')` throws, so
   * it reaches `decodeMessage` on zero bytes, which yields `{}` (proto3
   * defaults) rather than a decode error. This SDK's decode layer is
   * observational, not an acceptance gate — whether an empty `Contribute`
   * should be rejected is a runtime-acceptance question (tracked cross-repo,
   * `contribute_acceptance.empty_payload` in `schemas/parity/contract.json`,
   * currently `macp-runtime`-only), not something this method decides.
   */
  private decodeMultiRoundContribute(payload: Buffer): Record<string, unknown> | undefined {
    try {
      const parsed = JSON.parse(payload.toString('utf8')) as Record<string, unknown>;
      if (!this.isCanonicalProto(MULTI_ROUND_CONTRIBUTE, payload)) {
        return { value: parsed.value };
      }
    } catch {
      // Not JSON at all — fall through to the protobuf decode below.
    }
    return this.decodeMessage(MULTI_ROUND_CONTRIBUTE, payload);
  }

  /**
   * True iff `payload` is the exact canonical protobuf encoding of
   * `typeName` — used to break the JSON/proto ambiguity in
   * `decodeMultiRoundContribute` (issue #104): bytes that both parse as JSON
   * *and* round-trip byte-identically through the proto message are treated
   * as proto, not JSON.
   *
   * `macp-sdk-python`'s equivalent (`_is_canonical_proto`) needs an explicit
   * `DiscardUnknownFields()` step before comparing, because Python's protobuf
   * runtime preserves unknown fields verbatim through
   * `ParseFromString`/`SerializeToString` by default — without it, a plain
   * round-trip check misclassified several whitespace-prefixed legacy-JSON
   * payloads as canonical proto. **`protobufjs` needs no equivalent step**:
   * verified directly (a synthetic payload with a declared field-1 string
   * plus an undeclared field 2) that `Type.decode()` silently drops fields
   * not in the schema rather than preserving them, so `Type.encode()` can
   * never reproduce bytes it never captured — a byte-exact round-trip here
   * is already proof the payload is *exactly* the single-field encoding, no
   * unknown fields possible. Confirmed this closes the same
   * whitespace-prefixed false-positive class `DiscardUnknownFields` closes
   * in Python (tab/space-prefixed legacy JSON at several lengths).
   *
   * One narrow, symmetric residual survives regardless — genuinely
   * irreducible, not a gap this check merely fails to close: a payload whose
   * first byte is a literal `0x0A` (`\n`) and whose remainder forms a
   * complete, well-formed proto field-1 string with nothing left over has no
   * unknown field for either implementation to expose a mismatch on, because
   * it *is*, byte for byte, both a legal JSON reading and the canonical
   * proto encoding of some (possibly nonsensical) string. Verified instances
   * (this SDK's own `JSON.stringify`, which — unlike Python's `json.dumps`
   * — omits the space after `:`, shifting the colliding lengths by one byte
   * from `macp-sdk-python`'s pinned cases): `'\n' + JSON.stringify({value:
   * 'z'.repeat(112)})`, and with one extra whitespace byte inserted after the
   * `\n`, `'\r'` at value length 1 and `' '` at value length 20. A real
   * legacy-JSON sender would need to deliberately prefix with a literal
   * newline byte for this to matter — this SDK's own JSON producers never
   * emit one — so the trade (fixing the ordinary, naturally-reachable
   * forward-direction corruption above at the cost of this adversarial,
   * unreachable-by-any-known-encoder reverse case) is the right one.
   */
  private isCanonicalProto(typeName: string, payload: Buffer): boolean {
    try {
      const type = this.lookupType(typeName);
      const decoded = type.decode(payload);
      return Buffer.from(type.encode(decoded).finish()).equals(payload);
    } catch {
      return false;
    }
  }

  private lookupType(typeName: string): protobuf.Type {
    const lookedUp = this.root.lookupType(typeName);
    if (!(lookedUp instanceof protobuf.Type)) throw new Error(`protobuf type '${typeName}' not found`);
    return lookedUp;
  }

  private tryDecodeUtf8(payload: Buffer): Record<string, unknown> | undefined {
    if (!payload.length) return undefined;
    const text = payload.toString('utf8');
    try {
      return { encoding: 'json', json: JSON.parse(text) as Record<string, unknown> };
    } catch {
      return { encoding: 'text', text, payloadBase64: payload.toString('base64') };
    }
  }
}
