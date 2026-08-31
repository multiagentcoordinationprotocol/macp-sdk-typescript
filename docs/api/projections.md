# Projections API Reference

Projections are pure state machines that track session state client-side. Each coordination mode has its own projection class.

## Common Interface

All projections share:

| Property | Type | Description |
|----------|------|-------------|
| `transcript` | `Envelope[]` | The session's accepted history as a conforming runtime holds it: one envelope per unique `message_id`, in application order. See [Redelivery](#redelivery-message_id-dedup) below. |
| `phase` | string literal union | Current session phase |
| `commitment` | `Record<string, unknown> \| undefined` | Commitment payload, set on Commitment |
| `isCommitted` | `boolean` (getter) | `true` once a Commitment has been applied |
| `isPositiveOutcome` | `boolean \| undefined` (getter) | Commitment's `outcomePositive`; `undefined` before commit, `true` when the field is absent |
| `anomalies` | `ProjectionAnomaly[]` | Cardinality anomalies recorded while replaying the accepted transcript. See [Anomalies](#anomalies) below. |
| `hasAnomalies` | `boolean` (getter) | `true` once at least one anomaly has been recorded |

All projections implement:

```typescript
applyEnvelope(envelope: Envelope, protoRegistry: ProtoRegistry): void
```

This method:
1. Checks the envelope's mode matches (ignores others)
2. Appends to `transcript`
3. Decodes the payload via `protoRegistry.decodeKnownPayload()`
4. Updates internal state based on `messageType`

## Input contract

`applyEnvelope` assumes every envelope passed to it was **accepted** by a
conforming MACP runtime — i.e. it is part of the session's authoritative
accepted history, never a submission the runtime rejected. This is a
**caller-maintained invariant**, not something `applyEnvelope` itself can
verify: `Envelope` carries no acceptance marker on the wire, so there is no
field a projection could inspect to tell an accepted envelope from a rejected
one.

The rule is canonical upstream, in the spec repo's
`schemas/conformance/README.md` "Notes:" section, verbatim: "SDKs replay only
`accept` messages through their projections (reject-path fixtures replay
their accepted *prefix*)." It backs a substantive protocol guarantee —
[RFC-MACP-0007 (Decision Mode)](https://github.com/multiagentcoordinationprotocol/multiagentcoordinationprotocol/blob/main/rfcs/RFC-MACP-0007-decision-mode.md)
§5 rule 3 ("the first accepted `Vote` stands") and
[RFC-MACP-0011 (Quorum Mode)](https://github.com/multiagentcoordinationprotocol/multiagentcoordinationprotocol/blob/main/rfcs/RFC-MACP-0011-quorum-mode.md)
§5 rule 3 (at most one ballot per participant) both describe what a
conforming runtime enforces on *accepted* history — so a projection
reconstructing that history is only correct when it is fed the same set the
runtime held.

This SDK's own send paths already uphold the invariant: each of the five
built-in mode sessions has its own private `sendAndTrack` that calls
`this.projection.applyEnvelope(...)` only after a successful ACK (gated on
`ack.ok`). `BaseSession`'s own `sendAndTrack` — the equivalent path for custom
modes built on the ext-mode extension point — does the same. The conformance
test harness upholds it too, by filtering fixture messages to
`expect === 'accept'` before replaying them.

**Failure mode if the contract is violated:** feeding `applyEnvelope` raw
captured or hand-built traffic — including envelopes a runtime rejected —
replays a timeline no conforming runtime ever held, and the projection
fabricates state accordingly. For example, a session whose only `Commitment`
was rejected can still surface `isCommitted === true` and
`phase === 'Committed'` if that rejected envelope is replayed anyway, making
an unresolved session look resolved. See
`tests/unit/projections/accepted-only-contract.test.ts` for an executable
demonstration, across `DecisionProjection`, `QuorumProjection`, and a custom
`BaseProjection` subclass.

If you are building your own transport or replay path, filter to accepted
envelopes yourself before calling `applyEnvelope` — do not rely on
`applyEnvelope` to reject anything on your behalf.

There is also an implicit **one projection per session** contract: the
`message_id` dedup key described below is global to the projection instance,
not scoped to `(sessionId, message_id)` — `applyEnvelope` never inspects
`envelope.sessionId`. Feeding the transcripts of two different sessions into
one projection instance can therefore silently drop envelopes whose
`message_id`s happen to collide across sessions. This mirrors the runtime's
own dedup set, which is likewise kept per session, so the fix is to give each
session its own projection instance, not to widen the dedup key.

## Redelivery (`message_id` dedup)

`applyEnvelope` is idempotent with respect to `message_id`: applying the same
envelope (identical `message_id`) more than once has no effect after the
first application — it is not appended to `transcript`, and it is not passed
to the mode-specific switch/`applyMode`. This is required by
[RFC-MACP-0006 (Transport Bindings)](https://github.com/multiagentcoordinationprotocol/multiagentcoordinationprotocol/blob/main/rfcs/RFC-MACP-0006-transport-bindings.md)
§3.2 Redelivery:

- A runtime **MAY** echo back accepted client-submitted envelopes on the
  stream as part of the authoritative accepted sequence (`:94`) — this is why
  a redelivered envelope is expected traffic, not a defect to route around.
- A redelivery **MUST NOT** advance the client's sequence position (`:134`)
  or count a second time against any Mode cardinality rule — "a second" means
  a distinct `message_id`, never the same envelope arriving twice (`:135`).
- A consumer that accumulates state per envelope — appending to a list,
  incrementing a counter — **MUST** be idempotent with respect to
  `message_id` (`:136`).

This closes a live gap on the `Participant` happy path: the [shared
projection instance](#design-intent-shared-projection-instance) below means
every initiator envelope is naturally applied twice — once locally on ACK via
the mode session's own `sendAndTrack`, and again when the transport replays
accepted history. Before this dedup, that double-apply silently corrupted
every accumulate-on-apply site (Decision `evaluations`/`objections`, Proposal
`accepts`/`rejections`, Task `updates`/`completions`/`failures`).

Key properties:

- **Empty/absent `message_id` is never deduped.** The guard is gated on
  `if (envelope.messageId)`; an id-less envelope always applies. This matters
  for hand-built envelopes from callers who don't set `messageId` — treating
  every one of them as "the same message" would collapse a whole feed into
  one entry.
- **A redelivery is not an anomaly.** MACP's transport is at-least-once by
  design ([RFC-MACP-0001](https://github.com/multiagentcoordinationprotocol/multiagentcoordinationprotocol/blob/main/rfcs/RFC-MACP-0001-core-envelope.md)
  §8), so a redelivery is logged at `debug`, never `warn` — there is no
  anomaly-tracking surface on projections today that a redelivery could be
  mistakenly reported through.
- **The dedup set is unbounded, deliberately.** The projection already
  retains every full envelope (payload bytes included) in `transcript`, so a
  `Set<string>` of ids is strictly dominated by that; sessions are also
  TTL-bounded by protocol.
- **`GrpcTransportAdapter`** is covered end to end (it is the path the
  [shared projection instance](#design-intent-shared-projection-instance)
  below is about). **`HttpTransportAdapter`'s array (Python-style polling)
  branch** normalizes `message_id` → `messageId` before yielding,
  specifically so this guard can see a real id for polled envelopes too.

### What changed

Before this dedup, `applyEnvelope` appended every envelope that reached it
(past the mode check) unconditionally — a second delivery of the same
`message_id` was pushed onto `transcript` again, and passed to `applyMode`
again. If you were relying on `transcript` as an exact receipt of everything
you handed to `applyEnvelope`, that reading was already unreliable before
this change, for two independent reasons:

- `applyEnvelope` has **always** silently dropped envelopes for a different
  mode (the `if (envelope.mode !== this.mode) return;` guard predates this
  change) — so "an exact receipt of everything handed in" was never the
  contract, dedup or not.
- On this SDK's own `Participant` happy path, the
  [shared projection instance](#design-intent-shared-projection-instance)
  below means the initiator's own envelope is naturally applied twice — once
  locally on ACK via the mode session's `sendAndTrack`, once again via
  replayed transport history — so a consumer treating `transcript` as a raw
  receipt was already getting corrupted data (each such envelope duplicated)
  before this fix landed, not after it.

If you genuinely need a raw receipt of every envelope you passed to
`applyEnvelope`, keep your own list of what you passed in — you already hold
those envelopes at the call site. `transcript` is deliberately not that list,
before or after this change; it is the runtime's accepted, deduplicated
history.

## Anomalies

`ProjectionAnomalyKind` and `ProjectionAnomaly` — exported from the package
root, together with the `anomalies` field and `hasAnomalies` getter on every
projection — record cardinality anomalies observed while replaying an
accepted transcript. Like `transcript`, `anomalies` is `readonly` at the
field level only — that keeps a consumer from rebinding the property to a
different array, it does not make the array itself immutable; `.push()` onto
`anomalies` works exactly like `.push()` onto `transcript`.

```typescript
export type ProjectionAnomalyKind = 'duplicate_vote' | 'duplicate_ballot';

export interface ProjectionAnomaly {
  kind: ProjectionAnomalyKind;
  mode: string;
  messageType: string;
  messageId: string;
  sender: string;
  /** proposal_id (Decision) or request_id (Quorum) the duplicate targeted */
  subjectId: string;
  detail: string;
}
```

This is a **cross-SDK frozen contract**, agreed with `macp-sdk-python` (same
seven fields, snake_case there) — do not add, rename, or remove a field
without cross-SDK agreement.

**What an anomaly means — deliberately narrow, agreed wording across both
SDKs:** an anomaly records that a second distinct `Vote` from this sender for
this proposal (`duplicate_vote`, RFC-MACP-0007 §5.3), or a second distinct
ballot across `Approve`/`Reject`/`Abstain` from this sender for this request
(`duplicate_ballot`, RFC-MACP-0011 §5 rule 3), **was observed and discarded —
the first stands.** (RFC-MACP-0011 §5 rule 3 caps *how many* ballots and is
silent on *which of two* stands; first-ballot-wins here is parity with
RFC-MACP-0007 §5.3 plus runtime-enforced behaviour.) It does **not**, and
structurally cannot, claim "this transcript violates the spec": a projection
has no way to tell a genuinely non-conforming source from a conforming source
fed through an unfiltered loader, because acceptance is not a wire property
(see [Input contract](#input-contract) above). Do not read more into an
anomaly than what was observed and what this projection did about it.

**Only `DecisionProjection` and `QuorumProjection` populate `anomalies`
today** — a duplicate `Vote` and a duplicate ballot, respectively. The other
three built-in projections (`ProposalProjection`, `TaskProjection`,
`HandoffProjection`) expose the same field and getter for a uniform surface,
but nothing currently writes to them.

Recording an anomaly does two things:
1. Pushes the `ProjectionAnomaly` onto `anomalies` — the canonical, cross-SDK
   agreed semantic. Read this array; it is what you should build logic on.
2. Emits `logger.warn('projection anomaly', anomaly)` — this half is
   **explicitly non-contractual observability and may differ per SDK.**
   `logger.warn` is visible by default (this SDK's default log level is
   `warn`, see `src/logging.ts`): observing and discarding a duplicate is
   deliberately not silent. If you need to quiet the log line without losing
   the `anomalies` array, raise the log level —
   `configureLogging({ level: 'error' })` or the `MACP_LOG_LEVEL` environment
   variable.

`BaseProjection` also exposes a `protected recordAnomaly(anomaly)` helper
that does both of the above, for custom (ext-mode) projections built on
`BaseProjection`. The built-in `DecisionProjection` and `QuorumProjection` do
not extend `BaseProjection` (see [BaseProjection
(custom modes)](#baseprojection-custom-modes) below) and inline the same two
lines directly at their duplicate-detection call sites instead.

## Design intent: shared projection instance

`Participant` and the mode session it wraps deliberately share **one**
projection instance, not two. The session's own `sendAndTrack` applies an
envelope to that instance locally as soon as its own `send()` call is
ACKed; the same instance is later handed replayed or live envelopes again via
`Participant.processMessage` as the transport streams (or re-streams, on
reconnect) session history. Both paths write into the same object by design —
this is deliberate topology, not an oversight being disclosed here.

One consequence of that choice: it is what makes a double-apply of the
initiator's own envelope *reachable* on this SDK's ordinary `Participant`
happy path — the local apply-on-ACK and the later replay-apply can both land
on the same instance for the same envelope. This is recorded here as a
statement of intent so the topology choice is visible and deliberate, not
implicit.

For comparison: `macp-sdk-python` gives the local apply-on-ACK path and the
stream-replay path two separate projection instances that never meet, so this
particular bug class cannot occur there by construction. Concretely, Python's
`Participant` never constructs a session-backed projection at all — its
session-driven and stream-driven projections are separate objects on separate
paths that never meet, whereas this SDK's `Participant` and its mode session
deliberately share the one instance described above. Neither SDK has
published a position on which topology is "correct" — this section states
this SDK's own design intent without asserting that Python's is wrong. The
point of stating both sides explicitly (Python documents the reciprocal
statement on its side) is that this asymmetry is a known, load-bearing
difference between the two SDKs, not something either could quietly refactor
away without noticing.

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
| `hasBlockingObjection(proposalId?)` | `boolean` | Has a **critical**-severity objection (only critical blocks per [RFC-MACP-0004 (Security)](https://github.com/multiagentcoordinationprotocol/multiagentcoordinationprotocol/blob/main/rfcs/RFC-MACP-0004-security.md)); omit the ID to check all proposals |
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
| `isImplicitlyAccepted(handoffId)` | `boolean` | Accepted by a runtime synthetic implicit accept ([RFC-MACP-0010 (Handoff Mode)](https://github.com/multiagentcoordinationprotocol/multiagentcoordinationprotocol/blob/main/rfcs/RFC-MACP-0010-handoff-mode.md) §5.1, proto ≥ 0.1.6) |
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
