# Handoff Mode

**Mode identifier**: `macp.mode.handoff.v1`
**Participant model**: delegated
**Determinism**: context-frozen

## Purpose

Transfer responsibility from one participant to another, with optional context sharing.

> **Canonical references**: [RFC-MACP-0010 (Handoff Mode)](https://github.com/multiagentcoordinationprotocol/multiagentcoordinationprotocol/blob/main/rfcs/RFC-MACP-0010-handoff-mode.md) is normative for the state machine, authority rules, and validation constraints. See also the [spec mode summaries](https://github.com/multiagentcoordinationprotocol/multiagentcoordinationprotocol/blob/main/docs/modes.md#standard-mode-summaries) and [runtime modes guide › Handoff Mode](https://github.com/multiagentcoordinationprotocol/macp-runtime/blob/main/docs/modes.md#handoff-mode) for validation as implemented. This page covers the TypeScript API.

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

Like every mode session, `HandoffSession` also exposes the shared lifecycle
helpers — `metadata()`, `cancel(reason)`, `suspend(reason)`, `resume(reason)`,
and `openStream()`. `suspend()` (proto 0.1.3+) is a non-terminal pause: the
runtime banks the remaining TTL and rejects messages until `resume()` restores
`SESSION_STATE_OPEN` and the banked TTL. See
[Decision Mode → Lifecycle helpers](decision.md#lifecycle-helpers).

> **Migrating from 0.2.x**: the `sendContext()` alias was deprecated in `0.2.3`
> and **removed in `0.3.0`**. Replace any call site with `addContext()` — the
> signature and semantics are identical. See the `0.3.0` "Removed" entry in
> [`CHANGELOG.md`](../../CHANGELOG.md).

### Offer

```typescript
await session.offer({
  handoffId: 'h1',
  targetParticipant: 'bob',
  scope: 'frontend-ownership',  // optional; defaults to '' when omitted
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
| `phase` | `'Pending' \| 'OfferPending' \| 'ContextSharing' \| 'Accepted' \| 'Declined' \| 'Committed'` | Current phase |
| `commitment` | `Record<string, unknown> \| undefined` | Commitment payload if resolved |

### HandoffRecord Status

| Status | Meaning |
|--------|---------|
| `offered` | Handoff proposed, awaiting response |
| `context_sent` | Context provided while still pending (context after accept/decline leaves status unchanged) |
| `accepted` | Target accepted the handoff |
| `declined` | Target declined the handoff |

### Query Helpers

```typescript
session.projection.getHandoff('h1');            // full HandoffRecord (incl. `implicit`)
session.projection.isAccepted('h1');            // true after HandoffAccept
session.projection.isImplicitlyAccepted('h1');  // true only for a runtime synthetic implicit accept
session.projection.isDeclined('h1');            // true after HandoffDecline
session.projection.pendingHandoffs();           // handoffs in offered/context_sent status
session.projection.hasAcceptedOffer();          // any accepted handoff (or pass a handoffId)
session.projection.activeOffer();               // most recent still-pending handoff, if any
session.projection.isCommitted;                 // true once a Commitment is applied
```

### Implicit accepts (RFC-MACP-0010 §5.1, proto ≥ 0.1.6)

When a handoff policy sets `implicit_accept_timeout_ms`, the runtime may emit a
**synthetic** accept once the timeout elapses (`message_id` =
`implicit-accept:<handoff_id>`, `implicit = true`). The projection surfaces this
via `HandoffRecord.implicit` / `isImplicitlyAccepted(handoffId)`.

This flag is **read-only / decode-only**: clients MUST NOT submit an accept with
`implicit = true` — the runtime rejects it. `HandoffSession.acceptHandoff`
strips the field before encoding, so a caller can never produce a rejected
envelope. (Runtime 0.5.0 ships the proto field and contract; the emitting timer
lands in a later runtime release — SDK decode support future-proofs consumers.)

## RFC Validation Rules

The runtime enforces the cross-message rules — each `handoff_id` identifies one
offer, context/accept/decline must reference an existing offer, accept/decline
only from the offer's `target_participant`, one final accept per `handoff_id`,
and one final Commitment even across serial offers. The normative rule set
lives in RFC-MACP-0010 §4; the
[runtime modes guide › Handoff Mode](https://github.com/multiagentcoordinationprotocol/macp-runtime/blob/main/docs/modes.md#handoff-mode)
documents validation as implemented.

## Context-Frozen Determinism

Handoff mode uses **context-frozen** determinism — semantic determinism holds only if the external context bound at SessionStart is replayed exactly. The context provided via `HandoffContext` messages is part of this frozen state. See [RFC-MACP-0003 (Determinism)](https://github.com/multiagentcoordinationprotocol/multiagentcoordinationprotocol/blob/main/rfcs/RFC-MACP-0003-determinism.md) for the determinism class definitions.

## Example

See [`examples/handoff-smoke.ts`](../../examples/handoff-smoke.ts).
