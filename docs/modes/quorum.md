# Quorum Mode

**Mode identifier**: `macp.mode.quorum.v1`
**Participant model**: quorum
**Determinism**: semantic-deterministic

## Purpose

Threshold-based approval or rejection. An action requires a specified number of approvals before it can be committed.

> **Canonical references**: [RFC-MACP-0011 (Quorum Mode)](https://github.com/multiagentcoordinationprotocol/multiagentcoordinationprotocol/blob/main/rfcs/RFC-MACP-0011-quorum-mode.md) is normative for the state machine, threshold arithmetic, and validation constraints. See also the [spec mode summaries](https://github.com/multiagentcoordinationprotocol/multiagentcoordinationprotocol/blob/main/docs/modes.md#standard-mode-summaries) and [runtime modes guide › Quorum Mode](https://github.com/multiagentcoordinationprotocol/macp-runtime/blob/main/docs/modes.md#quorum-mode) for validation as implemented. This page covers the TypeScript API.

## Session Lifecycle

```
SessionStart → ApprovalRequest → Approve/Reject/Abstain (per participant) → Commitment
```

## API

### QuorumSession

```typescript
import { QuorumSession } from 'macp-sdk-typescript';

const session = new QuorumSession(client);
await session.start({
  intent: 'approve production deploy',
  participants: ['alice', 'bob', 'carol'],
  ttlMs: 60_000,
});
```

#### Methods

| Method | Message Type | Description |
|--------|-------------|-------------|
| `requestApproval(input)` | `ApprovalRequest` | Define what needs approval |
| `approve(input)` | `Approve` | Cast an approval vote |
| `reject(input)` | `Reject` | Cast a rejection vote |
| `abstain(input)` | `Abstain` | Abstain from voting |
| `commit(input)` | `Commitment` | Finalize once quorum is reached |

Like every mode session, `QuorumSession` also exposes the shared lifecycle
helpers — `metadata()`, `cancel(reason)`, `suspend(reason)`, `resume(reason)`,
and `openStream()`. `suspend()` (proto 0.1.3+) is a non-terminal pause: the
runtime banks the remaining TTL and rejects messages until `resume()` restores
`SESSION_STATE_OPEN` and the banked TTL. See
[Decision Mode → Lifecycle helpers](decision.md#lifecycle-helpers).

### Request Approval

```typescript
await session.requestApproval({
  requestId: 'r1',
  action: 'deploy-v3.0-to-production',
  summary: 'Production deployment of v3.0 with new auth system',
  details: Buffer.from('...'),  // optional
  requiredApprovals: 2,          // must be > 0 and <= participant count
});
```

### Cast Votes

```typescript
// Approve
await session.approve({
  requestId: 'r1',
  reason: 'all tests pass, staging verified',
  sender: 'alice',
  auth: Auth.devAgent('alice'),
});

// Reject
await session.reject({
  requestId: 'r1',
  reason: 'performance regression detected',
  sender: 'bob',
  auth: Auth.devAgent('bob'),
});

// Abstain
await session.abstain({
  requestId: 'r1',
  reason: 'not familiar with this component',
  sender: 'carol',
  auth: Auth.devAgent('carol'),
});
```

### Ballot Cardinality

Per [RFC-MACP-0011](https://github.com/multiagentcoordinationprotocol/multiagentcoordinationprotocol/blob/main/rfcs/RFC-MACP-0011-quorum-mode.md)
§5 rule 3, each eligible participant may cast **at most one ballot across
`Approve`, `Reject`, and `Abstain`** for a given `requestId`. Casting a ballot
at all is optional (`MAY`) — but the cap of one is enforced under §5's opening
sentence, "Implementations MUST enforce the following:", which puts the `MUST`
on the implementation rather than the participant directly (contrast
[RFC-MACP-0007](https://github.com/multiagentcoordinationprotocol/multiagentcoordinationprotocol/blob/main/rfcs/RFC-MACP-0007-decision-mode.md)
§5 item 3, which states the same-strength obligation directly on the
participant for `Vote`). A conforming runtime **rejects** a second ballot from
the same sender for the same request, regardless of type — a `Reject` after an
earlier `Abstain` is a duplicate ballot, not a change of vote.

RFC-MACP-0011 §5 rule 3 caps *how many* ballots a sender may have; it does not
say *which of two* stands if a second one is somehow observed — that is
outside what the rule states. This SDK's projection keeps the sender's
**first** accepted ballot and discards any later one, in parity with
RFC-MACP-0007 §5 item 3's explicit first-stands rule for `Vote` and with
`macp-runtime`'s behavior (it enforces first-wins identically in all three
ballot arms). That first-wins choice is an inference from parity and observed
runtime behavior, not a direct RFC-MACP-0011 citation — a spec clarification
will be requested upstream to close this gap.

A discarded duplicate is recorded in
[`anomalies`](../api/projections.md#anomalies) as a `duplicate_ballot`, naming
both the kept and the discarded ballot type. Reaching this path at all means
the transcript was not filtered to a conforming runtime's *accepted*
history — see [Input contract](../api/projections.md#input-contract).

## QuorumProjection

### State

| Property | Type | Description |
|----------|------|-------------|
| `requests` | `Map<string, ApprovalRequestRecord>` | Approval requests |
| `ballots` | `Map<string, Map<string, BallotRecord>>` | requestId → sender → ballot |
| `transcript` | `Envelope[]` | All accepted envelopes |
| `phase` | `'Pending' \| 'Voting' \| 'Committed'` | Current phase |
| `commitment` | `Record<string, unknown> \| undefined` | Commitment payload if resolved |

### BallotRecord

```typescript
interface BallotRecord {
  requestId: string;
  vote: 'approve' | 'reject' | 'abstain';
  reason?: string;
  sender: string;
}
```

### Query Helpers

```typescript
// Vote counts
session.projection.approvalCount('r1');          // number of approve votes
session.projection.rejectionCount('r1');         // number of reject votes
session.projection.abstentionCount('r1');        // number of abstain votes

// Threshold checks
session.projection.threshold('r1');              // requiredApprovals value
session.projection.hasQuorum('r1');              // approvalCount >= requiredApprovals
session.projection.remainingVotesNeeded('r1');   // max(0, required - approvalCount)

// Participation
session.projection.votedSenders('r1');           // ['alice', 'bob', 'carol']

// Commitment readiness
session.projection.commitmentReady('r1');        // quorum reached and not yet committed
session.projection.isThresholdUnreachable('r1', 3); // remaining unvoted eligibles can't reach threshold
session.projection.isCommitted;                  // true once a Commitment is applied
session.projection.isPositiveOutcome;            // undefined until committed; then outcomePositive
```

## RFC Validation Rules

The runtime enforces the cross-message rules — at most one `ApprovalRequest`
per session (base v1), `requiredApprovals` within `(0, participant count]`, at
most one ballot per participant across `Approve`/`Reject`/`Abstain` (the
runtime **rejects** a second ballot from the same sender; the first accepted
ballot stands — see [Ballot Cardinality](#ballot-cardinality) above),
commitment eligibility only once the threshold is reached or provably
unreachable, and coordinator-only Commitment. The normative rule set lives in
RFC-MACP-0011 §4; the
[runtime modes guide › Quorum Mode](https://github.com/multiagentcoordinationprotocol/macp-runtime/blob/main/docs/modes.md#quorum-mode)
documents validation as implemented.

### Recommended Commitment Actions

| Outcome | Action |
|---------|--------|
| Threshold reached | `quorum.approved` |
| Threshold unreachable | `quorum.rejected` |

## Example

See [`examples/quorum-smoke.ts`](../../examples/quorum-smoke.ts).
