# Session Discovery

The SDK wraps the runtime's `ListSessions` and `WatchSessions` RPCs. Together they let
orchestrators and supervisor agents enumerate active sessions and react to lifecycle
events (`CREATED` / `RESOLVED` / `EXPIRED` / `CANCELLED` / `SUSPENDED` / `RESUMED`)
without polling `getSession()`.

For the underlying RPC contracts (request/response shapes, scoping rules), see
[Runtime API § Discovery](https://github.com/multiagentcoordinationprotocol/macp-runtime/blob/main/docs/API.md#discovery)
and [§ Streaming Watches](https://github.com/multiagentcoordinationprotocol/macp-runtime/blob/main/docs/API.md#streaming-watches).

## When to use

- **Supervisor dashboards** — show every OPEN session for a tenant and their terminal
  outcomes as they occur.
- **Late-joining orchestrators** — recover in-flight sessions after a restart without
  keeping an out-of-band session registry.
- **Reconciliation** — cross-check your control-plane's view of sessions against what the
  runtime actually accepted.

## `listSessions` (snapshot)

```typescript
import { Auth, MacpClient } from 'macp-sdk-typescript';

const client = new MacpClient({
  address: 'runtime:50051',
  auth: Auth.bearer('tok-ops', { expectedSender: 'ops' }),
});
await client.initialize();

for (const meta of await client.listSessions()) {
  console.log(meta.sessionId, meta.mode, meta.state, meta.contextId ?? '-', meta.extensionKeys ?? []);
}
```

Each entry is a `SessionMetadata` object with the same shape returned by `getSession` —
including the projected `contextId` and `extensionKeys` fields that surface any extension
blobs the initiator attached to `SessionStart.extensions` (see
[Core Protocol Concepts → SessionStart](protocol.md#sessionstart)).

### Pagination

`client.listSessions(options?)` **auto-paginates** — it follows the runtime's
`nextPageToken` until empty and returns the complete list, so callers are
forward-compatible with a paginating runtime. Because it drains every page before
returning, the complete result set is accumulated in one in-process array; for a session
count large enough that this matters, use `listSessionsPage` (below) to walk pages
manually instead of holding the whole set in memory at once.

```typescript
const all = await client.listSessions({ pageSize: 100 }); // drains all pages
```

If you want to page manually — e.g. to render one page at a time — use
`listSessionsPage`, which returns `{ sessions, nextPageToken }` (an object, not a tuple).
An empty `nextPageToken` means the last page; **don't assume a complete list until the
token is empty**:

```typescript
let page = await client.listSessionsPage({ pageSize: 50 });
let all = page.sessions;
while (page.nextPageToken) {
  page = await client.listSessionsPage({ pageSize: 50, pageToken: page.nextPageToken });
  all = all.concat(page.sessions);
}
```

A stale or otherwise invalid `pageToken` throws with code `INVALID_ARGUMENT` — don't
cache a token across a long gap and replay it later; re-page from the start instead.

## `SessionLifecycleWatcher` (live stream)

```typescript
import { SessionLifecycleWatcher, isTerminalSessionLifecycleEvent } from 'macp-sdk-typescript';

const watcher = new SessionLifecycleWatcher(client); // uses client's own auth by default
const controller = new AbortController();

for await (const event of watcher.changes(controller.signal)) {
  console.log(event.eventType, event.session?.sessionId);
  if (isTerminalSessionLifecycleEvent(event)) {
    // This session will not emit more events.
  }
}
```

`event.eventType` is one of the `EVENT_TYPE_*`-prefixed values (`EVENT_TYPE_CREATED`,
`EVENT_TYPE_RESOLVED`, `EVENT_TYPE_EXPIRED`, `EVENT_TYPE_CANCELLED` — proto 0.1.3 —
`EVENT_TYPE_SUSPENDED`, `EVENT_TYPE_RESUMED`). The terminal subset (`RESOLVED`, `EXPIRED`,
`CANCELLED`) is exported as a reusable `TERMINAL_SESSION_LIFECYCLE_EVENT_TYPES` array.
**Cross-SDK divergence:** `macp-sdk-python` surfaces the *unprefixed* form (`"RESOLVED"`)
on an `event.event_type` string property; this SDK keeps the prefixed wire form, so a
membership test against a log written by the other SDK must strip the prefix first.

Unlike Python's per-event *properties* (`event.is_created`), this SDK exposes the same
classification as free **functions** that take the event — same capability, idiomatic
shape per language, not a missing feature:

```typescript
import {
  isSessionCreated,
  isSessionResolved,
  isSessionExpired,
  isSessionCancelled,
  isSessionSuspended,
  isSessionResumed,
  isTerminalSessionLifecycleEvent,
} from 'macp-sdk-typescript';
```

| Predicate | True for |
|-----------|---------|
| `isSessionCreated(event)` | `EVENT_TYPE_CREATED` |
| `isSessionResolved(event)` | `EVENT_TYPE_RESOLVED` (Commitment accepted) |
| `isSessionExpired(event)` | `EVENT_TYPE_EXPIRED` (TTL / policy expiry) |
| `isSessionCancelled(event)` | `EVENT_TYPE_CANCELLED` (accepted `CancelSession`) |
| `isSessionSuspended(event)` | `EVENT_TYPE_SUSPENDED` (non-terminal; `SuspendSession`) |
| `isSessionResumed(event)` | `EVENT_TYPE_RESUMED` (non-terminal; `ResumeSession`) |
| `isTerminalSessionLifecycleEvent(event)` | `EVENT_TYPE_RESOLVED`, `EVENT_TYPE_EXPIRED`, or `EVENT_TYPE_CANCELLED` |

> **Cancellation moved (proto 0.1.3):** an accepted `CancelSession` surfaces as
> `EVENT_TYPE_CANCELLED`, not `EVENT_TYPE_EXPIRED`. `isTerminalSessionLifecycleEvent`
> includes it, so loops that wait on termination keep working — but any code that
> special-cased `isSessionExpired` to detect cancellation should switch to
> `isSessionCancelled`. `SUSPENDED` / `RESUMED` are non-terminal.

> **Suspension cap (proto ≥ 0.1.5).** Pass `maxSuspendMs` to `session.start(...)` to bind
> a per-session maximum suspension window. `0` (default) selects the runtime's configured
> default (7 days). A suspension that outlasts the cap **expires** the session
> (`SUSPENDED` → `EXPIRED`), which you will observe as an `isSessionExpired` lifecycle
> event. `validateMaxSuspendMs` rejects negative values client-side before the envelope is
> built.

### Startup snapshot semantics

On connect, the runtime emits one `CREATED` event per session **currently in the
registry** — not just `OPEN` ones. A terminal session is evicted `MACP_SESSION_RETENTION_SECS`
after it *started* (one hour by default) — not after it resolved — so a session that ran
long can be evicted almost immediately after reaching a terminal state, while a short one
lingers for most of the window. Either way, the initial sync can include already-RESOLVED/
EXPIRED/CANCELLED sessions that haven't aged out yet; reconcile against `event.eventType`,
not just the fact that a `CREATED` arrived. After the sync, live events follow. That means
a freshly-started supervisor sees every session the registry still holds without a
separate `listSessions()` call:

```typescript
for await (const event of new SessionLifecycleWatcher(client).changes()) {
  if (isSessionCreated(event) && event.session) {
    register(event.session); // fires once per pre-existing session, plus every new one
  } else if (isTerminalSessionLifecycleEvent(event) && event.session) {
    finalise(event.session);
  }
}
```

A **live** (post-sync) event's `session` can be `undefined` if the session was evicted
from memory before the event reached you — initial-sync events always carry it.
Reconcile with `listSessions`/`getSession` rather than treating the event stream as an
authoritative inventory on its own.

`listSessions()` is still useful when you want a bounded snapshot without holding the
stream open.

### Blocking handler form

`watch(handler)` is shorthand for a blocking for-loop:

```typescript
await new SessionLifecycleWatcher(client).watch((event) => {
  dashboard.update(event.session?.sessionId, event.eventType);
}); // blocks
```

### Concurrency

The watcher's `changes()`/`watch()` methods are already non-blocking — an async generator
and a promise, respectively — so there is no thread to manage. Run a watcher alongside
other work on the same client with `Promise.all`, or fire-and-forget it if the caller
doesn't need to wait on it:

```typescript
// Alongside other async work:
await Promise.all([
  (async () => {
    for await (const event of new SessionLifecycleWatcher(client).changes()) {
      handle(event);
    }
  })(),
  doOtherWork(),
]);

// Or fire-and-forget, if nothing needs to await it:
void new SessionLifecycleWatcher(client).watch(handle);
```

## Authorisation

Both RPCs require the same Bearer auth as any other SDK call, but — unlike `getSession`,
which is participant/observer-scoped — `listSessions` and `watchSessions` return metadata
for **all** sessions to any authenticated identity (RFC-MACP-0006 permits this shape).
Deployments with confidentiality requirements between agent groups should front these
RPCs with a proxy or restrict which identities may call them, rather than relying on
per-session scoping that does not exist for these two calls. See [Runtime Deployment § Observation-surface authorization](https://github.com/multiagentcoordinationprotocol/macp-runtime/blob/main/docs/deployment.md#observation-surface-authorization).

A watcher's consumer lag is bounded, not unlimited: the live broadcast channel holds a
fixed number of events, and a subscriber that falls too far behind is terminated with a
`MacpTransportError` (`code === 'RESOURCE_EXHAUSTED'`) rather than silently dropping
events — reconnect and reconcile with `listSessions()` rather than treating the dropped
connection as fatal. `nextChange()` is a one-shot convenience (await a single event, same
semantics as `changes()`'s first yield) for callers that don't want to hold a loop open.

## Related

- [Streaming](streaming.md) for the rest of the watcher catalogue (`ModeRegistryWatcher`,
  `RootsWatcher`, `SignalWatcher`) and [Policy Framework § Watching for Policy
  Changes](policy.md#watching-for-policy-changes) for `PolicyWatcher`.
- [Building Orchestrators → Pattern: Supervisor and observer](building-orchestrators.md#pattern-supervisor-and-observer)
  for a worked example.
