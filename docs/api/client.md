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
| `protoDir` | `string` | `@multiagentcoordinationprotocol/proto`'s `protoDir` | Override the proto definitions directory |

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

A duplicate ack (`ack.duplicate === true`) is treated as success and returned
without throwing — the message was already accepted.

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

Enumerate **all** sessions visible to the calling identity. Returns an array of
`SessionMetadata` (including `contextId` and `extensionKeys` when set).
Missing/empty responses normalise to `[]`.

As of proto ≥ 0.1.6 the runtime may cap a single `ListSessions` response and
return a `nextPageToken`. `listSessions()` transparently walks every page until
the token is empty, so the returned array is always the complete listing. For
manual page control use [`listSessionsPage`](#listsessionspageoptions).

```typescript
const sessions = await client.listSessions({ auth });
for (const s of sessions) {
  console.log(s.sessionId, s.state, s.contextId, s.extensionKeys);
}
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `pageSize` | `number` | server default | Per-request page cap while auto-paginating. `0` lets the server choose. |
| `auth` | `AuthConfig` | client auth | Override the default identity. |
| `deadlineMs` | `number` | client default | Deadline for each unary call. |

### `listSessionsPage(options?)`

Fetch a **single** page of sessions. Returns `{ sessions, nextPageToken }`.
Callers MUST NOT assume the listing is complete unless `nextPageToken` is empty.
Pass a returned non-empty `nextPageToken` back as `pageToken` to fetch the next
page; a **stale** token yields `INVALID_ARGUMENT` (inspect via
`MacpTransportError.code`).

```typescript
let pageToken = '';
do {
  const { sessions, nextPageToken } = await client.listSessionsPage({ pageSize: 50, pageToken, auth });
  for (const s of sessions) console.log(s.sessionId);
  pageToken = nextPageToken;
} while (pageToken);
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `pageSize` | `number` | server default | Max sessions to return. `0` = server-chosen; the server MAY cap it. |
| `pageToken` | `string` | `''` | Continuation token from a previous page. Empty = first page. |
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
  messageTypes: ['CustomMsg', 'Commitment'],
  terminalMessageTypes: ['Commitment'],
}, { auth });
```

Guardrails (runtime ≥ 0.5.0):

- The descriptor **must** list `'Commitment'` in `terminalMessageTypes` — a mode
  without a terminal `Commitment` can never resolve. The SDK throws
  `MacpSessionError` before the wire call if it's missing (mirrors the runtime).
- `promoteMode` into the reserved `macp.mode.*` namespace is rejected.
- A `SessionStart` with an empty `mode_version` binds the registered descriptor's
  `modeVersion`; a later `Commitment` must echo that bound version. `BaseSession`
  defaults `modeVersion` to `'1.0.0'`, so set the descriptor's version to match
  (or override the session's `modeVersion`) or the commitment will mismatch.

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

### `registerPolicy(descriptor, options?)`

Register a governance policy. Returns `{ ok, error? }`. Build the descriptor
with the typed builders in [policy.md](policy.md) rather than by hand.

```typescript
const result = await client.registerPolicy(descriptor, { auth });
```

### `unregisterPolicy(policyId, options?)`

Remove a registered policy. Returns `{ ok, error? }`.

```typescript
const result = await client.unregisterPolicy('policy-id', { auth });
```

### `getPolicy(policyId, options?)`

Fetch a single policy descriptor. Returns the `PolicyDescriptor` directly
(not wrapped in a response object).

```typescript
const descriptor: PolicyDescriptor = await client.getPolicy('policy-id', { auth });
```

### `listPolicies(mode?, options?)`

List registered policies, optionally filtered by mode. Returns
`PolicyDescriptor[]` (missing/empty responses normalise to `[]`).

```typescript
const all = await client.listPolicies(undefined, { auth });
const decisionOnly = await client.listPolicies('macp.mode.decision.v1', { auth });
```

### `openStream(options?)`

Open a bidirectional session stream. Requires auth (throws `MacpSdkError` if
neither `options.auth` nor the client default is set).

```typescript
const stream: MacpStream = client.openStream({ auth });
```

### `sendSignal(options)`

Convenience wrapper for the ambient signal plane: builds, encodes and sends a
`Signal` envelope in one call. Returns the Ack.

```typescript
const ack = await client.sendSignal({
  signalType: 'ext.signal.heartbeat',   // required; validated client-side
  data: Buffer.from('{}'),              // optional payload bytes
  confidence: 0.9,                      // optional
  correlationSessionId: 'session-id',   // optional
  sender: 'alice',                      // optional; defaults to senderHint()
  auth,                                 // optional; defaults to client auth
  deadlineMs: 5000,                     // optional
});
```

Throws `MacpIdentityMismatchError` if `sender` conflicts with the auth config's
`expectedSender`.

### `sendProgress(options)`

Convenience wrapper for `Progress` messages. Returns the Ack.

```typescript
const ack = await client.sendProgress({
  sessionId: 'session-id',
  mode: 'macp.mode.task.v1',
  progressToken: 'token-1',   // required
  progress: 3,                // required
  total: 10,                  // required
  message: '3 of 10 done',    // optional
  targetMessageId: 'msg-id',  // optional
  auth,
});
```

### Watch methods

Server-streaming RPCs that return a raw `grpc.ClientReadableStream`. Prefer the
watcher classes in `src/watchers.ts` (`ModeRegistryWatcher`, `RootsWatcher`,
`SignalWatcher`, `PolicyWatcher`, `SessionLifecycleWatcher`), which wrap these
in async generators. The deprecated `_`-prefixed aliases (`_watchModeRegistry`,
etc.) were **removed in 0.5.0** — use the names below.

| Method | RPC | Auth |
|--------|-----|------|
| `watchModeRegistry(auth?)` | `WatchModeRegistry` | optional |
| `watchRoots(auth?)` | `WatchRoots` | optional |
| `watchSignals(auth?)` | `WatchSignals` | **required** (runtime ≥ 0.5.0) |
| `watchSessions(auth?)` | `WatchSessions` | optional |
| `watchPolicies(auth?)` | `WatchPolicies` | optional |

`watchSignals` throws `MacpSdkError` client-side when no auth is available
(neither the argument nor `client.auth`), rather than failing later with a
stream `UNAUTHENTICATED`.

```typescript
const call = client.watchSignals(auth);
call.on('data', (event) => console.log(event));
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
| `afterSequence` | `number` | `0` | Exclusive cursor: replay envelopes whose ordinal is `> afterSequence`. Pass `0` for a full replay. |

**Ordinal contract (runtime ≥ 0.5.0, RFC-MACP-0006 §3.2):** `afterSequence` is
the **1-based accepted-envelope ordinal** — the Nth accepted envelope has
ordinal N. Clients derive it by counting delivered envelopes; the agent
framework's `GrpcTransportAdapter` exposes this as its `lastSequence` getter.
Ordinals are **stable across log compaction and runtime restart**, and envelopes
accepted during the subscribe window are never delivered twice. Resuming **below
a compacted base** fails with `FAILED_PRECONDITION` (inspect via
`MacpTransportError.code`) rather than silently skipping history.

Rejects with `MacpSdkError` if the stream has already been closed. The agent
framework's `GrpcTransportAdapter` calls this automatically after opening the
stream, so you only need it when driving a raw `MacpStream`.

### `responses()`

Async generator yielding received envelopes. Throws `MacpTransportError` if the
underlying stream errors; returns when the stream ends.

```typescript
for await (const envelope of stream.responses()) {
  console.log(envelope.messageType);
}
```

### `read(timeoutMs?)`

Read a single envelope from the stream (parity with the Python SDK's
`MacpStream.read(timeout)`). Returns the next envelope, or `null` if the stream
has ended. If `timeoutMs` is omitted, blocks until an envelope arrives, the
stream ends, or an error occurs.

```typescript
const envelope = await stream.read(5000); // Envelope | null
```

Throws `MacpTimeoutError` if `timeoutMs` elapses first, and
`MacpTransportError` if the underlying stream errored.

### `onInlineError(callback)`

Register a callback for inline application-level errors delivered on the stream
(`response.error` frames). The stream stays open when these arrive — they are
not transport failures.

```typescript
stream.onInlineError(({ code, message }) => {
  console.warn('inline error', code, message);
});
```

### `close()`

End the stream. Idempotent; subsequent `send()`/`sendSubscribe()` calls reject
with `MacpSdkError`.

```typescript
stream.close();
```

## `grpcStatusName(code)`

Top-level export mapping a numeric gRPC status code to its name (e.g. `8` →
`'RESOURCE_EXHAUSTED'`). Returns `undefined` for non-numeric or unknown codes.
The SDK uses it to populate `MacpTransportError.code`.

```typescript
import { grpcStatusName } from 'macp-sdk-typescript';

grpcStatusName(9); // 'FAILED_PRECONDITION'
```
