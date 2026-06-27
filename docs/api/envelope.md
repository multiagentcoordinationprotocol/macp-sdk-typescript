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
  modeVersion: '1.0.0',              // default: DEFAULT_MODE_VERSION
  configurationVersion: 'config.default', // default
  policyVersion: 'policy.default',    // default
  context: { key: 'value' },         // optional: Buffer | string | object
  roots: [{ uri: '...', name: '...' }], // default: []
});
```

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
