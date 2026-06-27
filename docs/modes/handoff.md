# Handoff Mode

**Mode identifier**: `macp.mode.handoff.v1`
**Participant model**: delegated
**Determinism**: context-frozen

## Purpose

Transfer responsibility from one participant to another, with optional context sharing.

## Session Lifecycle

```
SessionStart → HandoffOffer → HandoffContext? → HandoffAccept/HandoffDecline → Commitment
```

## API

### HandoffSession

```typescript
import { HandoffSession } from 'macp-sdk-typescript';

const session = new HandoffSession(client);
await session.start({ intent: '...', participants: ['bob'], ttlMs: 60_000 });
```

#### Methods

| Method | Message Type | Description |
|--------|-------------|-------------|
| `offer(input)` | `HandoffOffer` | Offer a handoff to a target participant |
| `addContext(input)` | `HandoffContext` | Provide context for the handoff |
| `acceptHandoff(input)` | `HandoffAccept` | Accept the handoff |
| `decline(input)` | `HandoffDecline` | Decline the handoff |
| `commit(input)` | `Commitment` | Finalize the session |

> **Migrating from 0.2.x**: the `sendContext()` alias was deprecated in `0.2.3`
> and **removed in `0.3.0`**. Replace any call site with `addContext()` — the
> signature and semantics are identical. See the `0.3.0` "Removed" entry in
> [`CHANGELOG.md`](../../CHANGELOG.md).

### Offer

```typescript
await session.offer({
  handoffId: 'h1',
  targetParticipant: 'bob',
  scope: 'frontend-ownership',
  reason: 'moving to backend team',
});
```

### Add Context

Provide information the recipient needs:

```typescript
await session.addContext({
  handoffId: 'h1',
  contentType: 'application/json',
  context: Buffer.from(JSON.stringify({
    repository: 'acme/web-app',
    documentation: 'https://wiki.acme.com/frontend',
    contacts: ['design-team@acme.com'],
    openIssues: 12,
  })),
});
```

### Accept / Decline

```typescript
// Target participant accepts
await session.acceptHandoff({
  handoffId: 'h1',
  acceptedBy: 'bob',
  reason: 'ready to take ownership',
  sender: 'bob',
  auth: Auth.devAgent('bob'),
});

// Or declines
await session.decline({
  handoffId: 'h1',
  declinedBy: 'bob',
  reason: 'no bandwidth this quarter',
  sender: 'bob',
  auth: Auth.devAgent('bob'),
});
```

## HandoffProjection

### State

| Property | Type | Description |
|----------|------|-------------|
| `handoffs` | `Map<string, HandoffRecord>` | Handoffs with status tracking |
| `transcript` | `Envelope[]` | All accepted envelopes |
| `phase` | `'Offering' \| 'ContextSharing' \| 'Resolved' \| 'Committed'` | Current phase |

### HandoffRecord Status

| Status | Meaning |
|--------|---------|
| `offered` | Handoff proposed, awaiting response |
| `context_sent` | Additional context provided |
| `accepted` | Target accepted the handoff |
| `declined` | Target declined the handoff |

### Query Helpers

```typescript
session.projection.getHandoff('h1');        // full HandoffRecord
session.projection.isAccepted('h1');        // true after HandoffAccept
session.projection.isDeclined('h1');        // true after HandoffDecline
session.projection.pendingHandoffs();       // handoffs in offered/context_sent status
```

## RFC Validation Rules

1. Every `handoff_id` identifies one specific offer
2. `HandoffContext`/`HandoffAccept`/`HandoffDecline` must reference an existing `handoff_id`
3. Accept/Decline must come from the offer's `target_participant`
4. Only one final accept per `handoff_id`
5. A session may contain multiple serial handoff offers, but only one final Commitment

## Context-Frozen Determinism

Handoff mode uses **context-frozen** determinism — semantic determinism holds only if the external context bound at SessionStart is replayed exactly. The context provided via `HandoffContext` messages is part of this frozen state.

## Example

See [`examples/handoff-smoke.ts`](../../examples/handoff-smoke.ts).
