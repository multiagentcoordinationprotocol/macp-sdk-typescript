# MacpClient API Reference

`MacpClient` is the low-level gRPC transport layer. It manages the connection to the MACP runtime and provides typed wrappers for all RPCs.

## Constructor

```typescript
import { MacpClient } from 'macp-sdk-typescript';

const client = new MacpClient({
  address: '127.0.0.1:50051',
  secure: false,
  allowInsecure: true, // required when secure=false; dev-only escape hatch
  auth: Auth.devAgent('agent'),
  rootCertificates: undefined,
  defaultDeadlineMs: 10_000,
  clientName: 'my-app',
  clientVersion: '1.0.0',
  protoDir: '/path/to/proto',
});
```

### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `address` | `string` | *required* | gRPC server address (`host:port`) |
| `secure` | `boolean` | `true` | Use TLS credentials (RFC-MACP-0006 §3) |
| `allowInsecure` | `boolean` | `false` | Required when `secure: false`; constructor throws otherwise |
| `auth` | `AuthConfig` | `undefined` | Default auth for all operations |
| `rootCertificates` | `Buffer` | `undefined` | TLS root CA certificates |
| `defaultDeadlineMs` | `number` | `undefined` | Default RPC deadline (ms) |
| `clientName` | `string` | `'macp-sdk-typescript'` | Client name for Initialize |
| `clientVersion` | `string` | matches SDK package version | Client version for Initialize |
| `protoDir` | `string` | `<pkg>/proto` | Proto definitions directory |

> The constructor throws `MacpSdkError` if `secure: false` is passed without `allowInsecure: true`. This prevents shipping with TLS off by accident.

## Properties

| Property | Type | Description |
|----------|------|-------------|
| `auth` | `AuthConfig \| undefined` | Default auth config |
| `protoRegistry` | `ProtoRegistry` | Protobuf encode/decode registry |

## Methods

### `initialize(deadlineMs?)`

Handshake with the runtime. Negotiates protocol version and exchanges capabilities.

```typescript
const result: InitializeResult = await client.initialize();
// result.selectedProtocolVersion — '1.0'
// result.runtimeInfo — { name, title, version, description, websiteUrl }
// result.supportedModes — ['macp.mode.decision.v1', ...]
// result.capabilities — { sessions: { stream: true }, ... }
// result.instructions — optional human-readable guidance
```

### `send(envelope, options?)`

Send an envelope to the runtime. Returns the Ack.

```typescript
const ack: Ack = await client.send(envelope, {
  auth: Auth.devAgent('agent'),  // override default auth
  deadlineMs: 5000,              // override default deadline
  raiseOnNack: true,             // default: true; throw MacpAckError on nack
});
```

### `getSession(sessionId, options?)`

Query session metadata.

```typescript
const { metadata } = await client.getSession('session-id', { auth, deadlineMs });
// metadata.state — one of SESSION_STATE_OPEN, _RESOLVED, _EXPIRED, _SUSPENDED, _CANCELLED
// metadata.mode — 'macp.mode.decision.v1'
// metadata.startedAtUnixMs, metadata.expiresAtUnixMs
```

### `cancelSession(sessionId, reason, options?)`

Cancel an open session. Returns Ack.

As of proto 0.1.3 the resulting `ack.sessionState` is `SESSION_STATE_CANCELLED`
(previously `SESSION_STATE_EXPIRED`) — distinct from TTL/policy expiry so
consumers can tell an explicit cancellation apart from an expiry.

```typescript
const ack = await client.cancelSession('session-id', 'no longer needed', { auth });
// ack.sessionState === 'SESSION_STATE_CANCELLED'
```

### `suspendSession(sessionId, reason, options?)`

Pause an open session (proto 0.1.3+). Returns Ack. Suspension is **non-terminal**:
the runtime banks the session's remaining TTL, rejects any messages sent while
suspended, and surfaces `ack.sessionState === 'SESSION_STATE_SUSPENDED'`.
Restricted to the initiator and policy-delegated roles, mirroring `cancelSession`.

```typescript
const ack = await client.suspendSession('session-id', 'pausing work', { auth });
// ack.sessionState === 'SESSION_STATE_SUSPENDED'
```

### `resumeSession(sessionId, reason, options?)`

Resume a suspended session (proto 0.1.3+). Returns Ack. Restores
`SESSION_STATE_OPEN` and adds the banked TTL back to the session's absolute
deadline.

```typescript
const ack = await client.resumeSession('session-id', 'back to work', { auth });
// ack.sessionState === 'SESSION_STATE_OPEN'
```

### `listSessions(options?)`

Enumerate sessions visible to the calling identity. Returns an array of
`SessionMetadata` (including `contextId` and `extensionKeys` when set).
Missing/empty responses normalise to `[]`.

```typescript
const sessions = await client.listSessions({ auth });
for (const s of sessions) {
  console.log(s.sessionId, s.state, s.contextId, s.extensionKeys);
}
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `auth` | `AuthConfig` | client auth | Override the default identity. |
| `deadlineMs` | `number` | client default | Deadline for the unary call. |

### `getManifest(agentId?, deadlineMs?)`

Retrieve an agent or runtime manifest.

```typescript
const { manifest } = await client.getManifest();       // self manifest
const { manifest } = await client.getManifest('other'); // another agent
```

### `listModes(deadlineMs?)`

List standards-track modes.

```typescript
const { modes } = await client.listModes();
// modes: ModeDescriptor[]
```

### `listExtModes(deadlineMs?)`

List dynamically registered extension modes.

```typescript
const { modes } = await client.listExtModes();
```

### `listRoots(deadlineMs?)`

List coordination roots/boundaries.

```typescript
const { roots } = await client.listRoots();
// roots: Root[] — [{ uri, name }]
```

### `registerExtMode(descriptor, options?)`

Register a dynamic extension mode.

```typescript
const result = await client.registerExtMode({
  mode: 'ext.custom.v1',
  modeVersion: '1.0.0',
  title: 'Custom Mode',
  description: 'My custom coordination mode',
  messageTypes: ['CustomMsg'],
  terminalMessageTypes: ['Commitment'],
}, { auth });
```

### `unregisterExtMode(mode, options?)`

Remove a dynamically registered extension mode.

```typescript
const result = await client.unregisterExtMode('ext.custom.v1', { auth });
```

### `promoteMode(mode, promotedModeName?, options?)`

Promote an extension mode to standards-track.

```typescript
const result = await client.promoteMode('ext.custom.v1', 'macp.mode.custom.v1', { auth });
```

### `openStream(options?)`

Open a bidirectional session stream.

```typescript
const stream: MacpStream = client.openStream({ auth });
```

### `senderHint(auth?)`

Get the sender identity hint from the given or default auth config.

```typescript
const sender: string | undefined = client.senderHint();
```

### `close()`

Close the gRPC connection.

```typescript
client.close();
```

## MacpStream

Wraps a gRPC duplex stream for session streaming.

### `send(envelope)`

Write an envelope to the stream.

```typescript
await stream.send(envelope);
```

### `sendSubscribe(sessionId, afterSequence?)`

Send a subscribe-only frame so the runtime replays accepted envelopes for the
session from `afterSequence` onwards, then continues with live broadcast
(RFC-MACP-0006-A1). Use this to attach a late observer to a session that is
already in flight, or to resume after a reconnect with a replay cursor.

```typescript
// Fresh subscriber — replay everything, then keep streaming live.
await stream.sendSubscribe('session-abc');

// Resume after a reconnect with a known cursor.
await stream.sendSubscribe('session-abc', lastSeenSequence);
```

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `sessionId` | `string` | *required* | Session to subscribe to |
| `afterSequence` | `number` | `0` | Replay envelopes with `seq > afterSequence`. Pass `0` for a full replay. |

Rejects with `MacpSdkError` if the stream has already been closed. The agent
framework's `GrpcTransportAdapter` calls this automatically after opening the
stream, so you only need it when driving a raw `MacpStream`.

### `responses()`

Async generator yielding received envelopes.

```typescript
for await (const envelope of stream.responses()) {
  console.log(envelope.messageType);
}
```

### `close()`

End the stream.

```typescript
stream.close();
```
