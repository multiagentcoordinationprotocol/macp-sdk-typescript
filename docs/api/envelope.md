# Envelope Builders API Reference

Utility functions for constructing MACP envelopes and payloads.

## `buildEnvelope(input)`

Constructs a canonical MACP Envelope with sensible defaults.

```typescript
import { buildEnvelope } from 'macp-sdk-typescript';

const envelope = buildEnvelope({
  mode: 'macp.mode.decision.v1',    // required
  messageType: 'Proposal',           // required
  sessionId: 'session-uuid',         // required
  payload: encodedBuffer,            // required (Buffer)
  sender: 'agent-a',                 // default: ''
  messageId: undefined,              // default: auto-generated UUID
  macpVersion: undefined,            // default: MACP_VERSION ('1.0')
  timestampUnixMs: undefined,        // default: Date.now() as string
});
```

### Auto-Generated Fields

| Field | Default |
|-------|---------|
| `macpVersion` | `MACP_VERSION` (`'1.0'`) |
| `messageId` | `randomUUID()` |
| `timestampUnixMs` | `String(Date.now())` |
| `sender` | `''` |

## `buildSessionStartPayload(input)`

Constructs a `SessionStartPayload` object.

```typescript
import { buildSessionStartPayload } from 'macp-sdk-typescript';

const payload = buildSessionStartPayload({
  intent: 'decide something',        // required
  participants: ['alice', 'bob'],     // required
  ttlMs: 60_000,                     // required
  maxSuspendMs: 3_600_000,           // optional; 0/absent = runtime default (7 days). proto ≥ 0.1.5
  modeVersion: '1.0.0',              // default: DEFAULT_MODE_VERSION
  configurationVersion: 'config.default', // default
  policyVersion: 'policy.default',    // default
  contextId: 'ctx-123',              // optional; default: ''
  extensions: { 'ext.key': Buffer.from('...') }, // optional; default: {}
  roots: [{ uri: '...', name: '...' }], // default: []
});
```

`maxSuspendMs` binds a per-session cap on cumulative suspended time before a
SUSPENDED session transitions to EXPIRED ([RFC-MACP-0001 (Core)](https://github.com/multiagentcoordinationprotocol/multiagentcoordinationprotocol/blob/main/rfcs/RFC-MACP-0001-core.md) §7.5). `0` or absent
selects the runtime's configured default; negative values are rejected. The
runtime records the resolved cap so replay is deterministic. Every mode
session's `start()` accepts `maxSuspendMs` too and threads it here.

## `buildCommitmentPayload(input)`

Constructs a `CommitmentPayload` object.

```typescript
import { buildCommitmentPayload } from 'macp-sdk-typescript';

const payload = buildCommitmentPayload({
  action: 'deployment.approved',      // required
  authorityScope: 'release-mgmt',     // required
  reason: 'approved by team',         // required
  commitmentId: undefined,            // default: auto-generated UUID
  modeVersion: '1.0.0',              // default
  configurationVersion: 'config.default',
  policyVersion: 'policy.default',
  outcomePositive: undefined,         // default: inferOutcomePositive(action)
  supersedes: undefined,              // optional CommitmentRef (cross-session supersession)
});
```

Policy-version echo (runtime ≥ 0.5.0): a Commitment with an **empty**
`policyVersion` matches the session's bound policy (a non-empty value must
equal the resolved policy id exactly). The mode session helpers echo the bound
value automatically; the standalone builder keeps the `'policy.default'` default
for backward compatibility (pass `policyVersion: ''` to opt into empty-echo —
`''` is not coalesced by the default).

## `inferOutcomePositive(action)`

Infers a commitment's outcome polarity from its action string: returns `false`
when the lowercased action ends with `'rejected'`, `'failed'`, or `'declined'`;
`true` otherwise. Used as the `outcomePositive` default in
`buildCommitmentPayload` and the agent framework's commitment strategies.

```typescript
import { inferOutcomePositive } from 'macp-sdk-typescript';

inferOutcomePositive('deployment.approved'); // true
inferOutcomePositive('deployment.rejected'); // false
```

## `buildCommitmentRef(input)`

Builds a `CommitmentRef` pointing at a prior accepted commitment, for use as
`buildCommitmentPayload({ supersedes })` (cross-session supersession,
RFC-MACP-0001 §7.3).

```typescript
import { buildCommitmentRef } from 'macp-sdk-typescript';

const ref = buildCommitmentRef({ sessionId: 'old-session', commitmentHash: 'abc123' });
```

## `buildSignalPayload(input)` / `buildProgressPayload(input)`

Ambient-plane payload builders used by `client.sendSignal()` and
`client.sendProgress()`.

```typescript
buildSignalPayload({ signalType: 'ext.signal.x', data, confidence, correlationSessionId });
buildProgressPayload({ progressToken: 't', progress: 1, total: 10, message, targetMessageId });
```

Omitted optional fields normalise to protobuf zero values (`0`, `''`, empty
`Buffer`).

## `buildRoot(uri, name?)`

Constructs a `Root` (`{ uri, name }`); `name` defaults to `''`.

## ID Generators

```typescript
import { newSessionId, newMessageId, newCommitmentId } from 'macp-sdk-typescript';

newSessionId();     // UUIDv4 string
newMessageId();     // UUIDv4 string
newCommitmentId();  // UUIDv4 string
```

## `nowUnixMs()`

Returns the current time as a `number` of milliseconds since epoch
(`Date.now()`). `buildEnvelope` stringifies it when populating
`timestampUnixMs`.

```typescript
import { nowUnixMs } from 'macp-sdk-typescript';

nowUnixMs();  // e.g., 1711738400000
```

## `serializeMessage(message)`

Serializes a protobuf message object by invoking its own serializer — supports
`serializeBinary()` (protoc-gen-js), `toBinary()` (protobuf-es / ts-proto), or
`finish()` (protobufjs Writer). Throws `TypeError` for plain objects; for plain
JS interface payloads use `ProtoRegistry.encodeKnownPayload()` instead.

## `toProtoPayload(input)`

Type-erasure helper: casts a typed payload interface to the
`Record<string, unknown>` that `ProtoRegistry.encodeKnownPayload()` accepts.
Never narrows or copies.
