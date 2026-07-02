import * as path from 'node:path';
import protobuf from 'protobufjs';
import { MODE_DECISION, MODE_HANDOFF, MODE_MULTI_ROUND, MODE_PROPOSAL, MODE_QUORUM, MODE_TASK } from './constants';

const CORE_MAP: Record<string, string> = {
  SessionStart: 'macp.v1.SessionStartPayload',
  Commitment: 'macp.v1.CommitmentPayload',
  Signal: 'macp.v1.SignalPayload',
  Progress: 'macp.v1.ProgressPayload',
};

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
    Contribute: '__json__',
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
    return this.decodeMessage(typeName, payload);
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
