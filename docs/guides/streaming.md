# Streaming

## Session Streaming

`MacpStream` provides a bidirectional gRPC stream for real-time session participation. Use it when you want to receive accepted envelopes as they arrive rather than polling.

```typescript
const stream = client.openStream({ auth: Auth.devAgent('observer') });

// Send an envelope through the stream
await stream.send(envelope);

// Consume accepted envelopes as an async iterator
for await (const received of stream.responses()) {
  console.log(received.messageType, received.sender);

  if (received.messageType === 'Commitment') {
    break; // session resolved
  }
}

// Always close when done
stream.close();
```

### Stream Lifecycle

1. `openStream()` opens a duplex gRPC stream
2. `send()` writes envelopes to the stream
3. `responses()` yields accepted envelopes from the server
4. `close()` terminates the stream

Instead of iterating `responses()`, you can pull one envelope at a time with
`read(timeoutMs?)`: it resolves the next envelope, returns `null` once the
stream has ended, and throws `MacpTimeoutError` if `timeoutMs` elapses first
(omit the timeout to wait indefinitely). End-of-stream is sticky — after
`read()` returns `null`, subsequent `read()`/`responses()` calls observe the
end too.

Errors on the stream surface as thrown exceptions from the async iterator:

```typescript
try {
  for await (const envelope of stream.responses()) {
    // process
  }
} catch (err) {
  if (err instanceof MacpTransportError) {
    console.log('stream disconnected:', err.message);
  }
}
```

### Subscribe with history replay (RFC-MACP-0006-A1)

A freshly opened stream only broadcasts envelopes accepted **after** you connect. To also receive envelopes that were accepted earlier in the session, send a subscribe-only frame. The subscribe/replay contract is specified in [RFC-MACP-0006 (Transport Bindings)](https://github.com/multiagentcoordinationprotocol/multiagentcoordinationprotocol/blob/main/rfcs/RFC-MACP-0006-transport-bindings.md) §3.2 (StreamSession) and documented server-side in the [runtime API reference › StreamSession](https://github.com/multiagentcoordinationprotocol/macp-runtime/blob/main/docs/API.md#streamsession).

```typescript
const stream = client.openStream({ auth });

// Replay everything the runtime has accepted so far, then continue live.
await stream.sendSubscribe(sessionId);

// Or resume after a known cursor (e.g. after a reconnect):
await stream.sendSubscribe(sessionId, lastSeenSequence);

for await (const envelope of stream.responses()) {
  // first frames are the replay; then live broadcast follows seamlessly.
}
```

`sendSubscribe(sessionId, afterSequence?)` is how non-initiator agents observe the `SessionStart` and earlier `Proposal` / `Vote` envelopes when they join a session that is already in flight. The `GrpcTransportAdapter` in the agent framework calls this automatically — you only need to call it yourself when driving a raw `MacpStream`.

`afterSequence` is the **1-based accepted-envelope ordinal**, exclusive (`0` = from the start): the Nth accepted envelope has ordinal N. Derive `lastSeenSequence` by counting delivered envelopes (`GrpcTransportAdapter.lastSequence` does this for you). Ordinals are stable across compaction and restart; resuming below a compacted base returns `FAILED_PRECONDITION` (runtime ≥ 0.5.0). See [`sendSubscribe`](../api/client.md#sendsubscribesessionid-aftersequence) for the full contract.

### Important Notes

- `StreamSession` is a server-advertised capability (`sessions.stream`). Check `Initialize` response capabilities before using.
- The stream delivers envelopes in **authoritative acceptance order**, matching the runtime's ordering.
- Late-attach is supported via `sendSubscribe(sessionId, afterSequence?)` — the runtime replays accepted envelopes from that cursor before switching to live broadcast.
- For durable observation, use `getSession()` to fetch current metadata and `sendSubscribe()` to replay the envelope history over the stream.
- Lag recovery (broadcast buffer holds 256 envelopes per session): consumer lag terminates the stream with a coded `MacpTransportError` (`error.code === 'RESOURCE_EXHAUSTED'`). Reconnect and call `sendSubscribe(sessionId, lastSeenSequence)` to resume without missing envelopes. Do **not** reconnect on `UNAUTHENTICATED` — fix auth first. See the runtime's [SDK guide — Handling stream lag](https://github.com/multiagentcoordinationprotocol/macp-runtime/blob/main/docs/sdk-guide.md#handling-stream-lag) for the full recovery contract.

## Mode Registry Watcher

`ModeRegistryWatcher` monitors changes to the runtime's mode registry (registrations, unregistrations, promotions):

```typescript
import { ModeRegistryWatcher } from 'macp-sdk-typescript';

const watcher = new ModeRegistryWatcher(client, { auth });
```

### Async Iterator with AbortSignal

```typescript
const controller = new AbortController();

// Cancel after 30 seconds
setTimeout(() => controller.abort(), 30_000);

for await (const change of watcher.changes(controller.signal)) {
  console.log('mode registry changed at', change.observedAtUnixMs);

  // Refresh mode list
  const modes = await client.listModes();
  const extModes = await client.listExtModes();
}
```

### Callback-Based

```typescript
// Blocks until the stream ends or errors
await watcher.watch(async (change) => {
  console.log('change detected:', change.observedAtUnixMs);
});
```

### One-Shot

Wait for a single change event:

```typescript
const change = await watcher.nextChange();
console.log('first change at', change.observedAtUnixMs);
```

## Roots Watcher

`RootsWatcher` monitors changes to coordination roots/boundaries.

> **Runtime 0.5.0 advertises `roots.list_changed: false`** in its `Initialize`
> capabilities: it serves `ListRoots` but does not emit change notifications, so
> `RootsWatcher` yields nothing against this runtime. Check
> `capabilities.roots.listChanged` from `initialize()` before relying on it.

```typescript
import { RootsWatcher } from 'macp-sdk-typescript';

const watcher = new RootsWatcher(client, { auth });

for await (const change of watcher.changes()) {
  console.log('roots changed at', change.observedAtUnixMs);

  // Refresh root list
  const roots = await client.listRoots();
  console.log('current roots:', roots.roots);
}
```

The API is identical to `ModeRegistryWatcher` — `changes(signal?)`, `watch(handler)`, and `nextChange()`.

## Signal Watcher

`SignalWatcher` subscribes to the ambient signal plane — `Signal` envelopes
sent via `client.sendSignal()` outside any session. Its iterator method is
`signals(signal?)` (not `changes()`), with `watch(handler)` and
`nextSignal()` conveniences:

```typescript
import { SignalWatcher } from 'macp-sdk-typescript';

const watcher = new SignalWatcher(client, { auth });

for await (const envelope of watcher.signals()) {
  console.log('signal:', envelope.messageType, 'from', envelope.sender);
}
```

> **Auth required (runtime 0.5.0).** `WatchSignals` is an authenticated RPC:
> if neither the watcher nor the client has a credential, iterating
> `signals()` throws immediately client-side. A rejected credential surfaces
> as a `MacpTransportError` with `code === 'UNAUTHENTICATED'` — fix auth
> rather than reconnecting. Consumer lag terminates the stream with
> `code === 'RESOURCE_EXHAUSTED'`; there the correct response *is* to
> reconnect.

## Session Lifecycle Watcher

`SessionLifecycleWatcher` streams `CREATED` / `RESOLVED` / `EXPIRED` / `SUSPENDED` / `RESUMED` / `CANCELLED` events for every session visible to the calling identity. Each event carries the full `SessionMetadata`, including `contextId` and `extensionKeys`, so supervisor and projection agents can react to outcomes without polling `getSession()`. (`SUSPENDED`, `RESUMED`, and `CANCELLED` were added in proto 0.1.3 — `CANCELLED` is emitted on an explicit `cancelSession`, distinct from `EXPIRED`.)

```typescript
import { SessionLifecycleWatcher } from 'macp-sdk-typescript';

const watcher = new SessionLifecycleWatcher(client, { auth });
const controller = new AbortController();

for await (const event of watcher.changes(controller.signal)) {
  switch (event.eventType) {
    case 'EVENT_TYPE_CREATED':
      console.log('session started', event.session?.sessionId);
      break;
    case 'EVENT_TYPE_RESOLVED':
      console.log('session finished', event.session?.sessionId);
      break;
    case 'EVENT_TYPE_EXPIRED':
      console.log('session expired', event.session?.sessionId);
      break;
    case 'EVENT_TYPE_SUSPENDED':
      console.log('session suspended', event.session?.sessionId);
      break;
    case 'EVENT_TYPE_RESUMED':
      console.log('session resumed', event.session?.sessionId);
      break;
    case 'EVENT_TYPE_CANCELLED':
      console.log('session cancelled', event.session?.sessionId);
      break;
  }
}
```

The watcher pairs with `client.listSessions()` for initial sync + live tail: list once to fetch currently-open sessions, then attach the watcher for incremental updates. `watch(handler)` and `nextChange()` convenience methods mirror the other watchers.

## Combining Streams

Run multiple watchers concurrently:

```typescript
const controller = new AbortController();

// Watch modes and roots in parallel
await Promise.all([
  (async () => {
    const watcher = new ModeRegistryWatcher(client, { auth });
    for await (const c of watcher.changes(controller.signal)) {
      console.log('mode registry:', c.observedAtUnixMs);
    }
  })(),
  (async () => {
    const watcher = new RootsWatcher(client, { auth });
    for await (const c of watcher.changes(controller.signal)) {
      console.log('roots:', c.observedAtUnixMs);
    }
  })(),
]);
```
