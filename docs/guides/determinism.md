# Determinism and Replay

MACP defines formal determinism guarantees that enable session replay, audit verification, and distributed state reconstruction. The SDK relies on those guarantees but does not define them — they are protocol-level. This page focuses on what an SDK user needs to do (version binding, replay testing) and links out for the rest.

- Protocol spec: [Determinism](https://github.com/multiagentcoordinationprotocol/multiagentcoordinationprotocol/blob/main/docs/determinism.md) (non-normative explanatory doc; [RFC-MACP-0003](https://github.com/multiagentcoordinationprotocol/multiagentcoordinationprotocol/blob/main/rfcs/RFC-MACP-0003-determinism.md) is authoritative)
- Per-mode determinism class: each [coordination mode page](../index.md#coordination-modes) states its own class in the header (e.g. `docs/modes/decision.md`: "**Determinism**: semantic-deterministic")
- Replay enforcement: [Runtime Architecture § Durability model](https://github.com/multiagentcoordinationprotocol/macp-runtime/blob/main/docs/architecture.md#durability-model)

## Determinism classes — at a glance

Each mode declares a determinism class. The SDK does not enforce these — the runtime does — but they govern what you can assume on replay:

| Class | Modes | Replay guarantee |
|-------|-------|------------------|
| `semantic-deterministic` | Decision, Proposal, Quorum | same envelopes → same semantic outcome |
| `structural-only` | Task | same envelopes → same lifecycle, outcomes may differ |
| `context-frozen` | Handoff | same envelopes + same frozen context → same outcome |
| `non-deterministic` | (extension modes) | structural transitions only |

Full definitions: [RFC-MACP-0003 (Determinism)](https://github.com/multiagentcoordinationprotocol/multiagentcoordinationprotocol/blob/main/rfcs/RFC-MACP-0003-determinism.md). For Handoff mode's context-frozen nuance specifically, see [Handoff Mode § Context-Frozen Determinism](../modes/handoff.md#context-frozen-determinism).

## Version binding (SDK responsibility)

Three versions are bound at `SessionStart` and cannot change for the life of the session. The SDK passes them through verbatim — pin them explicitly when the session is part of an audit trail:

```typescript
const session = new DecisionSession(client, {
  modeVersion: '1.0.0',
  configurationVersion: 'org-2025.q4',
  policyVersion: 'procurement-v3',
});
```

Different versions produce different sessions; replay uses the bound versions, not whatever is current. See [Session Classes § Common Options](../api/sessions.md#common-options) for the full set of per-session options.

## External side effects

When a mode triggers actions outside the session (deployments, payments, emails), use the established protocol patterns to keep replay meaningful — *plan-then-execute*, *log external results*, or *idempotent external transactions*. See [Protocol Determinism § External side effects](https://github.com/multiagentcoordinationprotocol/multiagentcoordinationprotocol/blob/main/docs/determinism.md) for the canonical guidance.

The SDK supports the *plan-then-execute* pattern naturally — the Commitment carries the plan and an idempotency key:

```typescript
await session.commit({
  action: 'deployment.approved',
  authorityScope: 'release',
  reason: 'approved with idempotency_key=deploy-v2.1-20260329',
});
```

## Testing determinism in TypeScript

Verify replay correctness by recording the transcript and feeding it through a fresh projection. `applyEnvelope` takes the envelope plus the client's `ProtoRegistry` (payload decode needs it) — see [Projections § Common Interface](../api/projections.md#common-interface):

```typescript
import { DecisionProjection } from 'macp-sdk-typescript';

// Record during a live session
const transcript = session.projection.transcript;

// Replay against a new projection
const replay = new DecisionProjection();
for (const envelope of transcript) {
  replay.applyEnvelope(envelope, client.protoRegistry);
}

expect(replay.majorityWinner()).toBe(originalWinner);
expect(replay.isCommitted).toBe(originalCommitted);
```

For `semantic-deterministic` modes, the replayed projection must match the original. Build this into your test suite for any orchestrator that depends on replay — see [Testing § Writing Projection Tests](testing.md#writing-projection-tests) for the patterns this SDK's own test suite uses to exercise `applyEnvelope` directly.
