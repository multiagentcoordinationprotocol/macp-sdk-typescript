# Proposal Mode

**Mode identifier**: `macp.mode.proposal.v1`
**Participant model**: peer
**Determinism**: semantic-deterministic

## Purpose

Peer-to-peer negotiation with proposals, counterproposals, accepts, rejects, and withdrawals.

## Session Lifecycle

```
SessionStart → Proposal → CounterProposal? → Accept/Reject/Withdraw → Commitment
```

## API

### ProposalSession

```typescript
import { ProposalSession } from 'macp-sdk-typescript';

const session = new ProposalSession(client);
await session.start({ intent: '...', participants: ['bob'], ttlMs: 60_000 });
```

#### Methods

| Method | Message Type | Description |
|--------|-------------|-------------|
| `propose(input)` | `Proposal` | Submit an initial proposal |
| `counterPropose(input)` | `CounterProposal` | Submit a counterproposal that supersedes another |
| `accept(input)` | `Accept` | Accept a proposal |
| `reject(input)` | `Reject` | Reject a proposal (optionally terminal) |
| `withdraw(input)` | `Withdraw` | Withdraw a proposal |
| `commit(input)` | `Commitment` | Finalize the negotiation |

### Propose

```typescript
await session.propose({
  proposalId: 'p1',
  title: 'Use React',
  summary: 'Mature ecosystem with large community',
  tags: ['frontend', 'framework'],
});
```

### Counter-Propose

```typescript
await session.counterPropose({
  proposalId: 'p2',
  supersedesProposalId: 'p1',  // links to original
  title: 'Use Svelte',
  summary: 'Lighter bundle, better DX',
  sender: 'bob',
  auth: Auth.devAgent('bob'),
});
```

### Accept / Reject / Withdraw

```typescript
await session.accept({ proposalId: 'p2', reason: 'agreed' });

// Non-terminal rejection (negotiation continues)
await session.reject({ proposalId: 'p1', terminal: false, reason: 'too heavy' });

// Terminal rejection (proposal permanently rejected)
await session.reject({ proposalId: 'p1', terminal: true, reason: 'blocked' });

// Withdraw own proposal
await session.withdraw({ proposalId: 'p1', reason: 'superseded' });
```

## ProposalProjection

### State

| Property | Type | Description |
|----------|------|-------------|
| `proposals` | `Map<string, ProposalRecord>` | All proposals with status tracking |
| `accepts` | `ProposalAcceptRecord[]` | All accept messages |
| `rejections` | `ProposalRejectRecord[]` | All rejection messages |
| `transcript` | `Envelope[]` | All accepted envelopes |
| `phase` | `'Proposing' \| 'Negotiating' \| 'Committed'` | Current phase |

### ProposalRecord Status

Each proposal tracks a `status` field:

| Status | Meaning |
|--------|---------|
| `open` | Active, can be accepted/rejected/withdrawn |
| `accepted` | Has been accepted by a participant |
| `rejected` | Terminally rejected |
| `withdrawn` | Withdrawn by the proposer |

Counter-proposals set `supersedes` to link back to the original.

### Query Helpers

```typescript
session.projection.activeProposals();           // proposals with status 'open'
session.projection.latestProposal();            // most recently submitted
session.projection.isAccepted('p2');            // true if any Accept exists
session.projection.isTerminallyRejected('p1');  // true if terminal Reject exists
```

## RFC Validation Rules

1. Every `proposal_id` must be unique within the session
2. `CounterProposal.supersedesProposalId` must reference an existing proposal
3. Accept, Reject, and Withdraw must reference an existing proposal
4. Withdrawn proposals cannot later be accepted or committed
5. Participants may change acceptance targets; latest Accept supersedes earlier ones

## Example

See [`examples/proposal-smoke.ts`](../../examples/proposal-smoke.ts).
