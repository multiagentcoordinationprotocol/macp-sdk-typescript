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
  context: { key: 'value' },         // optional: Buffer | string | object
  roots: [{ uri: '...', name: '...' }], // default: []
});
```

`maxSuspendMs` binds a per-session cap on cumulative suspended time before a
SUSPENDED session transitions to EXPIRED (RFC-MACP-0001 §7.5). `0` or absent
selects the runtime's configured default; negative values are rejected. The
runtime records the resolved cap so replay is deterministic. Every mode
session's `start()` accepts `maxSuspendMs` too and threads it here.

`buildCommitmentPayload` note: a Commitment with an **empty** `policyVersion`
matches the session's bound policy on runtime ≥ 0.5.0 (a non-empty value must
equal the resolved policy id exactly). The mode session helpers echo the bound
value automatically; the standalone builder keeps the `'policy.default'` default
for backward compatibility (pass `policyVersion: ''` to opt into empty-echo).

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
});
```

## `encodeContext(context?)`

Encodes context data to a Buffer.

```typescript
import { encodeContext } from 'macp-sdk-typescript';

encodeContext(undefined);              // Buffer.alloc(0)
encodeContext(Buffer.from('data'));     // passed through
encodeContext('hello');                 // Buffer.from('hello', 'utf8')
encodeContext({ key: 'value' });       // Buffer.from(JSON.stringify({key:'value'}), 'utf8')
```

## ID Generators

```typescript
import { newSessionId, newMessageId, newCommitmentId } from 'macp-sdk-typescript';

newSessionId();     // UUIDv4 string
newMessageId();     // UUIDv4 string
newCommitmentId();  // UUIDv4 string
```

## `nowUnixMs()`

Returns current time as a string of milliseconds since epoch.

```typescript
import { nowUnixMs } from 'macp-sdk-typescript';

nowUnixMs();  // e.g., '1711738400000'
```
