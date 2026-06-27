# Quorum Mode

**Mode identifier**: `macp.mode.quorum.v1`
**Participant model**: quorum
**Determinism**: semantic-deterministic

## Purpose

Threshold-based approval or rejection. An action requires a specified number of approvals before it can be committed.

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

### Vote Override

If the same sender votes again, their new vote **replaces** the previous one:

```typescript
// Bob initially rejects
await session.reject({ requestId: 'r1', sender: 'bob', auth: Auth.devAgent('bob') });

// Performance fix deployed, Bob changes to approve
await session.approve({
  requestId: 'r1',
  reason: 'regression fixed',
  sender: 'bob',
  auth: Auth.devAgent('bob'),
});
// Bob's rejection is replaced by approval
```

## QuorumProjection

### State

| Property | Type | Description |
|----------|------|-------------|
| `requests` | `Map<string, ApprovalRequestRecord>` | Approval requests |
| `ballots` | `Map<string, Map<string, BallotRecord>>` | requestId → sender → ballot |
| `transcript` | `Envelope[]` | All accepted envelopes |
| `phase` | `'Requesting' \| 'Voting' \| 'Committed'` | Current phase |

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
```

## RFC Validation Rules

1. At most one `ApprovalRequest` per session (base v1)
2. `requiredApprovals` must be > 0 and must not exceed participant count
3. Each participant may cast at most one ballot (Approve, Reject, or Abstain) — latest replaces earlier
4. Session is eligible for Commitment when:
   - Approvals reach the threshold, **OR**
   - Remaining possible approvals cannot reach the threshold
5. Only an authorized coordinator may emit Commitment

### Recommended Commitment Actions

| Outcome | Action |
|---------|--------|
| Threshold reached | `quorum.approved` |
| Threshold unreachable | `quorum.rejected` |

## Example

See [`examples/quorum-smoke.ts`](../../examples/quorum-smoke.ts).
