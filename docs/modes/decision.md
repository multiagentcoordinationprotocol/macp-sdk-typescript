# Decision Mode

**Mode identifier**: `macp.mode.decision.v1`
**Participant model**: declared
**Determinism**: semantic-deterministic

## Purpose

Structured decision-making with proposals, evaluations, objections, and votes leading to a bound outcome via Commitment.

> **Canonical references**: [RFC-MACP-0007 (Decision Mode)](https://github.com/multiagentcoordinationprotocol/multiagentcoordinationprotocol/blob/main/rfcs/RFC-MACP-0007-decision-mode.md) is normative for the state machine, authority rules, and validation constraints. See also the [spec mode summaries](https://github.com/multiagentcoordinationprotocol/multiagentcoordinationprotocol/blob/main/docs/modes.md#standard-mode-summaries) and [runtime modes guide › Decision Mode](https://github.com/multiagentcoordinationprotocol/macp-runtime/blob/main/docs/modes.md#decision-mode) for validation as implemented. This page covers the TypeScript API.

## Session Lifecycle

```
SessionStart → Proposal → Evaluation → Objection? → Vote → Commitment
```

### Phase Transitions

| Phase | Triggered By | Allowed Messages |
|-------|-------------|-----------------|
| `Proposal` | Session start | Proposal |
| `Evaluation` | First Proposal | Proposal, Evaluation, Objection |
| `Voting` | First Vote | Vote |
| `Committed` | Commitment | (terminal) |

## API

### DecisionSession

```typescript
import { DecisionSession, MacpClient, Auth } from 'macp-sdk-typescript';

const session = new DecisionSession(client, {
  sessionId: 'optional-custom-id',  // default: auto-generated UUID
  modeVersion: '1.0.0',             // default
  configurationVersion: 'config.default',
  policyVersion: 'policy.default',
  auth: Auth.devAgent('coordinator'),
});
```

#### `start(input)`

Initiates the decision session.

```typescript
await session.start({
  intent: 'choose deployment strategy',
  participants: ['alice', 'bob', 'carol'],
  ttlMs: 300_000,    // 5 minutes (max 24 hours)
  contextId: 'proj-web-app',                 // optional correlation id
  extensions: { note: Buffer.from('...') },  // optional opaque extension payloads
  roots: [{ uri: 'https://git.example.com/repo', name: 'main-repo' }],
  maxSuspendMs: 3_600_000,  // optional (proto ≥ 0.1.5); 0/absent = runtime default
  sender: 'coordinator',    // optional, derived from auth
});
```

#### `propose(input)`

Submit a proposal for consideration.

```typescript
await session.propose({
  proposalId: 'p1',          // unique within session
  option: 'canary-deploy',   // the proposed option
  rationale: 'gradual rollout with monitoring',
  supportingData: Buffer.from('...'),  // optional
});
```

#### `evaluate(input)`

Add an evaluation of a proposal.

```typescript
await session.evaluate({
  proposalId: 'p1',
  recommendation: 'approve',  // 'approve' | 'review' | 'block' | 'reject' (case-insensitive)
  confidence: 0.92,            // 0.0 - 1.0
  reason: 'risk assessment favorable',
  sender: 'alice',
  auth: Auth.devAgent('alice'),
});
```

#### `raiseObjection(input)`

Flag an objection against a proposal.

```typescript
await session.raiseObjection({
  proposalId: 'p1',
  reason: 'insufficient monitoring coverage',
  severity: 'high',  // 'low' | 'medium' | 'high' | 'critical' (case-insensitive; only 'critical' blocks)
  sender: 'bob',
  auth: Auth.devAgent('bob'),
});
```

#### `vote(input)`

Cast a vote on a proposal.

```typescript
await session.vote({
  proposalId: 'p1',
  vote: 'approve',  // 'approve' | 'reject' | 'abstain' (case-insensitive; validated client-side)
  reason: 'all concerns addressed',
  sender: 'carol',
  auth: Auth.devAgent('carol'),
});
```

#### `commit(input)`

Finalize the decision session.

```typescript
await session.commit({
  action: 'deployment.approved',
  authorityScope: 'release-management',
  reason: 'unanimous approval for canary deploy',
  commitmentId: 'optional-custom-id',  // default: auto-generated UUID
  outcomePositive: true,               // optional; omitted = positive outcome
});
```

#### Lifecycle helpers

Every session class (all 5 modes) shares the same lifecycle surface:

```typescript
await session.metadata();            // { metadata: SessionMetadata } from the runtime
await session.cancel('reason');      // CancelSession — terminal (SESSION_STATE_CANCELLED)
await session.suspend('reason');     // SuspendSession (proto 0.1.3+) — non-terminal pause:
                                     // remaining TTL is banked; messages are rejected until resume()
await session.resume('reason');      // ResumeSession — restores SESSION_STATE_OPEN and the banked TTL
const stream = session.openStream(); // duplex MacpStream using the session's auth
```

Each helper accepts an optional trailing `auth` override. `cancel()`, `suspend()`,
and `resume()` throw `MacpAckError` if the runtime rejects the request.

## DecisionProjection

The projection tracks all proposals, evaluations, objections, and votes locally.

### State

| Property | Type | Description |
|----------|------|-------------|
| `proposals` | `Map<string, DecisionProposalRecord>` | Proposals by ID |
| `evaluations` | `DecisionEvaluationRecord[]` | All evaluations |
| `objections` | `DecisionObjectionRecord[]` | All objections |
| `votes` | `Map<string, Map<string, DecisionVoteRecord>>` | Votes by proposalId → sender |
| `transcript` | `Envelope[]` | All accepted envelopes |
| `phase` | `'Proposal' \| 'Evaluation' \| 'Voting' \| 'Committed'` | Current phase |
| `commitment` | `Record<string, unknown> \| undefined` | Commitment payload if resolved |

### Query Helpers

```typescript
// Count positive votes per proposal
session.projection.voteTotals();
// → { 'p1': 2, 'p2': 1 }

// Proposal holding a strict majority (>50%) of all non-abstain votes, if any
session.projection.majorityWinner();
// → 'p1'

// APPROVE ratio for one proposal (ABSTAIN excluded from the denominator)
session.projection.voteRatio('p1');
// → 0.67

// Check for blocking objections (only severity 'critical' blocks per RFC-MACP-0004)
session.projection.hasBlockingObjection('p1');
// → true/false

// Evaluations split by recommendation: REVIEW (informational) vs the rest (qualifying)
session.projection.reviewEvaluations();
session.projection.qualifyingEvaluations();

// Commitment state (getters, available on every mode projection)
session.projection.isCommitted;        // true once a Commitment is applied
session.projection.isPositiveOutcome;  // undefined until committed; then outcomePositive (default true)
```

### Vote Deduplication

If the same sender votes twice on the same proposal, the later vote replaces the earlier one.

## RFC Validation Rules

The runtime enforces the cross-message rules — unique `proposal_id`s,
Evaluation/Objection/Vote referencing an existing proposal, one Vote per
participant per proposal (latest wins), commitment authority, and at least one
proposal before resolution. The SDK validates only field formats client-side
(vote/recommendation/severity values, confidence range, required fields). The
normative rule set lives in RFC-MACP-0007 §4; the
[runtime modes guide › Decision Mode](https://github.com/multiagentcoordinationprotocol/macp-runtime/blob/main/docs/modes.md#decision-mode)
documents validation as implemented, including the NACK codes each rejection
produces.

## Example

See [`examples/decision-smoke.ts`](../../examples/decision-smoke.ts) for a complete working example.
