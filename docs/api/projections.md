# Projections API Reference

Projections are pure state machines that track session state client-side. Each coordination mode has its own projection class.

## Common Interface

All projections share:

| Property | Type | Description |
|----------|------|-------------|
| `transcript` | `Envelope[]` | All accepted envelopes applied to this projection |
| `phase` | string literal union | Current session phase |
| `commitment` | `Record<string, unknown> \| undefined` | Commitment payload, set on Commitment |

All projections implement:

```typescript
applyEnvelope(envelope: Envelope, protoRegistry: ProtoRegistry): void
```

This method:
1. Checks the envelope's mode matches (ignores others)
2. Appends to `transcript`
3. Decodes the payload via `protoRegistry.decodeKnownPayload()`
4. Updates internal state based on `messageType`

## DecisionProjection

**Phases**: `'Proposal'` → `'Evaluation'` → `'Voting'` → `'Committed'`

| Property | Type |
|----------|------|
| `proposals` | `Map<string, DecisionProposalRecord>` |
| `evaluations` | `DecisionEvaluationRecord[]` |
| `objections` | `DecisionObjectionRecord[]` |
| `votes` | `Map<string, Map<string, DecisionVoteRecord>>` |

| Method | Returns | Description |
|--------|---------|-------------|
| `voteTotals()` | `Record<string, number>` | Positive vote counts per proposal |
| `majorityWinner()` | `string \| undefined` | Proposal with most positive votes |
| `hasBlockingObjection(proposalId)` | `boolean` | Has high/critical/block severity objection |

## ProposalProjection

**Phases**: `'Proposing'` → `'Negotiating'` → `'Committed'`

| Property | Type |
|----------|------|
| `proposals` | `Map<string, ProposalRecord>` |
| `accepts` | `ProposalAcceptRecord[]` |
| `rejections` | `ProposalRejectRecord[]` |

| Method | Returns | Description |
|--------|---------|-------------|
| `activeProposals()` | `ProposalRecord[]` | Proposals with status `'open'` |
| `latestProposal()` | `ProposalRecord \| undefined` | Most recently submitted |
| `isAccepted(proposalId)` | `boolean` | Has any Accept for this ID |
| `isTerminallyRejected(proposalId)` | `boolean` | Has terminal Reject |

## TaskProjection

**Phases**: `'Requesting'` → `'InProgress'` → `'Completed'` / `'Failed'` → `'Committed'`

| Property | Type |
|----------|------|
| `tasks` | `Map<string, TaskRecord>` |
| `updates` | `TaskUpdateRecord[]` |
| `completions` | `TaskCompletionRecord[]` |
| `failures` | `TaskFailureRecord[]` |

| Method | Returns | Description |
|--------|---------|-------------|
| `getTask(taskId)` | `TaskRecord \| undefined` | Full task record |
| `progressOf(taskId)` | `number` | Current progress (0.0 - 1.0) |
| `isComplete(taskId)` | `boolean` | TaskComplete received |
| `isFailed(taskId)` | `boolean` | TaskFail received |
| `isRetryable(taskId)` | `boolean` | Failed with `retryable: true` |
| `activeTasks()` | `TaskRecord[]` | Tasks in requested/accepted/in_progress |

## HandoffProjection

**Phases**: `'Offering'` → `'ContextSharing'` → `'Resolved'` → `'Committed'`

| Property | Type |
|----------|------|
| `handoffs` | `Map<string, HandoffRecord>` |

| Method | Returns | Description |
|--------|---------|-------------|
| `getHandoff(handoffId)` | `HandoffRecord \| undefined` | Full handoff record |
| `isAccepted(handoffId)` | `boolean` | HandoffAccept received |
| `isDeclined(handoffId)` | `boolean` | HandoffDecline received |
| `pendingHandoffs()` | `HandoffRecord[]` | Handoffs in offered/context_sent status |

## QuorumProjection

**Phases**: `'Requesting'` → `'Voting'` → `'Committed'`

| Property | Type |
|----------|------|
| `requests` | `Map<string, ApprovalRequestRecord>` |
| `ballots` | `Map<string, Map<string, BallotRecord>>` |

| Method | Returns | Description |
|--------|---------|-------------|
| `approvalCount(requestId)` | `number` | Count of approve ballots |
| `rejectionCount(requestId)` | `number` | Count of reject ballots |
| `abstentionCount(requestId)` | `number` | Count of abstain ballots |
| `hasQuorum(requestId)` | `boolean` | Approvals >= required threshold |
| `threshold(requestId)` | `number` | Required approvals for this request |
| `remainingVotesNeeded(requestId)` | `number` | max(0, required - approvalCount) |
| `votedSenders(requestId)` | `string[]` | Senders who have voted |
