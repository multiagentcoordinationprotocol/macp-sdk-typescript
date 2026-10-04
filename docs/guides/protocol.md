# Core Protocol Concepts

This page is a quick orientation for SDK users — what you need to read SDK code without
surprises. The runtime docs are authoritative for protocol semantics; this page links out
to them rather than restating them.

- Protocol spec: [MACP RFCs](https://github.com/multiagentcoordinationprotocol/multiagentcoordinationprotocol)
- Runtime overview: [Runtime README](https://github.com/multiagentcoordinationprotocol/macp-runtime/blob/main/docs/README.md)
- RPC reference: [Runtime API](https://github.com/multiagentcoordinationprotocol/macp-runtime/blob/main/docs/API.md)
- SDK-author guide: [Runtime SDK Guide](https://github.com/multiagentcoordinationprotocol/macp-runtime/blob/main/docs/sdk-guide.md)

## Two planes of communication

MACP separates all agent communication into two planes:

- **Ambient Plane (Signals)** — continuous, non-binding informational messages. Signals
  do not create sessions, mutate state, or produce binding outcomes.
- **Coordination Plane (Sessions)** — bounded, explicit, binding coordination. All
  coordination that produces a binding outcome must happen inside a session.

The core invariant: *binding coordination MUST occur inside explicit, bounded
Coordination Sessions*.

## Envelopes

Every message is a canonical `Envelope`. The SDK builds envelopes for you via
`buildEnvelope()` (`src/envelope.ts`) and the session helpers — you rarely construct one
by hand.

For the wire-level field list and validation rules, see [Runtime SDK Guide § Building envelopes](https://github.com/multiagentcoordinationprotocol/macp-runtime/blob/main/docs/sdk-guide.md#building-envelopes).

Two SDK-relevant invariants worth knowing:

- **Idempotency** — each envelope carries a unique `messageId`. The runtime deduplicates
  within a session, so retries with the same `messageId` are safe (the Ack returns
  `duplicate: true`). This is what makes [`retrySend()`](error-handling.md#built-in-retry-retrysend)
  safe. Client-side, `BaseProjection.applyEnvelope` deduplicates on the same field — see
  [Projections § Design intent: shared projection instance](../api/projections.md#design-intent-shared-projection-instance).
- **Sender identity is runtime-derived** — the `sender` field is bound from your
  authenticated identity, never self-asserted. The SDK fills it in from the session's
  `AuthConfig`; the runtime validates it. See [Authentication](authentication.md).

## Session lifecycle

A session moves through `SESSION_STATE_OPEN` and ends in one of three terminal states —
`SESSION_STATE_RESOLVED` (Commitment accepted), `SESSION_STATE_EXPIRED` (TTL or policy
expiry), or `SESSION_STATE_CANCELLED` (explicit `CancelSession`, distinct from expiry) —
with `SESSION_STATE_SUSPENDED` as a non-terminal pause in between. Monotonic transitions
and terminal-message rules are defined and enforced by the runtime. See [Runtime API § Session Lifecycle](https://github.com/multiagentcoordinationprotocol/macp-runtime/blob/main/docs/API.md#session-lifecycle)
and [Runtime Architecture § Coordination Kernel](https://github.com/multiagentcoordinationprotocol/macp-runtime/blob/main/docs/architecture.md#layers).

The SDK tracks the lifecycle locally via projections — see [Architecture § Projections](architecture.md#projections).

### SessionStart

Every session begins with a `SessionStart` envelope. `modeVersion`, `configurationVersion`,
and `policyVersion` are bound once, as options on the session constructor, and cannot
change for the life of the session; `start()` itself takes the per-session fields:

```typescript
const session = new DecisionSession(client, {
  modeVersion: '1.0.0',
  configurationVersion: 'org-2025.q4',
  policyVersion: 'procurement-v3', // optional
});

await session.start({
  intent: 'pick a deployment plan',
  participants: ['coordinator', 'alice', 'bob'],
  ttlMs: 60_000,
  contextId: 'release-2025-q4-deploy', // optional
  extensions: { aitp: Buffer.from('...') }, // optional opaque blobs
  roots: [{ uri: 'file:///workspace' }], // optional
});
```

`modeVersion`, `configurationVersion`, and `policyVersion` are **bound at SessionStart and
cannot change** during the session — see [Determinism](determinism.md).

`contextId` and the *keys* of `extensions` are projected onto every `SessionMetadata`
returned by `getSession`/`listSessions`/`watchSessions` — values stay opaque. Use this for
protocol-extension signalling without parsing payloads. See [Session Discovery](session-discovery.md).

### Commitment

A Commitment is the terminal message that resolves a session:

```typescript
await session.commit({
  action: 'deployment.approved',
  authorityScope: 'release-management',
  reason: '2/3 majority approved',
});
```

Who is authorised to commit is governed by the runtime's policy engine — see
[Runtime Policy](https://github.com/multiagentcoordinationprotocol/macp-runtime/blob/main/docs/policy.md#commitment-authority).
By default, only the session initiator can commit.

## Capabilities and initialization

Before any session work, call `initialize()` to negotiate capabilities:

```typescript
const result = await client.initialize();
// result.selectedProtocolVersion → "1.0"
// result.capabilities            → what the runtime supports
// result.supportedModes          → available mode URIs
```

Field-level details: [Runtime API § Protocol Handshake](https://github.com/multiagentcoordinationprotocol/macp-runtime/blob/main/docs/API.md#protocol-handshake).

## Errors

The runtime returns structured errors with RFC-defined codes (`UNAUTHENTICATED`,
`FORBIDDEN`, `SESSION_NOT_FOUND`, `SESSION_NOT_OPEN`, `DUPLICATE_MESSAGE`,
`INVALID_ENVELOPE`, `MODE_NOT_SUPPORTED`, `PAYLOAD_TOO_LARGE`, `RATE_LIMITED`,
`INTERNAL_ERROR`). The full table with HTTP status mappings lives in
[Runtime API § Message Transport](https://github.com/multiagentcoordinationprotocol/macp-runtime/blob/main/docs/API.md#message-transport)
and [Runtime SDK Guide § Error handling](https://github.com/multiagentcoordinationprotocol/macp-runtime/blob/main/docs/sdk-guide.md#error-handling).

The SDK maps them to typed errors (`MacpAckError`, `MacpTransportError`, and friends) —
see [Error Handling](error-handling.md) for the full class hierarchy, retry guidance, and
which codes are safe to retry.

## Discovery

The runtime exposes discovery RPCs the SDK wraps as unary methods or async-generator
watchers. See [Runtime API § Discovery](https://github.com/multiagentcoordinationprotocol/macp-runtime/blob/main/docs/API.md#discovery)
and [§ Streaming Watches](https://github.com/multiagentcoordinationprotocol/macp-runtime/blob/main/docs/API.md#streaming-watches)
for the underlying RPCs.

### Unary

Return shapes aren't uniform — `listModes`/`listExtModes`/`listRoots`/`getManifest`
return a named wrapper object; `listSessions`/`listPolicies` return a bare array:

```typescript
const { modes } = await client.listModes(); // standard modes
const { manifest } = await client.getManifest(); // runtime/agent manifest
const { modes: extModes } = await client.listExtModes(); // registered extension modes
const { roots } = await client.listRoots();
const sessions = await client.listSessions(); // bare array
const policies = await client.listPolicies(); // bare array
```

### Server-streaming (watchers)

The SDK wraps each server-streaming RPC in a `*Watcher` class that normalises responses
into typed records. See [Streaming](streaming.md) for `ModeRegistryWatcher`/
`RootsWatcher`/`SignalWatcher` usage, [Session Discovery](session-discovery.md) for
`SessionLifecycleWatcher` specifically, and [Policy Framework § Watching for Policy
Changes](policy.md#watching-for-policy-changes) for `PolicyWatcher`.

| RPC | Watcher | Yields |
|-----|---------|--------|
| `WatchModeRegistry` | `ModeRegistryWatcher` | Registry diff events |
| `WatchRoots` | `RootsWatcher` | Root diff events (runtime currently idles) |
| `WatchPolicies` | `PolicyWatcher` | Policy change records |
| `WatchSessions` | `SessionLifecycleWatcher` | `SessionLifecycleEvent` (`EVENT_TYPE_CREATED`/`EVENT_TYPE_RESOLVED`/`EVENT_TYPE_EXPIRED`/`EVENT_TYPE_CANCELLED`/`EVENT_TYPE_SUSPENDED`/`EVENT_TYPE_RESUMED`) |
| `WatchSignals` | `SignalWatcher` | Ambient-plane signal envelopes |
