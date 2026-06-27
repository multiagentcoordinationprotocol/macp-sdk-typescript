# Authentication

## Overview

The MACP runtime requires authentication for most operations. The SDK supports two mechanisms:

| Mechanism | Header | Use Case |
|-----------|--------|----------|
| Dev Agent | `x-macp-agent-id` | Local development (requires `MACP_ALLOW_DEV_SENDER_HEADER=1` on runtime) |
| Bearer Token | `Authorization: Bearer <token>` | Production deployments (opaque static tokens **or** JWTs) |

The SDK is resolver-agnostic: both opaque static tokens and JWTs travel in `Authorization: Bearer`, and the runtime picks the right resolver based on the token shape. For the server-side resolver chain (JWT bearer → static bearer → dev-mode fallback), capability flags, and the `tokens.json` / JWT claim layout, see the runtime's [Getting Started](https://github.com/multiagentcoordinationprotocol/macp-runtime/blob/main/docs/getting-started.md#authentication-configuration) and [Deployment](https://github.com/multiagentcoordinationprotocol/macp-runtime/blob/main/docs/deployment.md#authentication) guides.

## Creating Auth Configs

### Development

```typescript
import { Auth } from 'macp-sdk-typescript';

// Simple dev agent — sets both agentId and senderHint
const auth = Auth.devAgent('alice');
// → Header: x-macp-agent-id: alice
```

### Production

```typescript
// Bearer token with an authenticated identity.
// The SDK refuses to emit any envelope whose `sender` differs from
// `expectedSender` (RFC-MACP-0004 §4). Surfaces identity bugs client-side
// as MacpIdentityMismatchError before they become runtime NACKs.
const auth = Auth.bearer('my-secret-token', { expectedSender: 'alice' });
// → Header: Authorization: Bearer my-secret-token
```

The legacy two-argument form sets `senderHint` only and does *not* enforce the
identity guard. Prefer the structured form for anything touching production:

```typescript
// Legacy; retained for compatibility with pre-0.2 code
const loose = Auth.bearer('my-secret-token', 'alice');
```

## Identity guard (strict mode)

When `expectedSender` is configured, calling any mode helper with an explicit
`sender` that disagrees throws `MacpIdentityMismatchError` *before* the RPC is
sent:

```typescript
import { Auth, DecisionSession, MacpIdentityMismatchError } from 'macp-sdk-typescript';

const session = new DecisionSession(client, {
  auth: Auth.bearer('alice-token', { expectedSender: 'alice' }),
});

try {
  await session.propose({ proposalId: 'p1', option: 'x', sender: 'mallory' });
} catch (err) {
  if (err instanceof MacpIdentityMismatchError) {
    console.error(err.expectedSender, '!=', err.actualSender);
  }
}
```

When `expectedSender` is undefined (dev agents and legacy bearer), the guard is
silent and the resolver falls back to `senderHint` / `agentId`, preserving
pre-0.2 behaviour.

## Default vs Per-Operation Auth

### Default Auth (Client-Level)

Set once, used for all operations:

```typescript
const client = new MacpClient({
  address: '127.0.0.1:50051',
  auth: Auth.bearer('coordinator-token', { expectedSender: 'coordinator' }),
});

// All operations use coordinator's auth
await client.initialize();
const session = new DecisionSession(client);
await session.start({ intent: '...', participants: ['alice'], ttlMs: 60_000 });
await session.propose({ proposalId: 'p1', option: 'A' });
```

### Per-Operation Auth (Multi-Agent)

When a single process acts as several agents (typically in tests), pass a
per-method `auth` whose `expectedSender` matches the `sender`:

```typescript
await session.start({ intent: '...', participants: ['alice', 'bob'], ttlMs: 60_000 });

await session.evaluate({
  proposalId: 'p1',
  recommendation: 'approve',
  confidence: 0.9,
  sender: 'alice',
  auth: Auth.bearer('alice-token', { expectedSender: 'alice' }),
});

await session.vote({
  proposalId: 'p1',
  vote: 'approve',
  sender: 'bob',
  auth: Auth.bearer('bob-token', { expectedSender: 'bob' }),
});
```

### Session-Level Auth

Sessions can have their own default auth, independent of the client:

```typescript
const session = new DecisionSession(client, {
  auth: Auth.bearer('session-specific-token', { expectedSender: 'coordinator' }),
});
```

Priority order: **per-method auth > session auth > client auth**.

## Auth Validation

The SDK validates that exactly one of `bearerToken` or `agentId` is set:

```typescript
import { validateAuth } from 'macp-sdk-typescript';

validateAuth({});                              // throws: either bearerToken or agentId required
validateAuth({ bearerToken: 'x', agentId: 'y' }); // throws: choose one, not both
validateAuth({ bearerToken: 'x' });            // ok
validateAuth({ agentId: 'y' });                // ok
```

## Pre-allocating a sessionId

The initiator agent typically receives its session_id from an orchestrator
(control-plane, bootstrap file, or CLI flag) and passes it into the session
constructor so every participant agrees on the same value before `SessionStart`
is sent:

```typescript
import { DecisionSession, newSessionId } from 'macp-sdk-typescript';

// Orchestrator picks the id once (UUID v4 — matches runtime's validator)
const sessionId = newSessionId();

// Initiator opens the session
const initiator = new DecisionSession(client, {
  sessionId,
  auth: Auth.bearer(aliceToken, { expectedSender: 'alice' }),
});
await initiator.start({ intent: '...', participants: ['alice', 'bob'], ttlMs: 30_000 });

// Non-initiator attaches with the same sessionId; no start() call
const subscriber = new DecisionSession(otherClient, {
  sessionId,
  auth: Auth.bearer(bobToken, { expectedSender: 'bob' }),
});
const stream = subscriber.openStream();
```

## JWT tokens

Pass the JWT as the bearer value — the SDK does not need to parse or validate it. The runtime's JWT resolver (active when `MACP_AUTH_ISSUER` is set) verifies signature/issuer/audience/expiration and derives the sender from the `sub` claim, while the optional `macp_scopes` claim carries capability flags.

```typescript
const auth = Auth.bearer(jwt, { expectedSender: 'agent://analyst' });
```

Set `expectedSender` to the value you expect the JWT's `sub` claim to produce so the SDK's identity guard fires client-side before the runtime NACKs. See the runtime's [JWT mode guide](https://github.com/multiagentcoordinationprotocol/macp-runtime/blob/main/docs/getting-started.md#jwt-mode) for claim layout and supported algorithms.

## Observer identities

Non-participant agents (audit agents, dashboards, read-only observers) authenticate with a normal bearer credential whose runtime-side identity carries `is_observer: true`. On the SDK side, observers open a stream and call [`sendSubscribe(sessionId, afterSequence?)`](streaming.md#subscribe-with-history-replay-rfc-macp-0006-a1) to replay accepted history and then consume live envelopes — no participation in the session's `participants` list is required.

```typescript
const stream = client.openStream({ auth: Auth.bearer(observerToken, { expectedSender: 'agent://auditor' }) });
await stream.sendSubscribe(sessionId); // full replay + live tail
```

Observers still cannot `Send` into a session unless the mode's authority rules allow it — passive observation does not bypass mode authority. See the runtime's [SDK guide](https://github.com/multiagentcoordinationprotocol/macp-runtime/blob/main/docs/sdk-guide.md#observer-identities) for the server-side provisioning details.

## Runtime token configuration

The SDK does not own runtime auth configuration. For the `tokens.json` schema (including `allowed_modes`, `can_start_sessions`, `max_open_sessions`, `can_manage_mode_registry`, `is_observer`), JWT environment variables, and resolver ordering, see:

- [Runtime — Getting Started › Authentication configuration](https://github.com/multiagentcoordinationprotocol/macp-runtime/blob/main/docs/getting-started.md#authentication-configuration)
- [Runtime — Deployment › Authentication](https://github.com/multiagentcoordinationprotocol/macp-runtime/blob/main/docs/deployment.md#authentication)

## TLS

TLS is on by default (RFC-MACP-0006 §3). The constructor throws if you pass
`secure: false` without the explicit dev-only escape hatch:

```typescript
import * as fs from 'fs';

// Production (TLS is implicit, but you may pin a CA)
const client = new MacpClient({
  address: 'macp.example.com:50051',
  rootCertificates: fs.readFileSync('/path/to/ca.pem'),
  auth: Auth.bearer('production-token', { expectedSender: 'my-agent' }),
});

// Local development against an insecure runtime (MACP_ALLOW_INSECURE=1)
const dev = new MacpClient({
  address: '127.0.0.1:50051',
  secure: false,
  allowInsecure: true, // must be paired with secure: false
  auth: Auth.devAgent('dev-agent'),
});
```

The runtime must be configured with `MACP_TLS_CERT_PATH` and `MACP_TLS_KEY_PATH`.
