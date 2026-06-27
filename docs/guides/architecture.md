# Architecture

## Three-Layer Design

The SDK is organized into three layers. Each sits on the one below it and is
usable independently — an advanced caller can drop down to `MacpClient` while
most agents live in the session or agent-framework layer.

```
┌─────────────────────────────────────────────────────┐
│            Agent Framework                           │
│   Participant · Dispatcher · Strategies             │
│   Runner (fromBootstrap) · Transports                │
│      ▼ wraps / orchestrates                          │
├─────────────────────────────────────────────────────┤
│       High-Level Session Helpers                     │
│   DecisionSession · ProposalSession · TaskSession    │
│   HandoffSession · QuorumSession                     │
│   ┌────────────────────────────────────────┐         │
│   │   Projections (local state machines)    │         │
│   │ DecisionProjection · TaskProjection etc │         │
│   └────────────────────────────────────────┘         │
├─────────────────────────────────────────────────────┤
│            Low-Level Transport                       │
│   MacpClient · MacpStream · ProtoRegistry            │
│   Auth · Watchers · Policy builders                  │
├─────────────────────────────────────────────────────┤
│            gRPC / Protobuf                           │
│   @grpc/grpc-js · @grpc/proto-loader · protobufjs    │
└─────────────────────────────────────────────────────┘
              │
              ▼
     ┌─────────────────┐
     │   MACP Runtime   │
     │   (Rust/gRPC)    │
     └─────────────────┘
```

### Layer 1: MacpClient (Transport)

`MacpClient` provides typed wrappers around the gRPC `MACPRuntimeService`:

| RPC | Method | Returns |
|-----|--------|---------|
| `Initialize` | `client.initialize()` | `InitializeResult` |
| `Send` | `client.send(envelope)` | `Ack` |
| `StreamSession` | `client.openStream()` | `MacpStream` |
| `GetSession` | `client.getSession(id)` | `SessionMetadata` |
| `ListSessions` | `client.listSessions()` | `SessionMetadata[]` |
| `WatchSessions` | via `SessionLifecycleWatcher` | async iterator |
| `CancelSession` | `client.cancelSession(id, reason)` | `Ack` |
| `GetManifest` | `client.getManifest(agentId?)` | `AgentManifest` |
| `ListModes` | `client.listModes()` | `ModeDescriptor[]` |
| `ListRoots` | `client.listRoots()` | `Root[]` |
| `ListExtModes` | `client.listExtModes()` | `ModeDescriptor[]` |
| `RegisterExtMode` | `client.registerExtMode(desc)` | `{ ok, error? }` |
| `UnregisterExtMode` | `client.unregisterExtMode(mode)` | `{ ok, error? }` |
| `PromoteMode` | `client.promoteMode(mode, name?)` | `{ ok, error?, mode? }` |
| `RegisterPolicy` / `UnregisterPolicy` / `GetPolicy` / `ListPolicies` | `client.registerPolicy(...)` etc. | `{ ok, error? }` / `PolicyDescriptor[]` |
| `WatchModeRegistry` | via `ModeRegistryWatcher` | async iterator |
| `WatchRoots` | via `RootsWatcher` | async iterator |
| `WatchSignals` | via `SignalWatcher` | async iterator |
| `WatchPolicies` | via `PolicyWatcher` | async iterator |
| *(convenience)* `sendSignal` / `sendProgress` | — | `Ack` |

The client dynamically loads protobuf definitions from the
`@multiagentcoordinationprotocol/proto` package at construction time and creates
a gRPC channel using either TLS (default) or insecure credentials — the latter
requires the explicit `allowInsecure: true` opt-out per RFC-MACP-0006 §3.

### Layer 2: Session Helpers

Each coordination mode has a session class that:
1. Holds a `sessionId`, version strings, and optional `AuthConfig`.
2. Provides typed methods for each mode-specific message type.
3. Builds envelopes via `buildEnvelope()` + `ProtoRegistry.encodeKnownPayload()`.
4. Runs the identity guard (`assertSenderMatchesIdentity`) before touching the
   wire — mismatched `sender` → `MacpIdentityMismatchError`.
5. Sends via `MacpClient.send()` with automatic Ack checking.
6. Applies accepted envelopes to a local projection.

```typescript
// Internal pattern (same for all session classes):
private async sendAndTrack(envelope: Envelope, auth?: AuthConfig): Promise<Ack> {
  const ack = await this.client.send(envelope, { auth: auth ?? this.auth });
  if (ack.ok) this.projection.applyEnvelope(envelope, this.client.protoRegistry);
  return ack;
}
```

#### Projections

Projections are **pure state machines** that track session state client-side.
They receive envelopes and maintain typed collections:

```
Envelope → applyEnvelope() → updates internal state
                               │
                               ├── Maps (proposals, tasks, handoffs, etc.)
                               ├── Arrays (evaluations, updates, etc.)
                               ├── Phase tracking
                               └── Query helpers (voteTotals, hasQuorum, etc.)
```

Projections only track state for envelopes that were successfully accepted
(Ack `ok: true`). Rejected messages are never applied.

**Key property**: Projections are deterministic. Given the same sequence of
envelopes, they always produce the same state. This makes them easy to test
without a running runtime — see `tests/conformance/` for fixture replay.

### Layer 3: Agent Framework

The agent framework (`src/agent/`) sits on top of the session helpers. It lets
a process become a MACP participant declaratively instead of driving sends/reads
by hand.

| Piece | Purpose |
|-------|---------|
| `Participant` (`src/agent/participant.ts`) | Event-driven wrapper over a session + projection. Registers handlers via `.on(messageType, handler)`, `.onPhaseChange(...)`, `.onTerminal(...)`. |
| `Dispatcher` (`src/agent/dispatcher.ts`) | Routes incoming envelopes to handlers. Supports wildcard message types and phase-change hooks. |
| `Strategies` (`src/agent/strategies.ts`) | Composable handler factories — `evaluationHandler()`, `votingHandler()`, `commitmentHandler()`, plus prebuilts like `majorityVoter()` and `majorityCommitter()`. |
| `Transports` (`src/agent/transports.ts`) | `GrpcTransportAdapter` (bidi stream) and `HttpTransportAdapter` (polling) for pulling envelopes into a Participant's event loop. |
| `Runner` (`src/agent/runner.ts`) | `fromBootstrap()` — reads a JSON bootstrap file, picks `Auth` (bearer with `expectedSender` if `auth_token` is present, else dev-agent), constructs the `MacpClient`, and returns a pre-wired `Participant`. |

See [`docs/guides/agent-framework.md`](agent-framework.md) for the full
handler-registration API.

### ProtoRegistry

The `ProtoRegistry` is the bridge between TypeScript objects and protobuf wire
format:

```
TypeScript Object → encodeKnownPayload(mode, messageType, value) → Buffer
Buffer → decodeKnownPayload(mode, messageType, payload) → TypeScript Object
```

It maintains two lookup maps:
- `MODE_MAP`: Maps `(mode, messageType)` to protobuf type names for mode-specific messages.
- `CORE_MAP`: Maps `messageType` to protobuf type names for core messages (SessionStart, Commitment, Signal, Progress).

For extension modes using JSON encoding (like `ext.multi_round.v1`), it falls back to JSON serialization.

## Runtime Boundary

The runtime is the **authoritative source of truth**. The SDK provides
convenience but does not enforce:

| Concern | Handled By |
|---------|------------|
| Session state (OPEN/RESOLVED/EXPIRED) | Runtime |
| Message ordering (acceptance order) | Runtime |
| Message deduplication (`message_id`) | Runtime |
| TTL enforcement | Runtime |
| Mode-specific validation | Runtime |
| Participant authorization (sender derivation) | Runtime |
| Sender-identity guard (caller-supplied `sender` vs `expectedSender`) | SDK (client-side pre-check) |
| Envelope building + encoding | SDK |
| Local state projection | SDK |
| Typed method signatures | SDK |

If the runtime rejects a message (Ack `ok: false`), the SDK throws
`MacpAckError` and does **not** apply the envelope to the projection.

## File Organization

```
src/
├── index.ts              # Barrel export
├── client.ts             # MacpClient + MacpStream
├── auth.ts               # Auth factory, identity guard, gRPC metadata
├── base-session.ts       # Shared session base class (sendAndTrack, start/commit)
├── constants.ts          # MACP_VERSION, mode identifiers, STANDARD_MODES
├── envelope.ts           # Envelope + payload builders, signal/progress builders, serializeMessage
├── errors.ts             # Error class hierarchy incl. MacpIdentityMismatchError + AckFailure
├── logging.ts            # Structured logger + configureLogging()
├── proto-registry.ts     # Protobuf encode/decode registry
├── policy.ts             # Policy descriptor builders + named rule types
├── types.ts              # TypeScript interfaces
├── retry.ts              # Retry policy + exponential backoff
├── validation.ts         # Payload validation helpers
├── watchers.ts           # ModeRegistry/Roots/Signal/Policy/SessionLifecycle watchers
├── decision.ts           # DecisionSession
├── proposal.ts           # ProposalSession
├── task.ts               # TaskSession
├── handoff.ts            # HandoffSession
├── quorum.ts             # QuorumSession
├── projections.ts        # Barrel re-export for projections/
├── projections/          # Pure state machines (one per mode)
│   ├── base.ts           # BaseProjection shared by all modes
│   ├── decision.ts
│   ├── proposal.ts
│   ├── task.ts
│   ├── handoff.ts
│   └── quorum.ts
└── agent/                # Layer 3 — agent framework
    ├── cancel-callback.ts # RFC-0001 §7.2 Option A cancel-callback HTTP server
    ├── dispatcher.ts
    ├── participant.ts
    ├── runner.ts
    ├── strategies.ts
    ├── transports.ts
    ├── types.ts
    └── index.ts
```
