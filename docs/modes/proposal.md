# Proposal Mode

**Mode identifier**: `macp.mode.proposal.v1`
**Participant model**: peer
**Determinism**: semantic-deterministic

## Purpose

Peer-to-peer negotiation with proposals, counterproposals, accepts, rejects, and withdrawals.

> **Canonical references**: [RFC-MACP-0008 (Proposal Mode)](https://github.com/multiagentcoordinationprotocol/multiagentcoordinationprotocol/blob/main/rfcs/RFC-MACP-0008-proposal-mode.md) is normative for the state machine, authority rules, and validation constraints. See also the [spec mode summaries](https://github.com/multiagentcoordinationprotocol/multiagentcoordinationprotocol/blob/main/docs/modes.md#standard-mode-summaries) and [runtime modes guide › Proposal Mode](https://github.com/multiagentcoordinationprotocol/macp-runtime/blob/main/docs/modes.md#proposal-mode) for validation as implemented. This page covers the TypeScript API.

## Session Lifecycle

```
SessionStart → Proposal → CounterProposal? → Accept/Reject/Withdraw → Commitment
```

## API

### ProposalSession

```typescript
import { ProposalSession } from 'macp-sdk-typescript';

const session = new ProposalSession(client);
// 'coordinator' (this client's own identity) sends propose() below with no sender
// override, so it must be a declared participant — Proposal mode's default policy
// rejects a mode action from a non-participant sender with FORBIDDEN.
await session.start({ intent: '...', participants: ['coordinator', 'bob'], ttlMs: 60_000 });
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

Like every mode session, `ProposalSession` also exposes the shared lifecycle
helpers — `metadata()`, `cancel(reason)`, `suspend(reason)`, `resume(reason)`,
and `openStream()`. `suspend()` (proto 0.1.3+) is a non-terminal pause: the
runtime banks the remaining TTL and rejects messages until `resume()` restores
`SESSION_STATE_OPEN` and the banked TTL. See
[Decision Mode → Lifecycle helpers](decision.md#lifecycle-helpers).

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
| `phase` | `'Negotiating' \| 'TerminalRejected' \| 'Committed'` | Current phase |
| `commitment` | `Record<string, unknown> \| undefined` | Commitment payload if resolved |

### ProposalRecord Status

Each proposal tracks a `status` field:

| Status | Meaning |
|--------|---------|
| `open` | Active, can be accepted/rejected/withdrawn |
| `rejected` | Terminally rejected (non-terminal rejects leave status `open`) |
| `withdrawn` | Withdrawn by the proposer |

There is no `'accepted'` status: acceptance is a per-sender, supersedable
relation (RFC-MACP-0008 §5 rule 5), not a per-proposal fact — a scalar field
can't hold "alice accepts p2 while bob still accepts p1". The projection
tracks accepts separately in `accepts[]`/`latestAcceptBySender`; use
`isAccepted(id)` (issue #146). These three values are now a cross-SDK
contract pin, not just this SDK's own convention — `schemas/parity/contract.json`'s
`proposal_disposition.projection_status_values` section (`contract_version`
1.3.0) agrees with `macp-sdk-python`'s `ProposalRecord.status`, and
`PROPOSAL_STATUS_VALUES` (`src/projections/proposal.ts`) is compile-time
frozen to the `status` field's type so neither can drift from the other
without failing `npm run check`; `tests/parity/contract.test.ts` then asserts
that array against the manifest itself, so the array can't silently drift
from the pinned contract either (issue #156).

Counter-proposals set `supersedes` to link back to the original.

### Query Helpers

```typescript
session.projection.activeProposals();           // proposals with status 'open'
session.projection.liveProposals();             // Map of all non-withdrawn proposals
session.projection.latestProposal();            // most recently submitted
session.projection.isAccepted('p2');            // true if p2 is some sender's current (unsuperseded) Accept
session.projection.isTerminallyRejected('p1');  // true if terminal Reject exists
session.projection.hasTerminalRejection();      // true if any proposal was terminally rejected
session.projection.acceptedProposal();          // proposalId if every sender's current Accept targets the same one
session.projection.isCommitted;                 // true once a Commitment is applied
session.projection.isPositiveOutcome;           // undefined until committed; then outcomePositive
```

## RFC Validation Rules

The runtime enforces the cross-message rules — unique `proposal_id`s,
CounterProposal/Accept/Reject/Withdraw referencing an existing proposal,
withdrawn proposals staying withdrawn, and latest-Accept-wins retargeting. The
normative rule set lives in RFC-MACP-0008 §4; the
[runtime modes guide › Proposal Mode](https://github.com/multiagentcoordinationprotocol/macp-runtime/blob/main/docs/modes.md#proposal-mode)
documents validation as implemented.

## Example

See [`examples/proposal-smoke.ts`](../../examples/proposal-smoke.ts).
