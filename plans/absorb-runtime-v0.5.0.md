# Absorb macp-runtime v0.5.0 + macp-proto 0.1.3 → 0.1.6 — TypeScript SDK

**Status:** plan only (no code changed) · **Date:** 2026-07-06
**Repo:** `macp-sdk-typescript` @ `0.4.1` (main = `23f2553`)
**Upstream ground truth:**
- `../macp-runtime` `CHANGELOG.md` `[0.5.0] — 2026-07-05` and `docs/change-review-phases-a-e.md`
- `../multiagentcoordinationprotocol` (spec repo) @ `f603b22` — proto content for 0.1.4–0.1.6 and the canonical conformance pack
**Why this repo gates the ecosystem:** the playground and other consumers import
`@multiagentcoordinationprotocol/proto` transitively through this SDK's published
release. No consumer can see `max_suspend_ms`, `HandoffAccept.implicit`,
`ContributePayload`, or `ListSessions` pagination until this SDK ships a release
that (a) depends on proto ≥ 0.1.6 and (b) exposes the new fields through its
typed API.

---

## 1. Context — what this SDK is and where the affected surfaces live

All claims below were verified by reading the cited file:line in this working tree.

### 1.1 What the SDK provides

| Surface | Where | Notes |
|---|---|---|
| Low-level gRPC client (`MacpClient`, `MacpStream`) | `src/client.ts` | Dynamic proto loading via `@grpc/proto-loader` (`client.ts:230-244`); unary + duplex stream + 5 watch RPCs |
| Envelope/payload builders | `src/envelope.ts` | `buildSessionStartPayload` (`:29-51`), `buildCommitmentPayload` (`:70-98`), `buildEnvelope` (`:174-195`) |
| Protobuf registry | `src/proto-registry.ts` | `CORE_MAP`/`MODE_MAP` name→type mapping (`:5-49`), `PROTO_FILES` list (`:51-60`), encode/decode (`:113-125`) |
| Five mode-session helpers + `BaseSession` | `src/decision.ts`, `src/proposal.ts`, `src/task.ts`, `src/handoff.ts`, `src/quorum.ts`, `src/base-session.ts` | Each has its own `start()` calling `buildSessionStartPayload` (`decision.ts:91`, `proposal.ts:84`, `task.ts:80`, `handoff.ts:78`, `quorum.ts:78`, `base-session.ts:91`) and `commit()` echoing the session-bound versions |
| Client-side projections (read models) | `src/projections/{decision,proposal,task,handoff,quorum,base}.ts` | Pure state machines fed by `applyEnvelope(envelope, protoRegistry)` |
| Agent framework | `src/agent/` | `Participant` (`participant.ts:30-38` `InitiatorConfig.sessionStart`), `GrpcTransportAdapter` (`transports.ts:27-62`), `fromBootstrap` runner (`runner.ts:82-84` auth selection) |
| Auth | `src/auth.ts` | `Auth.devAgent` (`:36-38`) → `x-macp-agent-id` header (`metadataFromAuth`, `:89-95`); `Auth.bearer` (`:50-59`) |
| Watchers | `src/watchers.ts` | `ModeRegistryWatcher`, `RootsWatcher`, `SignalWatcher`, `PolicyWatcher`, `SessionLifecycleWatcher`; no reconnect logic, raw stream errors propagate (`:50-102`) |
| Policy builders | `src/policy.ts` | 5 typed builders → `PolicyDescriptor` with JSON `rules` string |
| Validation | `src/validation.ts` | session-id regexes (`:3-10`), vote/recommendation uppercase normalization (`:12-30`), session-start checks (`:90-102`) |
| Errors / retry | `src/errors.ts`, `src/retry.ts` | `MacpTransportError` carries **message only, no gRPC status code** (`errors.ts:10-15`; constructed at `client.ts:121-122` and `client.ts:277`); retryable codes = `RATE_LIMITED`,`INTERNAL_ERROR` (`retry.ts:17`) |

### 1.2 Bundled proto version — verified

- `package.json` dependency: `"@multiagentcoordinationprotocol/proto": "^0.1.3"`
- `package-lock.json:340-344`: resolved **0.1.3** from `npm.pkg.github.com`
- `node_modules/@multiagentcoordinationprotocol/proto/package.json`: `0.1.3`

`diff -r` of the bundled 0.1.3 `proto/` tree against the spec repo
`schemas/proto/` (which contains the 0.1.4–0.1.6 content; the spec checkout's
own package version strings are locally unbumped at 0.1.3 — depend on the
**published** 0.1.6, not a link) shows exactly four wire-visible changes and
one comment change. This satisfies inventory item 4 (nothing else changed):

1. `macp/modes/multi_round/v1/multi_round.proto` — **new file**, `message ContributePayload { string value = 1 }`
2. `macp/v1/core.proto` — `SessionStartPayload.max_suspend_ms = 10` (int64)
3. `macp/modes/handoff/v1/handoff.proto` — `HandoffAcceptPayload.implicit = 4` (bool; "Clients MUST NOT submit an accept with implicit = true; runtimes MUST reject it")
4. `macp/v1/core.proto` — `ListSessionsRequest.page_size = 1`, `.page_token = 2`; `ListSessionsResponse.next_page_token = 2`
5. (comment-only) `macp/v1/policy.proto` schema_version doc: "versions 1 and 2"

### 1.3 How conformance fixtures are consumed

- 13 fixtures **vendored** at `tests/conformance/*.json`; harness `tests/conformance/conformance.test.ts` auto-discovers all `.json` in that dir (`:105-108`) and replays the `expect === "accept"` prefix through the mode projection (multi_round is skipped, `:118`).
- Sync/drift tooling exists: `make sync-fixtures` (`Makefile:20-29`, one-way `cp` from `../multiagentcoordinationprotocol/schemas/conformance`) and `make verify-fixtures` (`Makefile:36-58`, byte-diff both directions).
- CI gate: `.github/workflows/conformance-fixtures.yml` checks out spec-repo **main** and runs `verify-fixtures` + the spec repo's `lint_fixtures.py` on every push/PR.
- **Current state: every one of the 13 vendored fixtures byte-differs from canonical** (verified by diff loop), because the spec repo's canonical pack (spec commit `cb0871c`, "conformance-pack-canonical") rewrote `payload_type` to fully-qualified proto names (`macp.modes.decision.v1.ProposalPayload`, `macp.v1.CommitmentPayload`), added `expected_error_code` on rejects, and added `schema.json`. **The `conformance-fixtures.yml` CI job is therefore red against spec main right now** — this is the most urgent slice, and it does not require the proto bump (see §4).
- The harness's `resolvePayloadType` (`conformance.test.ts:64-81`) parses **old shorthand** (`decision.Proposal`, bare `Commitment`) via `payloadType.split('.')` — fully-qualified names break it: `macp.modes.decision.v1.ProposalPayload` yields `modeShort='macp'`, `messageType='modes'` → wrong lookup → encode throws.

### 1.4 Release/publish mechanics

- Publish on GitHub release creation (`.github/workflows/publish.yml`): pulls proto from GitHub Packages, publishes SDK to npmjs (`CLAUDE.md:158-160`).
- `prepublishOnly` runs check + lint + format + unit tests + build (`package.json`).
- Deprecations already scheduled for removal in 0.5.0: `SessionLifecycleWatcher.events()`/`nextEvent()` (`watchers.ts:281,292`); `MacpClient._watchModeRegistry/_watchRoots/_watchSignals/_watchPolicies` were scheduled "for removal in 0.4.0" and still exist (`client.ts:536-580`).

---

## 2. Impact matrix

Every inventory item mapped. **Impact** = code/doc/test change required in this repo. Evidence is file:line in this repo unless prefixed `runtime:` or `spec:`.

| # | Change | Impact? | Evidence | Action (task ref §3) |
|---|--------|---------|----------|----------------------|
| 1 | `ContributePayload` proto (0.1.4) | **YES — code** | `src/proto-registry.ts:46-48` maps `Contribute → '__json__'` (JSON encode/decode); `:51-60` `PROTO_FILES` lacks `macp/modes/multi_round/v1/multi_round.proto`; tests pin JSON (`tests/unit/proto-registry.test.ts:54-55,155-165`); docs pin JSON (`docs/guides/architecture.md:143`, `docs/api/proto-registry.md:35,77`) | T3: proto-encode Contribute, decode proto-first with legacy-JSON fallback, update tests/docs |
| 2 | `SessionStartPayload.max_suspend_ms` (0.1.5) | **YES — code (additive)** | `src/envelope.ts:29-51` builder has no `maxSuspendMs`; `src/types.ts:119-129` interface lacks it; 6 `start()` call sites (`decision.ts:91`, `proposal.ts:84`, `task.ts:80`, `handoff.ts:78`, `quorum.ts:78`, `base-session.ts:91`); agent framework `participant.ts:30-38,387-399`, `runner.ts` bootstrap `session_start` | T4: thread `maxSuspendMs?` end-to-end; 0 = runtime default (7 days); runtime rejects negatives (runtime: CHANGELOG "Added") |
| 3a | `HandoffAccept.implicit` (0.1.6) | **YES — code** | `src/types.ts:289-293` `HandoffAcceptPayload` lacks `implicit`; `src/projections/handoff.ts:5-15` `HandoffRecord` can't represent it, `:55-63` accept case ignores it; `src/handoff.ts:125-135` `acceptHandoff` encodes the whole input object — if the field is added to the type naively, a caller could set it and the runtime **rejects** client-submitted `implicit=true` (spec: `handoff.proto:22-25`) | T5: decode-only surfacing; strip on send |
| 3b | `ListSessions` pagination (0.1.6) | **YES — code (additive)** | `src/client.ts:515-524` sends `{}` and returns bare array; no request/response types in `src/types.ts`; docs promise a complete enumeration (`docs/api/client.md:120-137`) | T6: `pageSize`/`pageToken` options + `nextPageToken` result; keep back-compat overload |
| 4 | No other wire-visible proto changes | **No impact — verified** | §1.2 `diff -r` output: only items 1–3 + a policy.proto comment | none (record diff in PR description) |
| 5 | Commitment `policy_version`: empty now matches bound policy | **LOW — docs/JSDoc only** | Session helpers echo the session-bound `policyVersion` at commit (`base-session.ts:113-140`, same pattern in all 5 modes) — correct under both old and new runtimes. Standalone `buildCommitmentPayload` defaults to `'policy.default'` (`envelope.ts:93`, `constants.ts:5`); explicit `''` already passes through (`??` doesn't coalesce `''`). runtime: change-review A3 | T9: document "empty matches bound"; do **not** change the default (older runtimes rejected empty; keeping the echo is compatible with both) |
| 6 | Passive-subscribe `after_sequence` contract | **YES — docs + small code** | `sendSubscribe` doc (`client.ts:143-156`) and `docs/api/client.md:240-258` already say exclusive/`seq > afterSequence`, but don't define the ordinal (1-based count of accepted envelopes) nor the compaction `FAILED_PRECONDITION`; `GrpcTransportAdapter` always subscribes from 0 (`transports.ts:44`) and its local `seq++` counter (`:51`) is exactly the delivered-envelope count the new contract makes meaningful; `FAILED_PRECONDITION` currently surfaces as a codeless `MacpTransportError` (`client.ts:121-122`). runtime: change-review B2 | T7 (error codes), T8 (docs + optional resume-from-last-seq) |
| 7 | Watch-stream lag = `RESOURCE_EXHAUSTED`; `WatchSignals` requires auth; 6 lifecycle states | **YES — code + docs** (enum: **no impact**) | `SessionLifecycleEventType` already has all 6 + UNSPECIFIED (`types.ts:342-349`); terminal set correct (`watchers.ts:20-24`). But: `watchSignals` metadata is optional (`client.ts:558-561`) and `SignalWatcher` can be built without auth (`watchers.ts:168-186`) — now dies `UNAUTHENTICATED`; stream errors carry no gRPC code, so consumers can't distinguish lag (`RESOURCE_EXHAUSTED` → reconnect) from auth failure (don't). runtime: CHANGELOG Security/Fixed, change-review B1/B6a | T7: add `code` to `MacpTransportError`, map in `MacpStream`/`serverStreamToAsyncGenerator`, document reconnect semantics; require auth for `watchSignals` |
| 8 | Task mode: external orchestrator allowed | **No SDK code blocks it — docs/tests only** | `task.ts:64-99` `start()` uses `validateSessionStart` (`validation.ts:90-102`) which never requires initiator ∈ participants; no `initiator`-membership check anywhere in `src/` (grep) | T10: doc note in `docs/modes/task.md`; integration test asserting external-orchestrator SessionStart accepted |
| 9 | Quorum policy `threshold`: approval bar; `percentage` = integer 0–100 | **YES — docs + test fix + validator** | `QuorumThreshold.value: number` with no scale doc (`policy.ts:46-49`, `docs/api/policy.md:57`); **unit test encodes the wrong scale** — `value: 0.75` for percentage (`tests/unit/policy.test.ts:169`) i.e. 0.75%, not 75%; runtime divides by 100 (runtime: `crates/macp-policy/src/evaluator.rs:700-704`, `:294-300`) and threshold is strictly the approval bar (runtime: change-review A2 fix 1) | T11 |
| 10 | Ext modes: `Commitment` must be terminal; promote→`macp.mode.*` rejected; empty `mode_version` binds descriptor version | **LOW — docs + optional client-side guard** | `registerExtMode` passes descriptor through (`client.ts:436-445`); existing integration test already declares `terminalMessageTypes: ['Commitment']` (`tests/integration/runtime.test.ts:1010-1018`); `BaseSession` sends `modeVersion: DEFAULT_MODE_VERSION ('1.0.0')` never `""` (`base-session.ts:49`). runtime: change-review A5 | T12: JSDoc + docs; optional client-side pre-validation of descriptors; integration tests for the three reject paths |
| 11 | `Initialize` caps: roots `list_changed:false`; `MACP_POLICIES_DIR` ⇒ `register_policy:false`, mutating policy RPCs `FAILED_PRECONDITION` | **LOW — error-code surfacing + docs** | `InitializeResult.capabilities` is opaque `Record<string, unknown>` (`types.ts:116`) — no type break; `registerPolicy`/`unregisterPolicy` reject with codeless `MacpTransportError` (`client.ts:471-491`, `:277`). runtime: change-review A8, E1 | T7 (code surfacing) + T9 (docs: check `capabilities.policyRegistry.registerPolicy` before registering; note `RootsWatcher` will never emit on this runtime) |
| 12 | JWT: HS256 off default allowlist | **No impact — verified; one doc line** | zero HS256 references in repo (`grep -rn HS256 docs/ examples/ src/ tests/ README.md` → empty); SDK is resolver-agnostic, JWTs travel as opaque bearers (`docs/guides/authentication.md:12`) | T9: one sentence in authentication.md pointing at `MACP_AUTH_JWT_ALGS` |
| 13 | Dev auth is bearer-only; no `x-macp-agent-id`; runtime refuses to start w/o auth unless `MACP_ALLOW_INSECURE=1` | **MAJOR — code + tests + docs + examples** | `Auth.devAgent` sets `agentId` → `metadataFromAuth` emits `x-macp-agent-id` (`auth.ts:36-38,89-95`); runtime v0.5.0 has **no** production code path reading that header — only tests asserting rejection (runtime: `crates/macp-auth/src/security.rs:627-655` `dev_sender_header_rejected_without_chain`/`ignored_when_not_allowed`; dev fallback authenticates any `Authorization: Bearer <value>` as sender `<value>`, `security.rs:95-103`). Blast radius here: `runner.ts:84` fallback; **all Tier-1 integration tests** (`tests/integration/runtime.test.ts:32-33`); 10 examples (grep list §3 T13); docs+README+CLAUDE.md still instruct `MACP_ALLOW_DEV_SENDER_HEADER=1` (`docs/guides/authentication.md:9`, `docs/guides/testing.md:139`, `README.md:420`, `CLAUDE.md:136`, `tests/integration/README.md:14,42`); unit tests pin the header (`tests/unit/auth.test.ts`, `tests/unit/client.test.ts:192-197`) | T13: reimplement `devAgent` over bearer; purge the env var from docs; note Docker image no longer bakes `MACP_ALLOW_INSECURE=1` |
| 14 | 36-char base64url session IDs containing `-` accepted | **No impact — verified** | `validation.ts:4` `BASE64URL_RE = /^[A-Za-z0-9_-]{22,}$/` already accepts `-` and 36 chars; add a regression test. (Divergence note: runtime now rejects *uppercase UUID-shaped* strings with no base64url fall-through (runtime: change-review A4) while the SDK regex would accept them — optional tightening, non-blocking) | T14: regression test; optional strictness note |
| 15 | Canonical conformance fixtures (FQ payload_type, `expected_error_code`, `schema.json`, UPPERCASE values) | **MAJOR — harness + fixtures; CI currently red** | §1.3. `resolvePayloadType` breaks on FQ names (`conformance.test.ts:64-81`); all 13 vendored fixtures drifted (diff loop verified); `schema.json` exists only canonically and `make sync-fixtures` will copy it into a dir the harness globs (`conformance.test.ts:105-108`) — must be skipped; UPPERCASE vote/recommendation already normalized (`validation.ts:12-30`) and canonical fixtures use `"APPROVE"` etc. (spec: `decision_happy_path.json`) | **T1 + T2 (first slice)** |
| 16 | Upcoming: runtime-emitted synthetic implicit accepts in histories | **YES — projection/docs prep** | `HandoffProjection` treats any `HandoffAccept` uniformly (`projections/handoff.ts:55-63`) — a synthetic accept (sender = target, `message_id = implicit-accept:<handoff_id>`, timestamp = computed deadline, `implicit=true`) will apply cleanly, but the `implicit` bit is dropped; no client code assumes message-id format or sender-observed-send (grep: no `messageId` logic in `src/projections/` or `src/agent/`). Note: v0.5.0 does **not** yet emit these (runtime: change-review A6 "What this is NOT"); the proto field + spec contract (spec commit `a97ceae`, RFC-0010 §5.1) land now, runtime timer later — decode-side support in this release future-proofs consumers | T5 (same task as 3a) |
| 17 | Runtime crates at 0.5.0; SDK release plan | **YES — release engineering** | SDK at 0.4.1 (`package.json`); deprecations already staged for a 0.5.0 window (§1.4) | T15: release **0.5.0**, CHANGELOG, proto `^0.1.6`, deprecation removals |

---

## 3. Work plan

Ordered tasks. Effort: S ≤ ½ day, M ≈ 1 day, L ≈ 2–3 days. Every task lists its
definition of done (DoD) and tests. "Live-runtime tests" means Tier-1 style
`npm run test:integration` against a macp-runtime **v0.5.0** Docker image
(`docker build -t macp-runtime ../macp-runtime/` — note: the image no longer
bakes `MACP_ALLOW_INSECURE=1`; every doc'd `docker run` must pass it).

### Slice A — unblock fixture CI (no proto bump needed)

**T1. Teach the conformance harness canonical payload_type names — S/M**
- `tests/conformance/conformance.test.ts`:
  - Replace `resolvePayloadType` (`:64-81`) with a FQ-name parser:
    - `macp.v1.<Name>Payload` / `macp.v1.CommitmentPayload` → core: `{ mode: '', messageType: stripSuffix(<Name>, 'Payload') }` (i.e. `macp.v1.CommitmentPayload` → `Commitment`, `macp.v1.SessionStartPayload` → `SessionStart`).
    - `macp.modes.<m>.v1.<Name>Payload` → `{ mode: modeMap[<m>], messageType: <Name> minus 'Payload' }` where `modeMap` = decision/proposal/task/handoff/quorum → `MODE_*` constants, `multi_round` → `MODE_MULTI_ROUND`.
    - Keep the legacy shorthand branch for one release **or** drop it (fixtures are synced atomically in T2; recommend dropping to prevent drift-back, mirroring the runtime's format-guard test, runtime: change-review C5).
  - Exclude `schema.json` from fixture discovery (`:105-108`): filter `f.endsWith('.json') && f !== 'schema.json'`.
  - Extend the `FixtureMessage` interface with optional `expected_error_code` (ignored by this in-process harness — it only replays the accepted prefix, `:125`).
  - Add a format-guard test: assert every fixture message's `payload_type` matches `^(macp\.v1\.[A-Za-z]+|macp\.modes\.[a-z_]+\.v\d+\.[A-Za-z]+Payload)$` (same pattern as spec `schema.json`), so shorthand can never return.
- Message-type mapping caveat: for decision/proposal both `Proposal` payloads exist; the FQ package disambiguates (this is exactly why the harness must key on package, not just name).
- **DoD:** `npm test` green with the **canonical** fixtures dropped in locally (`make sync-fixtures`); format-guard test red on any shorthand name.

**T2. Byte-sync vendored fixtures — S**
- `make sync-fixtures` (copies all canonical `*.json` incl. `schema.json`), commit.
- `make verify-fixtures` green both directions (schema.json is in the canonical dir, so bidirectional diff is satisfied).
- **DoD:** `.github/workflows/conformance-fixtures.yml` green against spec main; `npm test` green. Ship T1+T2 as one PR (harness change without fixtures, or fixtures without harness, are each independently red).
- Note: canonical `multi_round_*.json` use `macp.modes.multi_round.v1.ContributePayload`; the harness skips multi_round **before** payload resolution (`conformance.test.ts:118`), so this slice does not need the proto bump.

### Slice B — proto 0.1.6 + new wire surface

**T3. Bump proto to ^0.1.6; ContributePayload goes protobuf — M**
- `package.json`: `"@multiagentcoordinationprotocol/proto": "^0.1.6"`; `npm install`; commit lockfile (verify `package-lock.json` resolves 0.1.6 — the gate this whole plan exists for).
- `src/proto-registry.ts`:
  - `PROTO_FILES` += `'macp/modes/multi_round/v1/multi_round.proto'` (`:51-60`).
  - `MODE_MAP[MODE_MULTI_ROUND].Contribute = 'macp.modes.multi_round.v1.ContributePayload'` (replacing `'__json__'`, `:46-48`).
  - **Encode:** always protobuf (canonical; the runtime accepts it as of 0.5.0 and legacy JSON remains accepted server-side forever, so no compat flag is needed for sending — but see rollback note §5).
  - **Decode:** legacy histories replayed over `StreamSession` contain JSON `{"value":"..."}` bytes permanently. Make `decodeKnownPayload` for this mapping try **JSON first, then protobuf**, normalizing both to `{ value: string }`:
    - JSON-first mirrors the runtime's documented order (runtime: CHANGELOG "tried first, permanently") and is deterministic: proto-encoded `ContributePayload` bytes (`0x0A len …`) are never valid JSON, and JSON bytes beginning `{` (0x7b = field 15, wiretype 3) fail protobuf decode — the two formats are disjoint on their first byte.
    - Implementation: special-case the multi_round mapping in `decodeKnownPayload` (or introduce a `'__proto_with_json_fallback__'`-style entry) rather than changing generic `decodeMessage`.
- Update `tests/unit/proto-registry.test.ts:54-55,155-165` (JSON pins → proto roundtrip + JSON-fallback decode test with literal `Buffer.from('{"value":"x"}')`).
- Docs: `docs/guides/architecture.md:143`, `docs/api/proto-registry.md:35,77` (the `__json__` story changes; `__json__` mechanism itself stays for unknown ext modes).
- **DoD:** roundtrip unit tests; live-runtime test: register/drive an `ext.multi_round.v1` session sending a proto-encoded `Contribute` (payload accepted; converged commitment observed).

**T4. `maxSuspendMs` on session start — S/M (additive)**
- `src/types.ts:119-129`: `maxSuspendMs?: number | string` on `SessionStartPayload` (int64 → string with the registry's `longs: String` decode; accept `number` on input like `ttlMs`).
- `src/envelope.ts:29-51`: `maxSuspendMs?: number` input; emit `maxSuspendMs: input.maxSuspendMs ?? 0` (0 = runtime default, 7 days).
- Thread through every `start()` input: `base-session.ts:80-110`, `decision.ts`, `proposal.ts`, `task.ts`, `handoff.ts`, `quorum.ts` (the 5 sessions duplicate the builder call — same one-line addition in each).
- Agent framework: `participant.ts:30-38` `InitiatorConfig.sessionStart.maxSuspendMs?` + forward at `:391-398`; `runner.ts` bootstrap `session_start.max_suspend_ms`.
- Optional client-side validation: reject negatives in `validateSessionStart` (runtime rejects them at SessionStart; failing fast client-side matches the `ttlMs` precedent, `validation.ts:64-68`).
- Docs: `docs/api/envelope.md`, `docs/api/types.md`, `docs/api/sessions.md`, `docs/guides/*` where suspend/resume is described (0.4.0 additions).
- **DoD:** unit tests (builder default 0, explicit value, negative rejected); live-runtime test: start with small `maxSuspendMs`, suspend, wait past cap, observe `EXPIRED`.

**T5. `HandoffAccept.implicit` — decode-only + projection — M**
- `src/types.ts:289-293`: add `implicit?: boolean` with JSDoc: *runtime-emitted synthetic accepts only (RFC-0010 §5.1, `message_id` = `implicit-accept:<handoff_id>`); client-submitted accepts with `implicit=true` are rejected by the runtime.*
- `src/handoff.ts:125-135` `acceptHandoff`: strip `implicit` before encoding (`const { implicit: _ignored, ...rest } = input`) so a caller can never produce a runtime-rejected envelope; alternatively type the input as `Omit<HandoffAcceptPayload,'implicit'>` **and** strip (belt and braces — `toProtoPayload` passes through everything).
- `src/projections/handoff.ts`:
  - `HandoffRecord` (`:5-15`): add `implicit?: boolean`.
  - `HandoffAccept` case (`:55-63`): carry `record.implicit` through (decode materializes proto3 bool defaults to `false` — `proto-registry.ts:105-109` — so it's always a real boolean once proto 0.1.6 is loaded).
  - Optional convenience: `isImplicitlyAccepted(handoffId)`.
- Transcript note (item 16): projections already accept envelopes they didn't send (`applyEnvelope` is sender-agnostic); add a unit test replaying a **synthetic** accept envelope (sender = target participant, messageId `implicit-accept:h1`, `implicit: true`) and assert status/acceptedBy/implicit — this is the future-proofing for when the runtime timer ships.
- Docs: `docs/modes/handoff.md`, `docs/api/types.md:216`, `docs/api/projections.md`.
- **DoD:** unit tests above; live-runtime negative test: client-submitted `implicit=true` accept is NACKed.

**T6. `ListSessions` pagination — S/M (additive)**
- `src/client.ts:515-524`: options gain `pageSize?: number`, `pageToken?: string`; send `{ pageSize: … ?? 0, pageToken: … ?? '' }`.
- Return shape: keep `listSessions(options?): Promise<SessionMetadata[]>` for back-compat **and** add `listSessionsPage(options?): Promise<{ sessions: SessionMetadata[]; nextPageToken: string }>` (or overload; pick one and mirror python-sdk's choice if it lands first — cross-SDK parity is an explicit project convention, `policy.ts:4-5`).
  - Recommended: new method + make plain `listSessions()` auto-paginate (loop until `nextPageToken === ''`) so existing callers keep the "complete list" semantics the docs promise (`docs/api/client.md:122-124`) even after runtimes start capping page sizes.
- Docs: `docs/api/client.md:120-137` — document "MUST NOT assume completeness unless `nextPageToken` is empty" and that a stale token yields `INVALID_ARGUMENT`.
- **DoD:** unit tests (mock client: multi-page walk, empty-token terminal); live-runtime test: create >N sessions, walk pages with `pageSize: 2`, union equals unpaginated listing.

### Slice C — behavior/contract alignment (no proto dependency, but same release)

**T7. Surface gRPC status codes; watch-stream lag & auth — M**
- `src/errors.ts:10-15`: `MacpTransportError` gains `readonly code?: string` (gRPC status name, e.g. `RESOURCE_EXHAUSTED`, `FAILED_PRECONDITION`, `UNAUTHENTICATED`).
- Construction sites: `client.ts:277` (unary — `grpc.status[error.code]`), `client.ts:121-122` (`MacpStream` error handler), and `watchers.ts:50-102` `serverStreamToAsyncGenerator` (wrap raw `grpc.ServiceError` into coded `MacpTransportError` instead of rethrowing raw).
- `client.ts:558-561` `watchSignals`: runtime now requires auth — route through `requireAuth` like `openStream` (`:541-546`) so the failure is a clear client-side error instead of a stream `UNAUTHENTICATED`. **API-compat note: breaking** for anyone watching signals without configuring auth — they were about to break against runtime 0.5.0 anyway; CHANGELOG entry.
- Watcher docs + JSDoc: consumer lag terminates `WatchSignals`/`WatchSessions` with `RESOURCE_EXHAUSTED`; correct handling = reconnect (and for `SessionLifecycleWatcher`, re-sync via `listSessions`). Optionally add `watch(handler, { reconnect: true })` auto-reconnect for `RESOURCE_EXHAUSTED` only — keep small; do not auto-reconnect on auth errors.
- `src/retry.ts:17`: leave `retryableCodes` (ack codes) unchanged — `RESOURCE_EXHAUSTED` is a *stream* status, not an ack code; document the distinction where `RetryPolicy` is described.
- **DoD:** unit tests (coded errors from mocked ServiceError; watchSignals-without-auth throws); live-runtime tests: unauthenticated `WatchSignals` → coded `UNAUTHENTICATED`; passive-subscribe resume below a compacted base → coded `FAILED_PRECONDITION` (needs a compaction-inducing scenario: terminal session + restart, or accept skipping if runtime image can't compact deterministically in-test).

**T8. Passive-subscribe ordinal docs (+ optional resume helper) — S**
- Docs: `docs/api/client.md:240-258`, `docs/guides/streaming.md:65-71`, JSDoc `client.ts:143-147`: define the ordinal (1-based position among **accepted envelopes**, exclusive cursor, `0` = from start), state that clients derive ordinals by counting delivered envelopes, ordinals are stable across compaction/restart, and resume below the compacted base fails `FAILED_PRECONDITION`.
- Optional (recommended, S): `GrpcTransportAdapter` already counts delivered envelopes (`transports.ts:51`); expose `lastSequence` and use it to `sendSubscribe(sessionId, this.deliveredCount)` on an internal reconnect, turning the counter into a real resume cursor. If deferred, document that `seq` on `IncomingMessage` is exactly the server ordinal under the new contract.
- **DoD:** docs merged; if the resume helper ships: live-runtime test — consume k envelopes, reconnect with cursor k, assert no redelivery and no gap.

**T9. Contract-doc sweep: policy echo, policies-dir, initialize caps, HS256 — S**
- `envelope.ts:70-98` JSDoc + `docs/api/envelope.md`: empty `policyVersion` on a Commitment matches the session's bound policy (runtime ≥ 0.5.0); non-empty must equal the resolved id exactly; session helpers keep echoing the bound value (works on all runtime versions). No default change (matrix row 5).
- `docs/guides/policy.md`: with `MACP_POLICIES_DIR` the registry is read-only — `Initialize` advertises `policyRegistry.registerPolicy: false` and `registerPolicy`/`unregisterPolicy` fail `FAILED_PRECONDITION` (now inspectable via `MacpTransportError.code` from T7); recommend capability check before registering.
- `docs/guides/streaming.md` / roots docs: runtime advertises `roots.list_changed: false`; `RootsWatcher` yields nothing on this runtime.
- `docs/guides/authentication.md`: one line — runtime default JWT allowlist is RS256/ES256; HS256 needs `MACP_AUTH_JWT_ALGS=HS256`.
- **DoD:** docs merged; live-runtime test (policies-dir profile) optional — only if the test harness can start the runtime with a mounted policies dir; otherwise assert the capability flag shape from `initialize()` against a default runtime.

**T10. Task external orchestrator — S**
- No code change (matrix row 8). `docs/modes/task.md`: initiator need not be in `participants`; pool must contain ≥1 non-initiator assignee. Note handoff still requires initiator membership (delegated model).
- **DoD:** live-runtime test: `TaskSession.start()` with initiator ∉ participants → accepted; `requestTask` by initiator → accepted.

**T11. Quorum percentage semantics — S**
- `policy.ts:46-49` JSDoc on `QuorumThreshold`: `percentage` value is an **integer 0–100** (runtime computes `ceil(value/100 × participants)` as the approval bar); `threshold` is strictly the approval bar, not a participation quorum.
- Fix the misleading unit test `tests/unit/policy.test.ts:169` (`0.75` → `75`).
- Add validation in `buildQuorumPolicy` (`policy.ts:164-187`): `type === 'percentage'` ⇒ integer in [0,100], throw `MacpSessionError` otherwise. Same doc treatment for `VotingRules.quorum` percentage (`policy.ts:25`) which the runtime evaluates on the same 0–100 scale (runtime: `evaluator.rs:294-300`); leave `voting.threshold` (a 0–1 vote-share fraction, different field) untouched.
- `docs/api/policy.md:31,57` scale notes.
- **API-compat:** validation is technically breaking for anyone passing `0.75`-style values — they were silently getting a ~1% bar; call it out in CHANGELOG as a bug-surfacing change.
- **DoD:** unit tests (75 ok; 0.75 throws; 0/100 boundaries ok); live-runtime test: bind percentage-75 policy on 4 participants, 3 approvals commit, 2 denied `POLICY_DENIED`.

**T12. Extension-mode registration guardrails — S**
- `client.ts:436-469` JSDoc + `docs/api/client.md`: descriptors must declare `Commitment` among `terminalMessageTypes` (registration rejected otherwise); `promoteMode` into `macp.mode.*` rejected; SessionStart with empty `mode_version` binds the registered descriptor's version — a later Commitment echoing `""` is rejected, so ext-mode sessions built on `BaseSession` should either pass the descriptor's version or omit and echo the bound one (`BaseSession` already defaults to `'1.0.0'`, never `""` — `base-session.ts:49`; flag that the default must equal the registered descriptor's version or commit will mismatch).
- Optional client-side pre-validation in `registerExtMode`: throw if `terminalMessageTypes` lacks `'Commitment'` (fail fast, mirrors runtime).
- **DoD:** live-runtime tests: register without Commitment-terminal → rejected; promote to `macp.mode.x.v1` → rejected; ext session with empty mode_version then Commitment echoing bound version → accepted.

**T13. Dev-auth migration (bearer-only) — M, biggest blast radius**
- `src/auth.ts`:
  - Reimplement `Auth.devAgent(agentId)` to return `{ bearerToken: agentId, senderHint: agentId }` (dev fallback: any `Bearer <value>` authenticates as sender `<value>`; keeps every downstream callsite source-compatible). Update JSDoc (`:30-38`): requires `MACP_ALLOW_INSECURE=1` on the runtime; runtime refuses to start with no auth configured otherwise.
  - Decide the fate of `AuthConfig.agentId` + the `x-macp-agent-id` branch in `metadataFromAuth` (`:89-95`): **remove** (recommended for the 0.5.0 breaking window — the header authenticates against no supported runtime; `validateAuth`'s either/or check simplifies) or deprecate one release. Removal is cleaner: any user constructing `{agentId}` manually is already broken against runtime 0.5.0.
- `src/agent/runner.ts:84`: fallback branch keeps working via the reimplemented `devAgent`.
- Tests: rewrite `tests/unit/auth.test.ts` (devAgent → bearer metadata), `tests/unit/client.test.ts:192-197`; **integration suite**: `runtime.test.ts:1-33` header comment + `Auth.devAgent('alice'|'bob')` now produce `Authorization: Bearer alice|bob` — with the v0.5.0 dev fallback these map to senders `alice`/`bob`, so test bodies are unchanged; drop `-e MACP_ALLOW_DEV_SENDER_HEADER=1` from every runbook and keep `-e MACP_ALLOW_INSECURE=1` (now mandatory since the image doesn't bake it): `runtime.test.ts:4-7`, `tests/integration/README.md:14,42`, `docs/guides/testing.md:139`, `README.md:420`, `CLAUDE.md:130-145`, `docs/guides/authentication.md:7-24,213-216`.
- Examples: 10 files use `devAgent` (agent-policy-aware, decision-smoke, direct-agent-auth-initiator, direct-agent-auth-observer, handoff-smoke, policy-registration, proposal-smoke, quorum-smoke, task-smoke, watch-smoke) — behavior transparently becomes bearer; only comments mentioning the header need edits.
- **API-compat:** behavioral break (different header on the wire) — semver-minor under 0.x, prominent CHANGELOG "Changed"; anyone running an old runtime with the header path enabled must upgrade the runtime or pin SDK 0.4.x.
- **DoD:** unit metadata tests; full Tier-1 integration suite green against the v0.5.0 image started with only `MACP_ALLOW_INSECURE=1 MACP_MEMORY_ONLY=1`.

**T14. Session-id regression test — S**
- Unit test: `validateSessionId('<36-char base64url containing “-”>')` passes (e.g. a v4 UUID with one hex char uppercased does NOT qualify — use a genuinely non-UUID 36-char token). Optional: tighten to mirror runtime A4 (UUID-shaped ⇒ strict lowercase v4/v7, no fall-through) — deferred unless playground reports confusion; SDK-lenient/runtime-strict only delays an `INVALID_SESSION_ID` NACK to the server.
- **DoD:** test green; decision on tightening recorded in CHANGELOG or code comment.

### Slice D — release

**T15. Release 0.5.0 — S/M**
- `package.json` version `0.5.0`; `MacpClient.clientVersion` default (`client.ts:225`, currently `'0.3.0'` — stale even for 0.4.x; fix to track the package version, e.g. read from package.json or bump the literal).
- Execute the staged deprecation removals under the 0.5.0 window (or explicitly re-defer, one line each in CHANGELOG): `SessionLifecycleWatcher.events()`/`nextEvent()` (`watchers.ts:276-298`), `MacpClient._watch*` aliases (`client.ts:536-580`, were "scheduled for removal in 0.4.0").
- CHANGELOG (Keep-a-Changelog, matching 0.4.0's structure `CHANGELOG.md:7-57`): Added (maxSuspendMs, implicit decode, pagination, ContributePayload proto, `MacpTransportError.code`), Changed (devAgent bearer-only, watchSignals requires auth, quorum percentage validation, canonical fixtures/harness), Removed (deprecated aliases, `AuthConfig.agentId` if T13 removal chosen), plus "Requires macp-runtime ≥ 0.5.0 for: proto Contribute encode, empty policy echo, external task orchestrator" compatibility note.
- README: proto version references, docker runbook, pagination + maxSuspendMs snippets.
- Publish via GitHub release → `publish.yml` (needs `NPM_TOKEN` + GitHub Packages read as today, `CLAUDE.md:158-160`).
- **DoD:** `prepublishOnly` gate green; Tier-1 integration green vs v0.5.0 image; npm release visible; downstream (playground) can `npm i macp-sdk-typescript@0.5.0` and observe proto 0.1.6 in its lockfile.

---

## 4. Sequencing & shippable slices

```
PR-1 (Slice A: T1+T2)  fixture harness + byte-sync        ← unblocks red CI; NO proto bump needed; mergeable today
PR-2 (T3)              proto ^0.1.6 + ContributePayload   ← THE ecosystem gate; everything below depends on the lockfile bump
PR-3 (T4, T5, T6)      new field surface (start/handoff/pagination)   — additive, parallelizable after PR-2
PR-4 (T7, T8)          error codes + stream contracts     — independent of proto; can run parallel to PR-3
PR-5 (T13)             dev-auth migration + doc purge     — independent of proto; big diff, isolate for review
PR-6 (T9–T12, T14)     docs/tests/guardrails batch
PR-7 (T15)             version, CHANGELOG, removals, release
```

- Everything ships in **one release (0.5.0)**; the PR split is for reviewability and to get fixture CI green immediately.
- Order constraints: PR-2 before PR-3 (types need the new proto); PR-5 before the integration suite can pass against a v0.5.0 image (dev header is dead there), so in practice run PR-4/PR-5 early if CI moves to the new image first.
- Integration-test environment change lands with PR-5: new canonical runbook is
  `docker run -d -p 50051:50051 -e MACP_BIND_ADDR=0.0.0.0:50051 -e MACP_ALLOW_INSECURE=1 -e MACP_MEMORY_ONLY=1 macp-runtime` (v0.5.0 image).

## 5. Risks & rollback

| Risk | Mitigation / rollback |
|---|---|
| Proto 0.1.6 not actually published to GitHub Packages when work starts (local spec checkout still reads 0.1.3 in its package.json) | First step of PR-2 is `npm view @multiagentcoordinationprotocol/proto versions --registry=https://npm.pkg.github.com`; if 0.1.6 is missing, that's an upstream release blocker to escalate — do Slice A + T7/T13 meanwhile |
| Contribute proto-encode against an **old** runtime (<0.5.0) would be rejected/garbled | Documented floor: SDK 0.5.0 requires runtime ≥ 0.5.0 for multi_round send; decode path is version-proof (JSON-first fallback). Rollback: revert MODE_MAP entry to `'__json__'` — one line + tests |
| Harness FQ-name parser mismatch vs future fixture additions | Format-guard test pins the schema pattern; `verify-fixtures` CI keeps bytes in lockstep; the spec repo's `lint_fixtures.py` runs in the same workflow |
| devAgent silent behavior change breaks users on old runtimes | CHANGELOG "Changed" + README migration note; escape hatch: `Auth.bearer(token)` reproduces any custom setup; SDK 0.4.x remains published for old-runtime users |
| `listSessions` auto-pagination changes latency profile for huge registries | Auto-paginate loop is bounded by server page caps; `listSessionsPage` gives manual control; rollback = keep single-shot behavior and only add the paged method |
| Quorum percentage validation throws on previously-"working" (silently wrong) inputs | Bug-surfacing by design; error message names the 0–100 scale; documented in CHANGELOG |
| Watch reconnect helper could mask real outages | Scope reconnect to `RESOURCE_EXHAUSTED` only; cap retries; default off if in doubt (docs-only fallback for T7's reconnect portion) |

---

## Revision log

### Pass 1 — completeness (re-walked inventory + repo greps)
- Re-grepped `payload_type` / state enums / sequence tracking / auth metadata / policy builders / fixture files:
  - **Added** `retry.ts:17` analysis to T7 (stream status vs ack code distinction — `RESOURCE_EXHAUSTED` must not be conflated with ack-level retryables).
  - **Added** stale `clientVersion` default `'0.3.0'` (`client.ts:225`) to T15 — found while sweeping constants; it would otherwise ship a third stale release.
  - **Added** the six `buildSessionStartPayload` call sites list to T4 (initially only `BaseSession` was listed; the 5 concrete sessions predate it and duplicate the call — all six need `maxSuspendMs`).
  - **Added** `examples/watch-smoke.ts` to T13's example list and noted `SignalWatcher`-without-auth in T7 after grepping `watchSignals` construction paths.
  - **Confirmed no impact with evidence** (rows unchanged): lifecycle enum already 6-state (`types.ts:342-349`); vote/recommendation UPPERCASE already normalized (`validation.ts:12-30`); no HS256 anywhere; no initiator-membership validation in task path; no client-side messageId-format assumptions (grep of `src/projections/`, `src/agent/`).
- Checked for a MultiRoundSession helper: none exists (multi_round surface = ProtoRegistry + constants + fixtures + one integration ext-mode test) — T3 scope is correct without a new session class.

### Pass 2 — adversarial verification (re-read code behind every claim)
- **Lockfile re-verified:** `package-lock.json:340-344` pins proto **0.1.3** (GitHub Packages URL + integrity hash) — the "bundled proto version" claim stands on the lockfile, not just package.json's range.
- **Corrected:** an earlier draft said the runtime "still supports x-macp-agent-id behind config" based on `src/server.rs:849` instruction text. Re-reading `crates/macp-auth/src/security.rs` shows the only remaining occurrences are **tests asserting rejection** (`:627-655`) and there is no `MACP_ALLOW_DEV_SENDER_HEADER` reader anywhere in runtime `src/` — the server.rs instructions string is stale upstream text. T13 stays "bearer-only"; noted the stale string as a possible upstream doc bug (out of scope here).
- **Corrected scale claim in T11:** verified `evaluator.rs:700-704` computes `(value / 100.0) * total_participants` (ceiling) and `check_quorum` (`:294-300`) compares `(voters/participants)*100 >= value` — percentage is definitively 0–100; also confirmed `voting.threshold` (decision) is a *different* field on a 0–1 scale and deliberately excluded it from T11's validator.
- **Corrected item 16 framing:** runtime v0.5.0 does **not** emit synthetic accepts yet (change-review A6 explicitly: "What this is NOT… removes the forgeability without pretending to implement the timer"). The plan's projection work is decode-side future-proofing driven by proto 0.1.6 + spec commit `a97ceae`; the live-runtime test for a *synthetic* accept cannot be written yet — replaced with a unit-level synthetic-envelope replay + a live negative test (client `implicit=true` rejected).
- **Verified fixture-drift claim empirically:** diff loop over all 13 basenames returned DIFF for every file, and canonical-only `schema.json`; canonical `decision_reject_paths.json` carries `expected_error_code` (`:25,54,78`) and FQ payload types — the harness-breakage analysis (split-on-first-dot) matches the actual `resolvePayloadType` code, not an assumption.
- **Verified the JSON/proto first-byte disjointness** claim in T3 (JSON `{` = 0x7b = field 15/wiretype 3 group-start → protobuf decode error; proto `ContributePayload` starts 0x0A → not JSON) — the fallback order is safe in both directions.
- **Verified empty-string policy echo passthrough:** `input.policyVersion ?? DEFAULT_POLICY_VERSION` — `''` is not nullish, so callers can already send an empty echo; row 5's "no code change" holds.

### Pass 3 — executability (slices, DoD, riskiest item, rollback)
- Split the work into 7 mergeable PRs with explicit dependency edges (§4); confirmed Slice A needs **no proto bump** (multi_round fixtures are skipped before payload resolution, `conformance.test.ts:118`), so the red conformance CI can be fixed immediately and independently.
- Added a DoD + concrete test (unit and/or live-runtime v0.5.0) to every task; specified the exact docker runbook change (drop `MACP_ALLOW_DEV_SENDER_HEADER`, keep now-mandatory `MACP_ALLOW_INSECURE=1` since the 0.5.0 image no longer bakes it — runtime change-review B5/C4).
- **Expanded the riskiest item (T13 dev-auth)**: enumerated all 6 doc locations + 10 examples + 3 test files; chose "reimplement devAgent over bearer" specifically so every existing callsite stays source-compatible and the integration suite migrates by env-var deletion rather than test rewrites; made the `AuthConfig.agentId` removal an explicit decision point with a deprecation alternative.
- Added §5 rollback notes per risk, including the "proto 0.1.6 not yet on the registry" pre-flight check (`npm view`) — the one external dependency this plan cannot control.
- Added the T1 recommendation to drop shorthand parsing outright + format-guard test (mirrors runtime C5's drift-back guard) instead of carrying dual parsers forever.
