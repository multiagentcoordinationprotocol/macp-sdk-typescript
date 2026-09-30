# Changelog

All notable changes to `macp-sdk-typescript` are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the
project uses [Semantic Versioning](https://semver.org/).

## [0.11.0](https://github.com/multiagentcoordinationprotocol/macp-sdk-typescript/compare/v0.10.0...v0.11.0) (2026-09-22)


### ⚠ BREAKING CHANGES

* **policy:** buildDecisionPolicy's default schemaVersion is now 3 (was 2). A call that omits options.schemaVersion and uses a binding voting algorithm now fails closed on an empty decisive tally instead of silently sealing on zero ballots. Pass { schemaVersion: 1 } or { schemaVersion: 2 } explicitly to keep the old fail-open behavior.

### Features

* **policy:** flip Decision-policy schemaVersion default from 2 to 3 ([#97](https://github.com/multiagentcoordinationprotocol/macp-sdk-typescript/issues/97)) ([a82972a](https://github.com/multiagentcoordinationprotocol/macp-sdk-typescript/commit/a82972ae43550f4b953a6bd0e32bfb387fd25806))

## [Unreleased]

### ⚠ BREAKING CHANGES

* **policy:** `QuorumThreshold.type` no longer accepts `'weighted'`. The
  identifier was removed from the canonical `quorum-rules.schema.json`
  without ever having defined semantics (no weights vocabulary, no
  electorate rule) and every descriptor that used it was already refused by
  the runtime at `RegisterPolicy` — so this is a compile-time break for
  callers whose descriptors could never register in the first place.
  `buildQuorumPolicy` now also rejects it at runtime (for JS callers or an
  `as` cast), naming the reservation.
* **policy:** `buildQuorumPolicy(id, desc, {})` (an omitted `threshold`) now
  emits `threshold: { value: 1 }` instead of `value: 0`. A zero approval bar
  is trivially satisfied by any ballot set, so the canonical schema declares
  `value` with `exclusiveMinimum: 0`; `buildQuorumPolicy` now enforces that
  bound for every `threshold.type`, not just `'percentage'`, and rejects a
  non-integer or non-positive `value` with `MacpSessionError`.
* **policy:** `buildDecisionPolicy` now enforces the canonical
  `decision-rules.schema.json` voting constraints client-side, so calls that
  previously returned an unregistrable descriptor now throw `MacpSessionError`
  instead:
  - `voting.algorithm` must be one of the six canonical values.
  - `voting.threshold` must be `0 < threshold <= 1`.
  - `algorithm: 'majority'` requires `threshold >= 0.5` (inclusive — a `0.3`
    "majority" now throws).
  - `algorithm: 'supermajority'` **at its own default `threshold: 0.5`** now
    throws — this is the change most likely to break an existing idiomatic
    call (`buildDecisionPolicy(id, desc, { voting: { algorithm: 'supermajority' } })`);
    pass an explicit `threshold` above `0.5` (e.g. `0.67`).
  - `algorithm: 'weighted'` with no `weights` now throws.
  - `voting.weights`, if supplied at all, is now validated **unconditionally
    at every algorithm, not only `'weighted'`**: it must be non-empty, and
    every value must be `> 0`. `weights: { a: 0 }` now throws — a weight-0
    participant must be expressed by omission from the map.
* **policy:** all five `build*Policy` functions (`buildDecisionPolicy`,
  `buildQuorumPolicy`, `buildProposalPolicy`, `buildTaskPolicy`,
  `buildHandoffPolicy`) now throw `MacpSessionError` when
  `commitment.authority` is `'designated_role'` and `designatedRoles` is
  omitted or `[]`. An authority rule that names no one is unsatisfiable, and
  every canonical rule schema already refused this combination at
  `RegisterPolicy` — this call previously returned a descriptor the runtime
  would reject.
* **policy:** `buildDecisionPolicy`'s default `schemaVersion` is now `3`
  (was `2`), decided jointly with `macp-sdk-python`'s identical default flip
  (issue #85, see `macp-sdk-python`#65). Any `buildDecisionPolicy` call that
  omits `options.schemaVersion` and uses a binding voting algorithm
  (`majority`, `unanimous`, etc.) now fails closed on an empty decisive
  tally instead of silently sealing on zero ballots. Not retroactive — a
  stored policy always evaluates under its own recorded `schemaVersion`
  forever (RFC-MACP-0012 §8); this only changes what new callers who don't
  pass `schemaVersion` explicitly get going forward. Pass
  `{ schemaVersion: 1 }` or `{ schemaVersion: 2 }` explicitly to keep the
  old fail-open behavior.
* **auth:** `Auth.devAgent(agentId)` now also sets `expectedSender: agentId`
  on the returned `AuthConfig` (issue #124 item 4). The runtime's dev
  fallback already authenticates the gRPC connection as the bearer value
  (`agentId`) and unconditionally refuses a mismatched `sender` for dev
  credentials (`macp-runtime/src/server.rs:229-231`, no insecure/dev
  exemption) — this SDK now enforces the same guarantee client-side instead
  of surfacing the runtime's rejection late and confusingly. A bootstrap or
  caller whose `agent_id`/credential diverges from the `sender`/
  `participant_id` it actually sends now fails on the first typed
  handler-driven action (e.g. `acceptTask`, `vote`) with
  `MacpIdentityMismatchError`, instead of only failing server-side. The
  initiator's `SessionStart`/kickoff path is unaffected (it passes no
  explicit `sender`), as is the generic `actions.send` escape hatch (which
  still only fails server-side). A caller that genuinely needs one
  credential reused across multiple senders should use
  `Auth.bearer(token, senderHint)` (the legacy two-arg form) instead.

### Features

* **policy:** `buildDecisionPolicy` accepts a new fourth `options` argument,
  `{ schemaVersion?: 1 | 2 | 3 }`, to select a Decision policy's
  RFC-MACP-0012 empty-tally semantics — `3` (the default) fails closed
  (§4.1's "vacuous participation floor"); `1`/`2` fail open. An out-of-range
  value throws `MacpSessionError`.

### Bug Fixes

* **policy:** `buildQuorumPolicy`, `buildProposalPolicy`, `buildTaskPolicy`,
  and `buildHandoffPolicy` no longer emit `require_vote_quorum` into their
  `commitment` block. Only `decision-rules.schema.json`'s commitment object
  declares that key; the other four canonical rule schemas close with
  `additionalProperties: false` and do not, so the previous output was
  spec-nonconformant with no CI signal (today's runtime does not enforce
  `additionalProperties`, but a stricter or future validator would reject
  it). Passing `commitment.requireVoteQuorum` to these four builders is now
  silently dropped, matching its existing "ignored for other modes"
  documentation, rather than leaking an unrecognized key onto the wire.
  `buildDecisionPolicy` is unaffected.
* **projections:** all six `applyEnvelope` entry points now roll back
  `transcript` and the `message_id` redelivery-dedup set on a failed payload
  decode, instead of leaving a partial application in place. Previously, a
  failed decode still marked the envelope's `message_id` "seen," so a
  legitimate retry with a corrected payload was silently absorbed as a
  redelivery and the envelope's effect was lost forever.

### Added

- **All five mode sessions' `start()` now accept a per-call
  `auth?: AuthConfig`** (issue #108, part 2 of 2 — 4B), matching every other
  action method on these classes. Previously `start()` alone ignored a
  per-call `auth` on `DecisionSession`/`ProposalSession`/`TaskSession`/
  `HandoffSession`/`QuorumSession`, resolving the sender only against the
  session/client-level credential — so a caller passing a conflicting
  per-call `auth.expectedSender` never got the identity-mismatch guard
  (RFC-MACP-0004 §4) that every other method already enforced.
  `BaseSession.start()` already accepted and threaded a per-call `auth`
  before this change; see the `BaseSession.start()` validation entry below
  for what actually changed there in 4B.
- **`ProjectionAnomalyKind` gains two new, cross-SDK-agreed kinds:
  `duplicate_task_accept` and `settled_handoff`** (issue #126/#128;
  `macp-sdk-python` landed its half in PR #95). `TaskProjection` now records
  a `duplicate_task_accept` anomaly when a `TaskAccept` for a task it has a
  `TaskRequest` on file for is discarded because another task already holds
  the session's one assignee slot (RFC-MACP-0009 §5 rules 3/3a).
  `HandoffProjection` now records a `settled_handoff` anomaly when a
  `HandoffAccept`/`HandoffDecline` targets a `handoff_id` that already
  settled as accepted or declined (RFC-MACP-0010 §5 rule 4). Both new
  constants (`ANOMALY_DUPLICATE_TASK_ACCEPT`/`ANOMALY_SETTLED_HANDOFF`)
  export from the package root alongside the existing pair. A `TaskAccept`/
  `HandoffAccept`/`HandoffDecline` for an *unknown* `task_id`/`handoff_id`
  still records no anomaly — that determination (not caller misuse) is
  unchanged by this release. This is purely additive observability: no
  change to `phase`, `tasks`, or `handoffs` state itself at any of these
  sites. `DecisionProjection`'s late-`Vote`-after-`Commitment` site remains
  the one still-open, undecided case (per #128's own explicit scoping) —
  unaffected by this change.

### Changed

- **BREAKING (test-only surface): `_resetLoggingForTests` is no longer part
  of the package's public export surface.** (issue #109) It was reachable
  only via `src/index.ts`'s `export * from './logging'` wildcard; that line
  is now a named re-export listing `logger`, `configureLogging`, `LogLevel`,
  and `LogSink`. Because `package.json`'s `exports` map exposes only `"."`,
  this makes the helper unreachable from the published package entirely (no
  submodule fallback) — accepted, since it is test-only by name and by
  purpose, and `configureLogging` already covers every legitimate caller
  need.
- **`validateSessionId` now enforces the runtime's actual no-fall-through
  rule** (issue #108, part 1 of 2 — 4A). A UUID-**shaped** string (36 chars,
  hyphens at 8-13-18-23, hex-only) is now validated strictly as a lowercase
  v4/v7 UUID and never reinterpreted as base64url. An uppercase UUID, a
  lowercase v1 UUID, the nil UUID, or a UUID with a bad variant nibble now
  throws `MacpSessionError` client-side — all were already rejected by the
  runtime, so nothing that previously *worked* stops working, but a caller
  relying on the old, looser client-side check now gets the rejection
  earlier. Ports `macp-sdk-python`'s two-regex no-fall-through structure.
- **`DecisionSession.evaluate`/`raiseObjection`/`vote` now put the
  normalized (uppercased/lowercased) value on the wire, not the caller's
  original case** (issue #108, part 1 of 2 — 4A).
  `validateVote`/`validateRecommendation`/`validateSeverity` each return a
  normalized string; the three call sites in `decision.ts` previously
  discarded it. A consumer that string-compares an un-normalized value
  (e.g. `'approve'` instead of `'APPROVE'`) sees a different value on the
  wire; every in-repo projection already normalizes case itself, so no
  projection assertion is affected by this change.
- **An empty/missing `bearerToken` now throws `MacpSdkError`, not a bare
  `Error`** (issue #108, part 2 of 2 — 4B). `validateAuth` (and therefore
  `metadataFromAuth`, reached from every authenticated RPC) previously threw
  a plain `Error('bearerToken is required')`, which is not `instanceof
  MacpSdkError` — escaping the documented `catch (e) { if (e instanceof
  MacpSdkError) ... }` pattern from both SDKs' error-handling docs. Message
  text unchanged.
- **`BaseSession.start()` now runs the same full `validateSessionStart`
  check as the five built-in mode sessions, not a partial check** (issue
  #108, part 2 of 2 — 4B). Previously this documented ext-mode extension
  point validated only participant count and `maxSuspendMs`, so an empty
  `intent`, an empty/duplicate `participants` array, or an out-of-range
  `ttlMs` reached the wire unvalidated from a custom mode built on
  `BaseSession` — the weakest-validated mode in the SDK. All five now
  reject client-side, matching every built-in mode session.
- **BREAKING (narrows an exception type): `send()` now throws `MacpAckError`,
  not `MacpTransportError`, for a gRPC `ALREADY_EXISTS`/`FAILED_PRECONDITION`;
  same for `registerExtMode`/`unregisterExtMode`/`promoteMode`/
  `registerPolicy`/`unregisterPolicy` on `FAILED_PRECONDITION`** (issue #107).
  These are application-level rejections the runtime couldn't express as a
  normal Ack, not transport faults — `MacpAckError` (`failure.code`
  `'SESSION_ALREADY_EXISTS'` / `'POLICY_DENIED'` / `'FAILED_PRECONDITION'`
  respectively) is the correct, Python-parity model
  (`client.py:442-452`, `_map_registry_mutation_error` at `client.py:347-362`).
  Code today catching `MacpTransportError` around these calls for these
  specific statuses stops matching (`MacpAckError` extends `MacpSdkError`
  directly, not `MacpTransportError`); every other gRPC status on these RPCs,
  and every status on every other RPC, is unaffected. A knock-on effect on
  `retrySend()`: a `FAILED_PRECONDITION` `send()` was previously retried to
  exhaustion (no code filter on `MacpTransportError`) and surfaced as
  `MacpRetryError`; it now surfaces immediately as `MacpAckError`, since
  `POLICY_DENIED` is not in `DEFAULT_RETRY_POLICY.retryableCodes` — strictly
  more correct (neither condition is retryable) and no longer masks the real
  error behind a generic "retries exhausted."
- **`TaskProjection.isComplete(taskId)` renamed to `isCompleted(taskId)`**
  (issue #138, cross-SDK naming decision at
  multiagentcoordinationprotocol#135). Every other `is*` predicate in this
  SDK is past-participle (`isFailed`, `isAccepted`, `isTerminallyRejected`,
  `isDeclined`); `isComplete` was the outlier, and `macp-sdk-python` has
  always spelled this `is_completed`. The old name remains available — see
  `### Deprecated` below.

### Deprecated

- **`TaskProjection.isComplete(taskId)`** remains available as a
  `@deprecated` alias for `isCompleted(taskId)`; use `isCompleted()` instead.
  Scheduled for removal in 0.13.0.

### Fixed

- **`validateConfidence` now rejects `NaN`** (issue #108, part 1 of 2 — 4A).
  `NaN < 0` and `NaN > 1.0` are both `false`, so a bare range check silently
  accepted `NaN` — verified by execution before this fix. `±Infinity` was
  already rejected (incidentally); this also rejects it explicitly via
  `Number.isFinite`, matching this file's own `ttlMs`/`maxSuspendMs` idiom.
- **`commitmentHash`/`canonicalizeCommitmentPayload`: `supersedes: null` now
  hashes as absent, matching `macp-sdk-python`** (issue #105). `supersedes`
  is a proto3 message-typed field with only present/absent wire states;
  `null` is the idiomatic in-language representation of "absent" (e.g. under
  a `defaults: true` protobufjs/proto-loader decode, or a payload
  round-tripped through JSON). Previously `supersedes: null` took the
  *present* branch and hashed identically to an explicit
  `{ sessionId: '', commitmentHash: '' }`, producing a different digest than
  `macp-sdk-python` computes for the same logical commitment. The predicate
  changed from `p.supersedes !== undefined` to `p.supersedes != null`
  (deliberately loose — catches `null` and `undefined` only, so `0`, `''`,
  `false`, and other falsy-but-not-nullish values still take the present
  branch, unaffected). Not a protocol MINOR bump: the hashing `LABEL` and
  frozen field set are unchanged — this corrects a projection bug, not the
  algorithm. Any digest a caller already computed by feeding `null` was
  already wrong (Python never reproduced it), so there is no
  correct-value regression, but the fix is a security/audit-relevant
  behavior change on this SDK's own output.
- **`Participant` lifecycle: `SessionCancel` now reaches `onTerminal`, and
  teardown runs on every exit from `run()`, not just an explicit `stop()`**
  (issue #106). Three independent bugs in `src/agent/participant.ts`:
  - A runtime-issued `SessionCancel` never fired `onTerminal` at all — no
    built-in projection maps it to a terminal phase, so the phase-driven
    dispatch path had nothing to trigger on. `Participant` now recognizes
    `SessionCancel` directly as a fallback when the phase path doesn't fire,
    dispatching `{ state: 'Cancelled' }`. Against the current `macp-runtime`,
    this fallback's practical reach is `processEvent()` callers and
    cross-SDK parity with `macp-sdk-python`'s identical fallback — the
    streamed `run()` path never observes a `SessionCancel` at all today,
    since `cancel_session` stores it as `EntryKind::Internal` and
    `get_incoming_after` filters strictly to `EntryKind::Incoming`;
    cancellation surfaces via `session_lifecycle_bus`/`WatchSessions`
    instead.
  - `run()`'s `finally` only cleared an internal flag; the transport
    subscription and the cancel-callback HTTP listener were torn down
    exclusively inside `stop()`. A normal terminal exit, or a transport
    simply running out of messages, leaked both — a long-lived agent
    process running many sessions sequentially leaked one gRPC stream
    subscription and one listening TCP socket per completed session.
    Teardown now runs on every exit from `run()`.
  - `isStopped` computed `!running`, so it read `true` immediately after
    construction, before `run()` had ever been called. Fixed by tracking
    three independent states (`running` / `terminal` / `stopRequested`)
    instead of one flag — deliberately **not** a single latch copied from
    `macp-sdk-python`, because that would make a `Participant` single-use
    after any `stop()`, breaking this SDK's own documented and tested
    restart contract (issue #66): `stop()` mid-stream, then a second
    `run()` on the same instance, must resume rather than refuse. Only a
    genuinely *terminal* outcome is single-use; a `stop()`-only exit is a
    resumable pause.
- **`BaseProjection`'s rollback pop is now guarded by reference identity**
  (issue #106, item 4): it no longer unconditionally pops the last
  `transcript` entry on a failed decode. `BaseProjection` is documented
  subclassable API; a third-party subclass whose `applyMode` pushes its own
  entry onto `transcript` before throwing would previously have had that
  entry silently removed instead of the envelope actually under
  application — data corruption strictly worse than the bug the rollback
  itself fixes. Mirrors `macp-sdk-python`'s identical guard and its own
  documented trade-off in this exact scenario.
- **Identity fields on `Task`/`Handoff` actions now default to the resolved
  sender when omitted or empty, matching `macp-sdk-python`** (issue #108,
  part 2 of 2 — 4B): `TaskSession.acceptTask`/`rejectTask`/`completeTask`/
  `failTask`'s `assignee`, and `HandoffSession.acceptHandoff`'s `acceptedBy`/
  `decline`'s `declinedBy`, are now optional and fall back to the caller's
  authenticated identity (`input.field || resolvedSender` — `||`, not `??`,
  since an explicit empty string is also meant to fall back). Previously
  these were required fields passed straight through with no default, unlike
  the Python SDK (`task.py:299,323,391,430`, `handoff.py:247,271`).
- **`HandoffSession.addContext`'s `contentType` now defaults to
  `'application/octet-stream'` when omitted**, matching `macp-sdk-python`
  (`handoff.py:210`) (issue #108, part 2 of 2 — 4B). Previously `contentType`
  was a required field with no default.
- **`evaluationHandler`/`votingHandler` now validate a strategy's output
  before dispatching it** (issue #108, part 2 of 2 — 4B). Both previously
  passed a custom `EvaluationStrategy`/`VotingStrategy`'s raw
  `recommendation`/`confidence`/`vote` straight to `ctx.actions.*` with no
  validation, so a buggy strategy (an out-of-enum recommendation, a `NaN`
  confidence, an out-of-enum vote) failed later and less legibly, from
  inside the session rather than at the handler that produced the bad
  value. Both handlers now reuse this SDK's own `validateRecommendation`/
  `validateConfidence`/`validateVote` (throwing the documented
  `MacpSessionError`) and dispatch the validators' normalized return value.
- **`MacpStream`'s inline-error path was reading a shape a real decode never
  produces, silently dropping every inline application-level error** (issue
  #107). `StreamSessionResponse.response` is a proto3 `oneof`; under this
  file's own `@grpc/proto-loader` options (`oneofs: true`), the decoded
  object exposes the payload directly as `chunk.envelope`/`chunk.error`, with
  `chunk.response` set to the oneof's *arm name as a string* (`'envelope'` or
  `'error'`) — not a nested object. The old code read
  `chunk?.response?.error`, which indexes a string and is always `undefined`
  on every message that has ever crossed this stream; the corresponding unit
  test only ever passed because it emitted the same fictional
  `{ response: { error } }` shape by hand rather than a real decode. Fixed to
  read `chunk.error` directly, and each inline error is now also logged at
  `warn` (it previously produced no log line anywhere).
- **`TaskProjection.phase` no longer advances to `'Completed'`/`'Failed'` for
  a `TaskComplete`/`TaskFail` naming an unknown `task_id`** (issue #111).
  Both `this.phase` assignments sat outside the `if (task) { ... }` guard
  that already gated every other per-task field mutation in the same
  `applyMode` cases, so a message for a `task_id` this projection never saw
  a `TaskRequest` for still flipped the session-level `phase` to a terminal
  state even though no task actually completed or failed. Moved both
  assignments inside their sibling `if (task)` block, matching the guard
  already correct on `TaskAccept` (issue #71/#70) and on
  `HandoffProjection`'s analogous `phase` transitions.
- **Three more `phase`-transition-outside-guard sites, same bug shape as
  issue #111, found during that fix's verification** (issue #119):
  - `ProposalProjection`'s `Reject` case moved `this.phase =
    'TerminalRejected'` inside the sibling `if (proposal) { ... }` guard. A
    terminal `Reject` for an unknown `proposalId` no longer advances `phase`
    — which matters beyond bookkeeping, since `'TerminalRejected'` is a
    `TERMINAL_PHASES` member in `src/agent/participant.ts`, so the bug could
    end a live `Participant`'s `run()` loop for a session that never
    actually terminated.
  - `HandoffProjection`'s `HandoffContext` case moved its `phase` transition
    (`'OfferPending'` → `'ContextSharing'`) inside the sibling `if (handoff)
    { ... }` guard, matching `HandoffAccept`/`HandoffDecline`, which were
    already correct.
  - `DecisionProjection`'s `Vote` case gained a new existence guard (none
    existed before): `if (!this.proposals.has(record.proposalId)) break;`,
    per RFC-MACP-0007 §5 rule 2 ("`Evaluation`, `Objection`, and `Vote` MUST
    reference an existing `proposal_id`"). Previously a `Vote` for an unknown
    `proposalId` fabricated a `votes` `Map` entry and flipped `phase` to
    `'Voting'` — the fabricated entry also inflated `voteTotals()`'s and
    `majorityWinner()`'s denominators, able to flip a real proposal from
    winner to non-winner in a close tally.

  All three sites' `rejections`/audit-array-style writes remain unconditional
  (append-only logs, matching the runtime), so query methods reading from
  them (`isTerminallyRejected`, `hasTerminalRejection`) can still report
  `true` for an unknown id even though `phase` no longer moves — intentional,
  not a residual gap.
- **`QuorumProjection.setBallot` no longer fabricates a `ballots` entry for an
  unknown `request_id`** (issue #121, found during issue #119's plan-review
  sweep). RFC-MACP-0011 §5 rule 3 requires a ballot (`Approve`/`Reject`/
  `Abstain`) to reference the Session's accepted `request_id`; there was no
  check against `this.requests` before creating or extending a `ballots` Map
  entry, so an unfiltered/multi-session transcript could make
  `votedSenders()` and `approvalCount()`/`rejectionCount()`/
  `abstentionCount()` report on a `request_id` that was never opened, and a
  second such ballot from the same sender could fire a spurious
  `duplicate_ballot` anomaly against it. Unlike the three sites above, this
  bug never touched `phase` — `QuorumProjection.phase` is set only by
  `ApprovalRequest` and by `Commitment` handling in `BaseProjection` — so the
  fix is a single existence guard at the top of `setBallot`, with no phase
  component.
- **`ProtoRegistry.decodeMultiRoundContribute` no longer coerces a legacy-JSON
  `Contribute` payload's `value` to a string** (issue #124). Previously
  `String(parsed.value ?? '')` made an absent `value` key indistinguishable
  from a genuine empty string, and stringified any non-string JSON value
  (`123` decoded to `'123'`, `null` decoded to `''`). The legacy-JSON decode
  path now passes `parsed.value` through exactly as `JSON.parse` produced
  it — `undefined` stays `undefined`, `null` stays `null`, a number stays a
  number. The canonical-protobuf decode path is unaffected (its `value` is
  always a `string`, per the proto schema).
- **`majorityVoter` no longer counts `REVIEW` evaluations in its approval
  ratio** (issue #124). RFC-MACP-0007 §4 states `REVIEW` evaluations "do not
  block or approve a proposal; they serve as informational analysis records
  only" — a `REVIEW` was nonetheless lowering the ratio's denominator, so a
  proposal with one `APPROVE` and one `REVIEW` voted at ratio `0.5` instead
  of `1.0`. The ratio's denominator is now the `decisive` evaluations
  (everything except `REVIEW`, case-insensitive); `shouldVote` now returns
  `false` for an evaluation set of only `REVIEW`s (no decisive evaluation to
  vote on) instead of voting `REJECT` at ratio `0`. `BLOCK` and `REJECT`
  remain in the denominator — they are stances, not informational-only
  records.
- **`intent`, `instructions`, `action`, and `summary` no longer rejected when
  empty or omitted** (issue #124). `SessionStart.intent`,
  `TaskSession.requestTask`'s `instructions`, and
  `QuorumSession.requestApproval`'s `action`/`summary` are proto3 singular
  `string` fields — implicit presence means an omitted value and an explicit
  `''` serialize to identical bytes, so a client-side "required, non-empty"
  check rejected a payload the runtime would accept and no runtime-side check
  could ever distinguish. `intent` also has an explicit normative rule
  (RFC-MACP-0001 §7.1: a runtime "MUST NOT reject a SessionStart solely
  because intent is empty"). Every other `validateRequiredField` call
  site — `taskId`, `title`, `requestId`, `proposalId`, `option`, `handoffId`,
  `targetParticipant`, `modeVersion`, `configurationVersion` — is unaffected
  and still rejects an empty value.

### Documentation

- **Pagination memory caveat** (issue #109): `docs/api/client.md`'s
  `listSessions` and `listSessionsPage` entries now state plainly that while
  `macp-runtime` ≥ 0.7.0 (current: 0.8.3) implements real server-side
  pagination, `listSessions()` itself still accumulates every page into one
  in-memory array regardless of `pageSize` — callers who need bounded
  memory should call `listSessionsPage()` directly.
- **`ListRoots` wording** (issue #109): `docs/guides/streaming.md` no
  longer says the runtime "serves `ListRoots`," which reads as "returns
  real data" — reworded to state plainly that the runtime always returns an
  empty root list. `docs/api/client.md`'s `listRoots` entry gains the same
  statement, which it previously lacked entirely.

## [0.10.0](https://github.com/multiagentcoordinationprotocol/macp-sdk-typescript/compare/v0.9.0...v0.10.0) (2026-09-01)


### ⚠ BREAKING CHANGES

* `client.sendProgress()` now throws `MacpSessionError` when exactly one of `sessionId`/`mode` is supplied. Such calls used to succeed against a runtime that had the symmetric gap; as of macp-runtime PR #137 they are rejected with `INVALID_ENVELOPE`. Pass both fields for a session-scoped Progress, or neither for an ambient one.
* **projections:** `TaskProjection` assignee semantics changed twice. (1) The first-accept-wins guard is now per-session, not per-`task_id`: on a transcript with two `TaskRequest`s, only the first `TaskAccept` assigns — the second task keeps `assignee === undefined` and `status === 'requested'`, where it previously got its own assignee. A `TaskAccept` the guard discards also no longer sets `phase = 'InProgress'`. (2) `TaskAccept` is no longer sticky forever: a `TaskReject` from the active assignee clears `assignee` back to `undefined`, so code reading `getTask(id).assignee` after a reject now sees `undefined` (or the reassigned participant) rather than the participant who rejected.

### Bug Fixes

* **projections:** scope the Task assignee slot to the session and free it on reject ([#75](https://github.com/multiagentcoordinationprotocol/macp-sdk-typescript/issues/75)) ([f7841a9](https://github.com/multiagentcoordinationprotocol/macp-sdk-typescript/commit/f7841a96d120b3fc55effdfabf63a2d72f431081)), closes [#59](https://github.com/multiagentcoordinationprotocol/macp-sdk-typescript/issues/59) [#60](https://github.com/multiagentcoordinationprotocol/macp-sdk-typescript/issues/60) [#70](https://github.com/multiagentcoordinationprotocol/macp-sdk-typescript/issues/70) [#71](https://github.com/multiagentcoordinationprotocol/macp-sdk-typescript/issues/71)
* reject mixed ambient/session-scoped Progress envelopes ([#76](https://github.com/multiagentcoordinationprotocol/macp-sdk-typescript/issues/76)) ([a9e00e3](https://github.com/multiagentcoordinationprotocol/macp-sdk-typescript/commit/a9e00e370b7a4bf08d09190e8b75a12d221319f8))

## [0.9.0](https://github.com/multiagentcoordinationprotocol/macp-sdk-typescript/compare/v0.8.0...v0.9.0) (2026-09-01)


### ⚠ BREAKING CHANGES

* **projections:** ProposalProjection.isAccepted()/acceptedProposal(), TaskProjection's `assignee` field, and HandoffProjection's `status` field can now derive different values than before for a transcript containing the message sequences described above. Conforming transcripts (no superseded accept, no second TaskAccept/contradictory handoff accept-decline) are unaffected.

### Bug Fixes

* **agent:** don't count an envelope into the resume cursor until it's asked for again ([#72](https://github.com/multiagentcoordinationprotocol/macp-sdk-typescript/issues/72)) ([f1b7015](https://github.com/multiagentcoordinationprotocol/macp-sdk-typescript/commit/f1b70155cb3293bc7f36c0389cbf880359a01e58)), closes [#66](https://github.com/multiagentcoordinationprotocol/macp-sdk-typescript/issues/66)
* **agent:** resume GrpcTransportAdapter from its own cursor, and count distinct envelopes ([#65](https://github.com/multiagentcoordinationprotocol/macp-sdk-typescript/issues/65)) ([7535763](https://github.com/multiagentcoordinationprotocol/macp-sdk-typescript/commit/75357632351addde3a32a61b1200e823f2ef70da))
* **projections:** enforce cardinality rules issues [#59](https://github.com/multiagentcoordinationprotocol/macp-sdk-typescript/issues/59)/[#60](https://github.com/multiagentcoordinationprotocol/macp-sdk-typescript/issues/60) said didn't exist ([#68](https://github.com/multiagentcoordinationprotocol/macp-sdk-typescript/issues/68)) ([956d881](https://github.com/multiagentcoordinationprotocol/macp-sdk-typescript/commit/956d881e19591bcd9a04c6496bff07213d1ee6d3))

## [Unreleased]

### Fixed

- **BREAKING: four projection sites now enforce the cardinality rule their
  governing RFC section actually states, instead of last-write-wins.**
  Issues #59 and #60 argued that no cardinality/ordering site in the
  built-in projections had a normative rule behind it; a full re-read of the
  four mode RFCs plus RFC-MACP-0001 found governing rules for five of the
  ten sites they raised, three of which were shipped conformance
  violations:
  - `ProposalProjection` (breaking): a later `Accept` from a participant now
    supersedes their earlier one (RFC-MACP-0008 §5 rule 5, `:70`), so
    `isAccepted` and `acceptedProposal()` read the live acceptance set
    instead of raw accept history. Previously `acceptedProposal()` could
    return `undefined` after a legal re-accept, where the RFC's
    determinism clause (§7, `:89`) makes the accepted proposal unambiguous.
  - `TaskProjection` (breaking): the first accepted `TaskAccept` now wins —
    a later `TaskAccept` for the same task no longer overwrites `assignee`
    (RFC-MACP-0009 §5 rules 3/3a, `:69-71`). The policy-gated reassignment
    path (rule 3c) is intentionally not modelled yet; `TaskProjection` has
    no session-policy input.
  - `HandoffProjection` (breaking): a `handoff_id` now settles (`offered` →
    `accepted`/`declined`) exactly once — a later contradictory
    `HandoffAccept`/`HandoffDecline` for an already-settled `handoff_id`,
    or for a `handoff_id` that was never offered, is ignored in both
    directions and can no longer mutate `phase` (RFC-MACP-0010 §5 rule 2
    `:65`, rule 4 `:68`, §5.1(4) `:113-116`).
  - `DecisionProjection` (not breaking for conforming callers): `phase` no
    longer regresses out of `'Committed'` if a `Vote` is replayed after a
    `Commitment` — such a message cannot legally exist in accepted history
    under a conforming runtime (RFC-MACP-0001 §7.2 `:218`, §7.3
    `:240`/`:249`), but a caller violating the accepted-only contract no
    longer corrupts `phase` if it happens.

  `ProposalProjection.isAccepted()`/`acceptedProposal()`, `TaskProjection`'s
  `assignee` field, and `HandoffProjection`'s `status`/`phase` can now
  derive different values than before for a transcript containing the
  message sequences described above — existing callers reading those
  surfaces should treat this as a breaking change. Conforming transcripts
  (no superseded accept, no second `TaskAccept`, no contradictory or
  unknown-`handoff_id` handoff accept/decline) are unaffected.

  Three other sites raised by #59 (Decision `Evaluation`/`Objection`
  cardinality, Task `TaskUpdate` accumulation) were confirmed to be silent
  *coherently* and are unchanged. `TaskComplete`/`TaskFail` cardinality is
  genuinely ambiguous in RFC-MACP-0009 and is tracked as an upstream spec
  question rather than an SDK change.

### Changed

- **`GrpcTransportAdapter` resumes instead of replaying on a second `start()`.**
  The adapter now calls `sendSubscribe(sessionId, this.lastSequence)` instead of
  always subscribing from `0`, so a caller that `stop()`s and re-`start()`s a
  reused adapter — the only reachable "reconnect" in this SDK; there is no
  built-in retry loop — no longer replays the entire session history. Requires
  `macp-runtime` ≥ 0.5.0 for the `after_sequence` ordinal contract
  (RFC-MACP-0006 §3.2); older runtimes compared it inclusively against a raw
  log index. `lastSequence` itself is corrected in the same change to count
  **distinct** accepted envelopes (keyed on `message_id`) instead of raw
  delivery events — passing the old, uncorrected counter as a resume cursor
  would have silently skipped history on resume (RFC-MACP-0006 §3.2
  Redelivery). Anyone relying on a reused adapter's second `start()` to rebuild
  a *fresh* projection from full history will now see only the envelopes
  accepted since the first pass ended; open a new `GrpcTransportAdapter` (or a
  raw `MacpStream` with `sendSubscribe(sessionId, 0)`) for a full replay.
- `MacpStream.sendSubscribe`'s docblock no longer claims `IncomingMessage.seq`
  is the RFC-MACP-0006 ordinal — `seq` is a 0-based delivery index that
  advances on redelivery, unlike the ordinal.

## [0.8.0](https://github.com/multiagentcoordinationprotocol/macp-sdk-typescript/compare/v0.7.1...v0.8.0) (2026-08-31)


### ⚠ BREAKING CHANGES

* **projections:** DecisionProjection and QuorumProjection now keep the FIRST accepted Vote/ballot per sender (per proposal_id / request_id) and discard later ones, where they previously kept the last. For a transcript containing a genuine duplicate, derived state changes — most consequentially QuorumProjection.hasQuorum(), which could previously be fabricated by a single sender voting twice under requiredApprovals: 1. Conforming transcripts are unaffected. The discarded message is recorded on the new `anomalies` surface.

### Features

* **projections:** the first accepted vote or ballot stands ([#61](https://github.com/multiagentcoordinationprotocol/macp-sdk-typescript/issues/61)) ([ac407c3](https://github.com/multiagentcoordinationprotocol/macp-sdk-typescript/commit/ac407c3767e785b2a1cf82e1ae735a9ebf1138be))

## [0.7.1](https://github.com/multiagentcoordinationprotocol/macp-sdk-typescript/compare/v0.7.0...v0.7.1) (2026-08-31)


### Bug Fixes

* validate explicit empty-string sessionId, and freeze the commitment field set ([#52](https://github.com/multiagentcoordinationprotocol/macp-sdk-typescript/issues/52)) ([5e4dc25](https://github.com/multiagentcoordinationprotocol/macp-sdk-typescript/commit/5e4dc25389d948570afbd9653cfd52bc12e97150)), closes [#47](https://github.com/multiagentcoordinationprotocol/macp-sdk-typescript/issues/47) [#48](https://github.com/multiagentcoordinationprotocol/macp-sdk-typescript/issues/48)

## [0.7.0](https://github.com/multiagentcoordinationprotocol/macp-sdk-typescript/compare/v0.6.0...v0.7.0) (2026-08-30)


### ⚠ BREAKING CHANGES

* RFC-MACP-0013 canonical commitment hash ([#45](https://github.com/multiagentcoordinationprotocol/macp-sdk-typescript/issues/45))

### Features

* RFC-MACP-0013 canonical commitment hash ([#45](https://github.com/multiagentcoordinationprotocol/macp-sdk-typescript/issues/45)) ([2af3c51](https://github.com/multiagentcoordinationprotocol/macp-sdk-typescript/commit/2af3c5156e5831a4d2767175fd8f3154e34ec1af))


### Bug Fixes

* reject non-object supersedes instead of silently dropping it ([#49](https://github.com/multiagentcoordinationprotocol/macp-sdk-typescript/issues/49)) ([b4a68e3](https://github.com/multiagentcoordinationprotocol/macp-sdk-typescript/commit/b4a68e3f6059d968dabc3f6b43c5e8033fb4957c))

## [0.6.0](https://github.com/multiagentcoordinationprotocol/macp-sdk-typescript/compare/v0.5.0...v0.6.0) (2026-07-10)


### Features

* export package VERSION constant ([#37](https://github.com/multiagentcoordinationprotocol/macp-sdk-typescript/issues/37)) ([4ae5cda](https://github.com/multiagentcoordinationprotocol/macp-sdk-typescript/commit/4ae5cda23255b82339490f740a30ca0b7fee0d5a))

## [Unreleased]

### Changed

- **BREAKING: requires Node.js >= 20** (`engines.node`). Node 18 reached
  end-of-life in April 2025 and was never exercised in CI; the CI matrix now
  tests Node 20, 22, and 24.
- CI installs with `npm ci` against the committed lockfile (regenerated so all
  platform-specific optional binaries are recorded), with npm caching and a
  concurrency group that cancels superseded PR runs. The advisory-only
  `npm audit` job is replaced by Dependabot (weekly grouped npm and
  github-actions updates). All workflow actions are pinned by commit SHA.
- Publishing now runs the full `prepublishOnly` gate (check + lint +
  format:check + test + build) against the exact tree being published —
  the `--ignore-scripts` workaround is gone.
- Pull requests get a coverage summary comment from CI.

### Added

- Extensive unit coverage for previously integration-only surface: the
  `MacpStream` data path (envelope unwrapping, inline errors, timeouts,
  end-of-stream semantics), the entire `MacpClient` unary RPC surface and its
  metadata/deadline dispatch, the `watch*` stream factories, session
  `cancel`/`suspend`/`resume` delegation for all five modes, `BaseSession`/
  `BaseProjection` extension-point behavior, and the `Participant` run loop
  (terminal dispatch, cancel-callback wiring, initiator kickoff defaults).
  Coverage thresholds raised to lines 94 / branches 88 / functions 90 /
  statements 94.
- Conformance: `ext.multi_round.v1` fixtures now replay with real assertions
  (previously silently skipped); fixtures for unmapped modes fail loudly; and
  reject-path fixtures are contract-checked (canonical `expected_error_code`,
  resolvable `payload_type`) with explicit skip markers pointing at the
  runtime conformance oracle for the NACK behavior itself.

## [0.5.0] - 2026-07-06

Absorbs `macp-runtime` 0.5.0 and `@multiagentcoordinationprotocol/proto` 0.1.6
(resolves to ≥ 0.1.6; content identical through 0.1.8). Plan:
`plans/absorb-runtime-v0.5.0.md`.

**Requires `macp-runtime` ≥ 0.5.0** for: protobuf `Contribute` encoding, the
empty-`policy_version` commitment echo, the external task orchestrator, and the
bearer-only dev-auth flow (the runtime no longer reads `x-macp-agent-id`, and
refuses to start with no auth unless `MACP_ALLOW_INSECURE=1`). Pin `0.4.x` to
talk to an older runtime.

### Added

- **`SessionStartPayload.maxSuspendMs`** (proto ≥ 0.1.5) — per-session cap on
  cumulative suspended time before a `SUSPENDED` session `EXPIRE`s (RFC-MACP-0001
  §7.5). Threaded through `buildSessionStartPayload`, every mode session's
  `start()`, the `Participant` initiator config, and the bootstrap runner
  (`session_start.max_suspend_ms`). `0`/absent = runtime default (7 days);
  negatives are rejected client-side.
- **`HandoffAcceptPayload.implicit` decode support** (proto ≥ 0.1.6) — surfaced
  read-only on `HandoffRecord.implicit` and `HandoffProjection.isImplicitlyAccepted()`
  for the runtime-emitted synthetic accept (RFC-MACP-0010 §5.1). Client-submitted
  `implicit` is stripped before encoding so it can never reach the wire.
- **`ListSessions` pagination** (proto ≥ 0.1.6) — new
  `MacpClient.listSessionsPage({ pageSize, pageToken })` returning
  `{ sessions, nextPageToken }`; `listSessions()` now transparently auto-paginates
  so it still returns the complete listing.
- **`ext.multi_round.v1` `Contribute` uses canonical protobuf** — encodes as
  `ContributePayload`; decode tries legacy JSON (`{"value":"..."}`) first for
  byte-identical replay of pre-proto histories.
- **`MacpTransportError.code`** — carries the gRPC status name
  (`RESOURCE_EXHAUSTED`, `FAILED_PRECONDITION`, `UNAUTHENTICATED`, …) surfaced on
  unary calls, `MacpStream`, and watch streams, so consumers can distinguish
  watch-stream lag (reconnect) from auth failure (don't) and passive-subscribe
  resume below a compacted base.
- **`GrpcTransportAdapter.lastSequence`** — the 1-based accepted-envelope ordinal
  of the last delivered envelope, a resume cursor for `sendSubscribe`.

### Changed

- **Dev auth is bearer-only.** `Auth.devAgent(agentId)` now sends
  `Authorization: Bearer <agentId>` (was the `x-macp-agent-id` header). The
  runtime's dev fallback authenticates any bearer value as its sender, so
  behavior is transparent for existing callers — but the wire header changed.
  Integration/runbook: drop `MACP_ALLOW_DEV_SENDER_HEADER=1`, keep the now-mandatory
  `MACP_ALLOW_INSECURE=1`.
- **`MacpClient.watchSignals` requires auth** (runtime 0.5.0) — routed through
  `requireAuth`, so a missing credential fails fast client-side instead of as a
  stream `UNAUTHENTICATED`. Breaking for anyone watching signals without auth.
- **`buildQuorumPolicy` validates percentage thresholds.** A `percentage`
  `threshold.value` must be an integer 0–100 (the approval bar =
  `ceil(value/100 × participants)`); a fractional value like `0.75` (previously a
  silent ~1% bar) now throws `MacpSessionError`. Bug-surfacing by design.
- **`registerExtMode` pre-validates descriptors** — throws if
  `terminalMessageTypes` lacks `'Commitment'` (mirrors the runtime, which rejects
  such descriptors).
- **Canonical conformance fixtures + harness.** Vendored fixtures byte-synced to
  the spec canonical pack (fully-qualified `payload_type`, `expected_error_code`,
  `schema.json`); the harness parses FQ names only, with a format guard rejecting
  legacy shorthand.
- **`SessionStartPayload` bodies now emit `maxSuspendMs`** (`0` when unset).

### Removed

- **`AuthConfig.agentId`** and the `x-macp-agent-id` metadata path — no supported
  runtime reads the header. Use `Auth.devAgent` / `Auth.bearer`.
- **`SessionLifecycleWatcher.events()` / `nextEvent()`** — deprecated aliases;
  use `changes()` / `nextChange()`.
- **`MacpClient._watchModeRegistry` / `_watchRoots` / `_watchSignals` /
  `_watchPolicies`** — deprecated underscored aliases; use the un-prefixed
  `watch*` methods.

### Fixed

- `MacpClient.clientVersion` default was a stale `'0.3.0'`; now `'0.5.0'`.

## [0.4.0] - 2026-06-22

Adopts `@multiagentcoordinationprotocol/proto` 0.1.3 — session
suspend/resume, explicit cancellation, and cross-session commitment
supersession. Plan: `plans/macp-proto-0.1.3-suspend-cancel-supersede.md`.

### Added

- **`MacpClient.suspendSession(sessionId, reason, options?)` /
  `resumeSession(...)`** — control-plane RPCs for the new non-terminal
  `SUSPENDED` state. Suspension banks the session's remaining TTL and
  causes the runtime to reject messages until resume restores `OPEN`.
  Mirrors `cancelSession`'s generic-invoke pattern and NACK handling.
- **`suspend()` / `resume()` on every session helper** (`DecisionSession`,
  `ProposalSession`, `TaskSession`, `HandoffSession`, `QuorumSession`, and
  `BaseSession`) — delegate to the new client RPCs with `raiseOnNack: true`.
- **`SessionState` string-union type** (`src/types.ts`) — mirrors the proto
  `SessionState` enum and now types `Ack.sessionState` and
  `SessionMetadata.state`. Adds `SESSION_STATE_SUSPENDED` and
  `SESSION_STATE_CANCELLED`.
- **`CommitmentRef` type + `supersedes?` on `CommitmentPayload`** — supports
  cross-session commitment supersession (RFC-MACP-0001 §7.3).
  `buildCommitmentPayload({ ..., supersedes })` attaches it; absent by default.
- **Three new `SessionLifecycleEventType` values** — `EVENT_TYPE_SUSPENDED`,
  `EVENT_TYPE_RESUMED`, `EVENT_TYPE_CANCELLED`. `SessionLifecycleWatcher`
  surfaces them unchanged; exhaustive `switch (event.eventType)` blocks now
  type-check against the widened union.
- **`buildCommitmentRef({ sessionId, commitmentHash })`** in `src/envelope.ts`
  — convenience builder for a `CommitmentRef` to pass as
  `buildCommitmentPayload({ supersedes })`. Parity with python-sdk
  `build_commitment_ref`.
- **Session lifecycle predicates** in `src/watchers.ts` —
  `isSessionCreated` / `isSessionResolved` / `isSessionExpired` /
  `isSessionCancelled` / `isSessionSuspended` / `isSessionResumed` /
  `isTerminalSessionLifecycleEvent`, plus the
  `TERMINAL_SESSION_LIFECYCLE_EVENT_TYPES` constant. They accept either a
  `SessionLifecycleEvent` or a bare `SessionLifecycleEventType`, mirror
  python-sdk's `SessionLifecycle` properties, and treat `RESOLVED` / `EXPIRED`
  / `CANCELLED` as terminal.

### Changed

- **`cancelSession` now resolves to `SESSION_STATE_CANCELLED`** (was
  `SESSION_STATE_EXPIRED`). The terminal cancellation state is distinct from
  TTL/policy expiry so consumers can tell an explicit cancel apart from an
  expiry. No change to the `cancelSession` call signature.
- **Policy `require_vote_quorum` parity**: `serializeCommitment` now emits
  `require_vote_quorum` for **every** mode's commitment block (quorum /
  proposal / task / handoff), not just decision, so policy JSON is
  byte-identical to python-sdk's `_commitment_dict` across all modes.
- **Dependency**: bumped `@multiagentcoordinationprotocol/proto` to `^0.1.3`.

## [0.3.0] - 2026-04-21

Parity release — brings TypeScript SDK to full feature parity with
`macp-sdk-python` 0.3.0. Plan: `plans/sdk-parity-plan.md`.

### Added

- **Cancel-callback server** (Gap B, RFC-0001 §7.2 Option A):
  `startCancelCallbackServer({ host, port, path, onCancel })` returns a
  handle backed by Node's `http` module; `Participant` starts the server
  automatically when `ParticipantConfig.cancelCallback` is set and closes
  it on `stop()`. `fromBootstrap()` wires the new `cancel_callback`
  field in the bootstrap JSON. Exports:
  `startCancelCallbackServer`, `CancelCallbackServer`, `CancelHandler`.
- **Function-wrapped voting and commitment strategies** (Gap C):
  `functionVoter(shouldVote, decideVote)` and
  `functionCommitter(shouldCommit, decideCommitment)` in
  `src/agent/strategies.ts` — the low-friction way to plug a custom rule
  into a `Participant` without a class.
- **Standalone signal and progress builders** (Gap D):
  `buildSignalPayload(input)` and `buildProgressPayload(input)` in
  `src/envelope.ts`. `MacpClient.sendSignal` / `sendProgress` now use
  the shared builders internally.
- **`serializeMessage(msg)` helper** (Gap N) — parity with
  `python-sdk envelope.serialize_message`; dispatches to
  `serializeBinary()` / `toBinary()` / `finish()` on the passed
  protobuf message.
- **Structured logger** (Gap G): `src/logging.ts` exports `logger` with
  `error`/`warn`/`info`/`debug` level methods and `configureLogging({ level, sink })`.
  Reads `MACP_LOG_LEVEL` on module init (default `warn`). The two
  remaining `console.*` callsites in `src/agent/participant.ts` and
  `src/handoff.ts` now route through the structured logger.
- **`AckFailure` shape** (Gap I): structured NACK record exported from
  `src/errors.ts`. Populated on `MacpAckError.failure` from both
  `ack.error.details` and gRPC trailing metadata.
- **`BaseSession` / `BaseProjection`** (Gap J): abstract extension
  points exported from `src/base-session.ts` and `src/projections/base.ts`
  for custom mode helpers (modes registered via `registerExtMode`).
  Mirrors `python-sdk`'s `BaseSession` / `BaseProjection`.
- **Named policy rule interfaces** (Gap K): `VotingRules`,
  `ObjectionHandlingRules`, `EvaluationRules`, `CommitmentRules`,
  `QuorumThreshold`, `AbstentionRules`, `ProposalAcceptanceRules`,
  `CounterProposalRules`, `RejectionRules`, `TaskAssignmentRules`,
  `TaskCompletionRules`, `HandoffAcceptanceRules` now exported as
  first-class interfaces matching `macp-sdk-python` exports.
- **`STANDARD_MODES` tuple** (Gap L) in `src/constants.ts`.
- **Parity examples** (Gap M): `examples/policy-registration.ts`,
  `examples/agent-policy-aware.ts`, `examples/direct-agent-auth-initiator.ts`,
  `examples/direct-agent-auth-observer.ts`.

### Changed

- **Error-code constants renamed** (Gap F, breaking): dropped the
  `ERR_` prefix so TS constants match the on-the-wire strings and the
  `macp-sdk-python` exports. Rename table —
  `ERR_UNSUPPORTED_PROTOCOL_VERSION` → `UNSUPPORTED_PROTOCOL_VERSION`,
  `ERR_INVALID_ENVELOPE` → `INVALID_ENVELOPE`,
  `ERR_SESSION_NOT_FOUND` → `SESSION_NOT_FOUND`,
  `ERR_SESSION_NOT_OPEN` → `SESSION_NOT_OPEN`,
  `ERR_SESSION_ALREADY_EXISTS` → `SESSION_ALREADY_EXISTS`,
  `ERR_MODE_NOT_SUPPORTED` → `MODE_NOT_SUPPORTED`,
  `ERR_FORBIDDEN` → `FORBIDDEN`,
  `ERR_UNAUTHENTICATED` → `UNAUTHENTICATED`,
  `ERR_DUPLICATE_MESSAGE` → `DUPLICATE_MESSAGE`,
  `ERR_PAYLOAD_TOO_LARGE` → `PAYLOAD_TOO_LARGE`,
  `ERR_RATE_LIMITED` → `RATE_LIMITED`,
  `ERR_INTERNAL_ERROR` → `INTERNAL_ERROR`,
  `ERR_POLICY_DENIED` → `POLICY_DENIED`,
  `ERR_INVALID_SESSION_ID` → `INVALID_SESSION_ID`,
  `ERR_UNKNOWN_POLICY_VERSION` → `UNKNOWN_POLICY_VERSION`,
  `ERR_INVALID_POLICY_DEFINITION` → `INVALID_POLICY_DEFINITION`.
- `MacpClient.clientVersion` default now `0.3.0`.

### Removed

- **`HandoffSession.sendContext()`** (Gap A, breaking): the deprecated
  alias (warning first emitted in 0.2.3) has been removed. Use
  `HandoffSession.addContext()`.
- **`MacpAckError.reasons` getter** (breaking): use
  `MacpAckError.failure.reasons` instead. `.failure` is the canonical
  structured NACK record and matches `macp-sdk-python`'s
  `MacpAckError.failure`.
- **Mode-prefixed policy rule type aliases** (breaking): the
  `CommitmentRulesInput`, `DecisionVotingRules`,
  `DecisionObjectionHandling`, `DecisionEvaluationRules`, and
  `DecisionCommitmentRules` type aliases have been removed. Use the
  unprefixed names (`CommitmentRules`, `VotingRules`,
  `ObjectionHandlingRules`, `EvaluationRules`) introduced in Gap K.

## [0.2.3] - 2026-04-21

### Added
- `MacpStream.sendSubscribe(sessionId, afterSequence?)` — subscribe-only stream
  frame (RFC-MACP-0006-A1). The runtime replays accepted envelopes from the
  cursor before switching to live broadcast, so non-initiator agents observe
  `SessionStart` and earlier mode envelopes regardless of join order.
- `GrpcTransportAdapter` now sends a subscribe frame automatically on start so
  `Participant`-based agents pick up history without bespoke wiring.
- Unit coverage for `MacpStream.sendSubscribe` (default cursor, custom cursor,
  closed-stream rejection, write-error propagation, sequential resubscribe) and
  `GrpcTransportAdapter` (subscribe ordering, empty-stream subscribe, auth
  pass-through to `openStream`).
- Integration tests for late-subscriber replay and future-cursor skip
  (`tests/integration/runtime.test.ts`).
- `InitiatorConfig.sessionStart` now accepts `contextId` and `extensions`, and
  `Participant.emitInitiatorEnvelopes()` forwards both to the mode-session
  `start()` call (SDK-TS-1). `fromBootstrap()` decodes `context_id` plus a
  JSON-native `extensions` map from the bootstrap file — each value is
  serialised as UTF-8 JSON into the `Record<string, Buffer>` shape the
  envelope requires; pre-encoded `Buffer` / `Uint8Array` values pass through
  unchanged.
- Documented `MacpClient.listSessions()` (parity with the python-sdk SDK-PY-2
  gap) and `SessionLifecycleWatcher` (parity with python-sdk SDK-PY-3). Both
  were already implemented — this release adds the API reference, a
  `docs/guides/streaming.md` section, unit coverage for `listSessions`, and
  integration tests that exercise enumeration + a `CREATED` lifecycle event
  round-trip against a live runtime.
- Warn-once migration hint when the deprecated `HandoffSession.sendContext()`
  alias is invoked. Scheduled for removal in `0.4.0`; use `addContext()`.
- `docs/api/sessions.md` now documents the identity-guard contract.
- `docs/guides/architecture.md` rewritten to reflect the three-layer design
  (transport / session helpers / agent framework).

### Changed
- Integration tests updated to match the proto field renames that landed in
  `@multiagentcoordinationprotocol/proto@0.1.x`: `Evaluation.analysis` →
  `reason`, `Proposal.description` → `summary`, `TaskRequest.assignee` →
  `requestedAssignee` (Task accept/update/complete/fail/reject now carry an
  `assignee` field), `TaskUpdate.progress` is required, `HandoffContext.data`
  → `context` (+ `contentType`), `HandoffAccept.acceptedBy` and
  `HandoffDecline.declinedBy` are now required.

### Deprecated
- `HandoffSession.sendContext()` remains available as an alias but emits a
  one-shot `console.warn`. Use `HandoffSession.addContext()` instead.

## [0.2.0] — 2026-04-15

Direct-agent authentication (RFC-MACP-0004 §4) hardening. The SDK can now
represent and enforce the authenticated sender identity client-side, so agents
fail fast on identity bugs instead of discovering them as runtime NACKs. See
[`ui-console/plans/direct-agent-auth.md`](../ui-console/plans/direct-agent-auth.md)
for the cross-repo plan.

### Added
- `MacpIdentityMismatchError` (exported from the package root). Raised when an
  explicit `sender` passed to any mode helper or to
  `client.sendSignal`/`client.sendProgress` conflicts with
  `auth.expectedSender`.
- `Auth.bearer(token, { expectedSender })` — structured second argument that
  binds the authenticated identity. The legacy string form
  (`Auth.bearer(token, 'alice')`) still works and preserves pre-0.2 behaviour
  (no guard).
- `AuthConfig.expectedSender` field.
- `assertSenderMatchesIdentity(auth, sender)` exported helper.
- `allowInsecure?: boolean` option on `MacpClient` — required when
  `secure: false` is passed; constructor throws otherwise (RFC-MACP-0006 §3).
- Agent runner (`fromBootstrap`) now honours a bootstrap `allow_insecure`
  flag and binds `expectedSender` to `participant_id` when `auth_token` is
  present.
- `HandoffSession.addContext()` as the canonical name for the
  `HandoffContext` message.
- Public `newSessionId()` export — already re-exported via `envelope.ts` but
  now pinned by a test so it stays visible at the package root.
- Integration test block *Direct-agent auth (pre-allocated sessionId + Bearer)*
  that exercises the full initiator loop (SessionStart → stream → Proposal) and
  a second Bearer client for non-initiator Evaluate + Vote.
- `tests/integration/README.md` documenting the runtime + env-var matrix for
  the new test block.

### Changed
- `MacpClient.secure` now defaults to `true`. Insecure connections require
  `secure: false` *and* `allowInsecure: true` at construction time.
- All example smokes (`examples/*.ts`) pass `allowInsecure: true` alongside
  `secure: false` so local dev continues to work against
  `MACP_ALLOW_INSECURE=1` runtimes.
- `clientVersion` default bumped to `'0.2.0'`.
- `authSender(auth)` now prefers `expectedSender` over `senderHint` /
  `agentId` when resolving the envelope sender fallback.

### Deprecated
- `HandoffSession.sendContext()` renamed to `addContext()`. The old name
  remains as a backwards-compatible alias.

## [0.1.0] — 2026-02-?? (historical)

Initial release. `MacpClient`, five mode-session helpers
(`DecisionSession`, `ProposalSession`, `TaskSession`, `HandoffSession`,
`QuorumSession`), local projections per mode, duplex streaming, policy
builders, and the `Participant`/`Dispatcher`/`Strategies` agent framework.
