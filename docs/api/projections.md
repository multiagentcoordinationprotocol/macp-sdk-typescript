# Projections API Reference

Projections are pure state machines that track session state client-side. Each coordination mode has its own projection class.

## Common Interface

All projections share:

| Property | Type | Description |
|----------|------|-------------|
| `transcript` | `Envelope[]` | All accepted envelopes applied to this projection |
| `phase` | string literal union | Current session phase |
| `commitment` | `Record<string, unknown> \| undefined` | Commitment payload, set on Commitment |
| `isCommitted` | `boolean` (getter) | `true` once a Commitment has been applied |
| `isPositiveOutcome` | `boolean \| undefined` (getter) | Commitment's `outcomePositive`; `undefined` before commit, `true` when the field is absent |

All projections implement:

```typescript
applyEnvelope(envelope: Envelope, protoRegistry: ProtoRegistry): void
```

This method:
1. Checks the envelope's mode matches (ignores others)
2. Appends to `transcript`
3. Decodes the payload via `protoRegistry.decodeKnownPayload()`
4. Updates internal state based on `messageType`

## BaseProjection (custom modes)

`BaseProjection` is the abstract base for projections of custom (extension)
modes — pair it with `BaseSession`. It handles `Commitment` (sets `commitment`,
moves `phase` to `'Committed'`) and the transcript for free; subclasses supply
the `mode` string and override `applyMode(envelope, protoRegistry)` for the
mode-specific message types. The five built-in projections below pre-date
`BaseProjection` and implement the same surface directly.

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
| `majorityWinner()` | `string \| undefined` | Proposal whose positive votes exceed 50% of all non-abstain votes |
| `voteRatio(proposalId)` | `number` | Approve ratio, excluding abstains from the denominator |
| `hasBlockingObjection(proposalId?)` | `boolean` | Has a **critical**-severity objection (only critical blocks per RFC-MACP-0004); omit the ID to check all proposals |
| `reviewEvaluations()` | `DecisionEvaluationRecord[]` | Evaluations with REVIEW recommendation (informational) |
| `qualifyingEvaluations()` | `DecisionEvaluationRecord[]` | Evaluations excluding REVIEW |

## ProposalProjection

**Phases**: `'Negotiating'` → `'TerminalRejected'` / `'Committed'`

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
| `liveProposals()` | `Map<string, ProposalRecord>` | All proposals except withdrawn ones |
| `acceptedProposal()` | `string \| undefined` | The single accepted proposal ID; `undefined` if none or if accepts span multiple IDs |
| `hasTerminalRejection()` | `boolean` | Any terminal Reject in the session |

## TaskProjection

**Phases**: `'Pending'` → `'Requested'` → `'InProgress'` → `'Completed'` / `'Failed'` → `'Committed'`

| Property | Type |
|----------|------|
| `tasks` | `Map<string, TaskRecord>` |
| `updates` | `TaskUpdateRecord[]` |
| `completions` | `TaskCompletionRecord[]` |
| `failures` | `TaskFailureRecord[]` |

| Method | Returns | Description |
|--------|---------|-------------|
| `getTask(taskId)` | `TaskRecord \| undefined` | Full task record |
| `progressOf(taskId)` | `number` | Current progress (0 before any update, 1 once complete) |
| `isComplete(taskId)` | `boolean` | TaskComplete received |
| `isFailed(taskId)` | `boolean` | TaskFail received |
| `isRetryable(taskId)` | `boolean` | Failed with `retryable: true` |
| `isAccepted(taskId)` | `boolean` | Status is accepted or in_progress |
| `activeTasks()` | `TaskRecord[]` | Tasks in requested/accepted/in_progress |
| `latestProgress()` | `number \| undefined` | Progress of the most recent TaskUpdate |

## HandoffProjection

**Phases**: `'Pending'` → `'OfferPending'` → `'ContextSharing'` → `'Accepted'` / `'Declined'` → `'Committed'`

| Property | Type |
|----------|------|
| `handoffs` | `Map<string, HandoffRecord>` |

| Method | Returns | Description |
|--------|---------|-------------|
| `getHandoff(handoffId)` | `HandoffRecord \| undefined` | Full handoff record (`.implicit` set once accepted) |
| `isAccepted(handoffId)` | `boolean` | HandoffAccept received |
| `isImplicitlyAccepted(handoffId)` | `boolean` | Accepted by a runtime synthetic implicit accept (RFC-MACP-0010 §5.1, proto ≥ 0.1.6) |
| `isDeclined(handoffId)` | `boolean` | HandoffDecline received |
| `pendingHandoffs()` | `HandoffRecord[]` | Handoffs in offered/context_sent status |
| `hasAcceptedOffer(handoffId?)` | `boolean` | Given handoff accepted, or (with no ID) any handoff accepted |
| `activeOffer()` | `HandoffRecord \| undefined` | Most recent handoff still in offered/context_sent status |

## QuorumProjection

**Phases**: `'Pending'` → `'Voting'` → `'Committed'`

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
| `commitmentReady(requestId)` | `boolean` | Quorum reached and not yet committed |
| `isThresholdUnreachable(requestId, totalEligible)` | `boolean` | Even if all remaining eligible voters approve, the threshold cannot be met |
