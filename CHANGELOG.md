# Changelog

All notable changes to `macp-sdk-typescript` are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the
project uses [Semantic Versioning](https://semver.org/).

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

### Changed

- **`cancelSession` now resolves to `SESSION_STATE_CANCELLED`** (was
  `SESSION_STATE_EXPIRED`). The terminal cancellation state is distinct from
  TTL/policy expiry so consumers can tell an explicit cancel apart from an
  expiry. No change to the `cancelSession` call signature.
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
