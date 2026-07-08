# Cancel Callback Server API Reference

An HTTP endpoint that a `Participant` listens on so an external orchestrator
(e.g. the control-plane or examples-service) can request an agent shutdown
without needing a gRPC channel back. This is RFC-MACP-0001 §7.2 Option A.

The server is a thin wrapper around Node's built-in `http` module — zero extra
dependencies. Parity with the Python SDK's
`macp_sdk.agent.cancel_callback` module.

## When to use it

Reach for this when:

- You run a long-lived `Participant.run()` loop and need a deterministic way to
  stop it from outside the process.
- Your bootstrap orchestrator already supplies a `cancel_callback` field (the
  common path for agents spawned by the MACP examples-service).
- You want the stop signal to arrive even if the gRPC stream is wedged.

Prefer it over wrapping your own HTTP server inside the agent process: using
the SDK helper keeps the payload shape and lifecycle identical across
TypeScript and Python agents.

## Contract

- Request: `POST <path>` with JSON body `{"runId": "...", "reason": "..."}`
  (snake\_case `run_id` is also accepted for parity with the Python SDK).
- Response: `202 Accepted` with body `{"ok":true}` when the handler resolves.
  `500` if the handler throws. `404` for any other path or method.
- The server binds a single path. For multiple endpoints, start multiple
  servers.

## API

### `startCancelCallbackServer(options)`

```typescript
import { agent } from 'macp-sdk-typescript';

const server = await agent.startCancelCallbackServer({
  host: '127.0.0.1',
  port: 0,                             // 0 = ephemeral, read `server.port` after
  path: '/cancel',
  onCancel: async (runId, reason) => {
    console.log(`cancel received for ${runId}: ${reason}`);
    await participant.stop();
  },
});

console.log(`listening on http://${server.host}:${server.port}${server.path}`);
```

**Options**

| Field | Type | Description |
|-------|------|-------------|
| `host` | `string` | Bind address. Use `127.0.0.1` for local-only. |
| `port` | `number` | Bind port. Pass `0` to get an ephemeral one (read back from `server.port`). |
| `path` | `string` | URL path to handle. Leading slash is added automatically. |
| `onCancel` | `(runId, reason) => void \| Promise<void>` | Handler called when a valid POST arrives. Exceptions return `500` to the caller. |

**Returns** `Promise<CancelCallbackServer>`.

### `CancelCallbackServer`

```typescript
interface CancelCallbackServer {
  readonly host: string;      // actual bound host (post-listen)
  readonly port: number;      // actual bound port (post-listen)
  readonly path: string;      // normalised path, always starts with '/'
  close(): Promise<void>;     // idempotent
}
```

`close()` is idempotent; call it from your process shutdown handler if you
started the server outside a `Participant`.

### `CancelHandler`

```typescript
type CancelHandler = (runId: string, reason: string) => void | Promise<void>;
```

## Wiring it to a `Participant`

Two ways:

### 1. Via the bootstrap payload (preferred)

`Runner.fromBootstrap()` auto-wires the server. Include `cancel_callback` in
the bootstrap JSON and the server starts on `participant.run()`, forwards
cancels to `participant.stop()`, and is torn down when `run()` returns:

```json
{
  "session_id": "sid-123",
  "participant_id": "agent-1",
  "mode": "macp.mode.decision.v1",
  "runtime_address": "localhost:50051",
  "cancel_callback": {
    "host": "127.0.0.1",
    "port": 47321,
    "path": "/cancel"
  }
}
```

### 2. Manually (advanced)

```typescript
import { agent } from 'macp-sdk-typescript';

const server = await agent.startCancelCallbackServer({
  host: '127.0.0.1',
  port: 0,
  path: '/cancel',
  onCancel: () => participant.stop(),
});
participant.attachCancelCallbackServer(server);
```

`attachCancelCallbackServer(server)` hands ownership to the `Participant`;
teardown happens automatically when `run()` exits.

## Lifecycle

```
fromBootstrap()             ── reads cancel_callback from JSON
      │
      ▼
participant.run()           ── startCancelCallbackServer() fires
      │
      ▼
POST /cancel arrives        ── onCancel → participant.stop()
      │
      ▼
run() loop breaks, finally  ── server.close() in teardown
      │
      ▼
server listening sockets released
```

## Example

See [`examples/cancel-callback.ts`](../../examples/cancel-callback.ts).

## Related

- [`docs/guides/agent-framework.md`](../guides/agent-framework.md) — `Participant` lifecycle
- [`docs/api/runner.md`](./runner.md) — `fromBootstrap()` bootstrap schema *(if present — see `agent-framework.md` otherwise)*
- RFC-MACP-0001 §7.2 — cancellation delivery options
