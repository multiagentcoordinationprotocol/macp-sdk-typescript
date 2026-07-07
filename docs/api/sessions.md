# Session Classes API Reference

All session classes follow the same base pattern. They differ only in their mode-specific methods.

## Common Pattern

Every session class:

1. **Constructor**: `new XxxSession(client, options?)`
2. **Properties**: `client`, `sessionId`, `modeVersion`, `configurationVersion`, `policyVersion`, `auth`, `projection`
3. **Lifecycle**: `start(input)` → mode-specific methods → `commit(input)`
4. **Metadata**: `metadata(auth?)` queries session state from runtime
5. **Projection**: `session.projection` provides typed local state

### Common Options

```typescript
interface SessionOptions {
  sessionId?: string;             // default: auto-generated UUIDv4
  modeVersion?: string;           // default: '1.0.0'
  configurationVersion?: string;  // default: 'config.default'
  policyVersion?: string;         // default: 'policy.default'
  auth?: AuthConfig;              // default: uses client.auth
}
```

### Common `start()` Input

```typescript
{
  intent: string;                                    // session purpose
  participants: string[];                            // participant identifiers
  ttlMs: number;                                     // time-to-live in milliseconds
  maxSuspendMs?: number;                             // proto ≥ 0.1.5; max cumulative suspend (0 = runtime default)
  context?: Buffer | string | Record<string, unknown>; // optional bound context
  roots?: { uri: string; name?: string }[];          // optional coordination roots
  sender?: string;                                   // optional sender override
}
```

### Common `commit()` Input

```typescript
{
  action: string;          // outcome descriptor (e.g., 'deployment.approved')
  authorityScope: string;  // scope of authority
  reason: string;          // auditable reason
  commitmentId?: string;   // default: auto-generated UUID
  sender?: string;
  auth?: AuthConfig;
}
```

## Session Classes Summary

| Class | Mode | Key Methods |
|-------|------|------------|
| `DecisionSession` | `macp.mode.decision.v1` | `propose`, `evaluate`, `raiseObjection`, `vote` |
| `ProposalSession` | `macp.mode.proposal.v1` | `propose`, `counterPropose`, `accept`, `reject`, `withdraw` |
| `TaskSession` | `macp.mode.task.v1` | `request`, `acceptTask`, `rejectTask`, `update`, `complete`, `fail` |
| `HandoffSession` | `macp.mode.handoff.v1` | `offer`, `addContext`, `acceptHandoff`, `decline` |
| `QuorumSession` | `macp.mode.quorum.v1` | `requestApproval`, `approve`, `reject`, `abstain` |

## Per-Method Auth Override

All mode-specific methods accept optional `sender` and `auth` fields:

```typescript
await session.vote({
  proposalId: 'p1',
  vote: 'approve',
  sender: 'alice',                // populate envelope.sender
  auth: Auth.devAgent('alice'),   // use alice's credentials for this call
});
```

This enables a single process to act on behalf of multiple agents within the same session.

## Identity Guard

Every mode-specific method that accepts a `sender` parameter runs the SDK's
identity guard before the envelope is built. When `auth.expectedSender` is
configured (via `Auth.bearer(token, { expectedSender })`), a caller-supplied
`sender` that disagrees raises `MacpIdentityMismatchError` — client-side, before
any RPC hits the wire (RFC-MACP-0004 §4).

```typescript
import { Auth, DecisionSession, MacpIdentityMismatchError } from 'macp-sdk-typescript';

const session = new DecisionSession(client, {
  auth: Auth.bearer('alice-token', { expectedSender: 'alice' }),
});

try {
  await session.propose({ proposalId: 'p1', option: 'x', sender: 'mallory' });
} catch (err) {
  if (err instanceof MacpIdentityMismatchError) {
    err.expectedSender; // 'alice'
    err.actualSender;   // 'mallory'
  }
}
```

The guard is silent when `expectedSender` is undefined. `Auth.devAgent(...)` and
the legacy `Auth.bearer(token, 'hint')` form preserve pre-0.2 behaviour — the
SDK resolves `sender` from the hint but does not reject mismatched overrides.

## Projection Integration

Each `sendAndTrack()` call:
1. Builds an envelope with `buildEnvelope()` + `ProtoRegistry.encodeKnownPayload()`
2. Sends via `MacpClient.send()` (throws `MacpAckError` on nack)
3. On success (`ack.ok === true`), applies the envelope to the projection

Rejected messages are never applied to the projection.

For full details on each session class, see the [Mode documentation](../modes/decision.md).
