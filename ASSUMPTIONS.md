# Assumptions

## commitmentHash / canonicalizeCommitmentPayload exported as public API in Phase 1

- **Plan:** `../multiagentcoordinationprotocol/plans/cross-repo/macp-sdk-typescript-rfc-macp-0013.md` (Phase 1)
- **Assumed:** the plan asked for "a separate exported helper so the vector runner can localize a failure" but didn't say whether that helper should be part of the SDK's public (barrel-exported) surface or an internal-only export.
- **Chose:** exported both `commitmentHash` and `canonicalizeCommitmentPayload` through the `src/index.ts` wildcard barrel (`export * from './commitment-hash';`), same as every other module in this SDK — there is no internal/external export split pattern elsewhere in the codebase to follow instead.
- **Alternatives:** keep `canonicalizeCommitmentPayload` internal (not re-exported from `src/commitment-hash.ts`, or re-exported but omitted from the barrel) until Phase 3 proves the algorithm against the RFC's spec vectors.
- **Blast radius if wrong:** `commitmentHash`'s output becomes public API under semver as of Phase 1's commit, before Phase 3 validates it against the RFC's canonical vectors. If Phase 3 finds a mismatch, fixing it changes every previously-computed hash — a protocol MINOR per the module's own docblock, and a breaking change to an already-published symbol if a release cuts between phases. Mitigated by accumulating Phases 1-3 into one PR (see PROGRESS.md) rather than shipping Phase 1 standalone, so Phase 3's vector proof landed before any release.
- **Resolution (ship gate):** `canonicalizeCommitmentPayload` was dropped from the `src/index.ts` barrel (kept as a named export from `src/commitment-hash.ts` only) to match `macp-sdk-python`'s public surface; `commitmentHash` itself remains barrel-exported, now proven against the RFC's spec vectors (Phase 3) before this PR merged. `release-please-config.json` also gained `"bump-minor-pre-major": true` so this ships as `0.7.0`, not `1.0.0`.
- **Resolution (reconcile, 2026-08-30):** confirmed as-is. `package.json`'s `exports` map (`"."` and `"./package.json"` only) already blocks external deep-imports of `canonicalizeCommitmentPayload` — it is more private than this entry's "reachable via deep import" caveat originally suggested; the ship-gate split is the strongest reversible starting point. See `DECISIONS.md` for full reasoning. Non-blocking follow-up tracked separately: no compile-time frozen-field-set exhaustiveness guard on `CommitmentPayload`.
- **Status:** CONFIRMED (2026-08-30) — see `DECISIONS.md`

## supersedes: null / non-object collides with a legitimate empty-string CommitmentRef

- **Plan:** `../multiagentcoordinationprotocol/plans/cross-repo/macp-sdk-typescript-rfc-macp-0013.md` (Phase 1, D3)
- **Assumed:** `commitmentHash()` must never throw (D3), including on malformed/out-of-contract input (e.g. a decoded or hand-built payload with `supersedes: null` or `supersedes: 'oops'` instead of a proper `CommitmentRef | undefined`).
- **Chose:** treat any non-`undefined` `supersedes` value as "present" and coerce its fields defensively (via the same string coercion used elsewhere), rather than distinguishing "malformed object" from "valid empty-string ref". Both currently canonicalize to `"supersedes":{"commitment_hash":"","session_id":""}` and therefore hash identically.
- **Alternatives:** treat non-object `supersedes` values as if they were `undefined` (omit the key) instead of coercing them into an empty-string ref — rejected because it would silently discard a payload the caller might expect to be validated/rejected outright.
- **Blast radius if wrong:** low in practice — this only bites hand-built or corrupted payloads that bypass typed construction, and Phase 2's `validateCommitmentHash` is the intended enforcement point for well-formed `CommitmentRef`s generally (it validates the hash _string_ shape, not the ref's structural well-formedness, so this specific collision is not fully closed by Phase 2 either — noted here for visibility, not as a Phase 2 requirement).
- **Resolution (reconcile, 2026-08-30):** changed, partially. `buildCommitmentPayload` (`src/envelope.ts`) previously used a truthy check (`if (input.supersedes)`) that silently dropped `supersedes: null` instead of validating/rejecting it — inconsistent with the hasher's `!== undefined` check and a real "same intent, different hash" trap between the builder path and the hasher path. Now checks `input.supersedes !== undefined`, then throws `MacpSessionError` if the value isn't a non-null object, before validating the hash string. See `DECISIONS.md` for full reasoning. **This fixes the builder/hasher divergence, not the collision this entry is titled after**: `commitmentHash()` itself (`src/commitment-hash.ts`, untouched by this fix, correctly so under D3 — it must never throw) still hashes `supersedes: null` identically to an explicit `supersedes: { sessionId: '', commitmentHash: '' }`. That collision remains open by design; it was never in scope for `buildCommitmentPayload` to close, since `commitmentHash()` accepts hand-built/decoded payloads that never pass through the builder at all.
- **Status:** CHANGED (2026-08-30) — builder/hasher divergence fixed; hasher-side empty-string collision remains open by design (D3) — see `DECISIONS.md`

## Semver marker for the first-vote-stands change (`feat!` over plain `feat`)
- **Plan:** `plans/rfc-0007-first-vote-stands.md`
- **Assumed:** Consumers may have depended on last-vote-wins, because we documented it as a feature — `docs/modes/quorum.md:91-107` is a "Vote Override" section that actively instructs users to change their vote, and two unit tests pinned the behavior deliberately.
- **Chose:** `feat(projections)!:` with an explicit `BREAKING CHANGE:` footer. A deep-analysis pass recommended plain `feat:` (not breaking) on the grounds that tallies change only for transcripts a conforming runtime cannot produce. Overridden: under `bump-minor-pre-major: true` both land `0.8.0`, so the `!` costs nothing in version arithmetic and buys a loud signal to exactly the people our own docs misled.
- **Alternatives:** plain `feat:` (recommended by the analysis, rejected as under-describing); `fix!:` (rejected — the anomalies surface is genuinely additive, so `feat` is the honest type).
- **Blast radius if wrong:** Cosmetic. An over-loud changelog entry on a 0.x package. Reversible by editing release notes; the published version number is identical either way.
- **Status:** UNCONFIRMED

## Accepted-only input is a caller-maintained invariant, not an enforced one
- **Plan:** `plans/rfc-0007-first-vote-stands.md`
- **Assumed:** A projection cannot verify that an envelope was accepted by the runtime — nothing on the wire marks it, and `Envelope` has no such field.
- **Chose:** State the precondition as a documented contract on all six `applyEnvelope` entry points, citing the canonical upstream statement (`schemas/conformance/README.md` "Notes:"), and prove the failure mode with an executable test. Do NOT add a runtime check or an `accepted` parameter.
- **Alternatives:** an `accepted: boolean` parameter on `applyEnvelope` (rejected — breaks every caller and every third-party `BaseProjection` subclass to encode something the caller already knows); a separate `applyAcceptedEnvelope` method (rejected — two entry points where one is correct, and the wrong one stays callable).
- **Blast radius if wrong:** A caller wiring a projection to raw captured traffic still corrupts its own state silently. The contract is documentation, not enforcement — that is the accepted limit of this approach.
- **Status:** UNCONFIRMED

## This SDK's Participant and its mode session share one projection instance
- **Plan:** `plans/rfc-0007-first-vote-stands.md`
- **Assumed:** The sharing is deliberate, not accidental — and it is what makes the initiator echo double-apply reachable here.
- **Chose:** Publish it as stated design intent in `docs/api/projections.md` rather than leaving it emergent. macp-sdk-python has two instances on two paths that never meet, so it is protected by accident; neither SDK had ever documented a position, meaning either could refactor into or out of the exposure without noticing.
- **Alternatives:** separate instances per path (rejected — a real design change, out of scope for #55, and it would silently change what `session.projection` reflects); say nothing (rejected — that is how this became a surprise in the first place).
- **Blast radius if wrong:** If the topology should actually differ, we have published intent we later reverse. Cheap to reverse in docs; the code change would be its own issue.
- **Status:** UNCONFIRMED

## Quorum keeps `requestId → sender` keying, not the runtime's sender-only keying
- **Plan:** `plans/rfc-0007-first-vote-stands.md` (Phase 5)
- **Assumed:** `macp-runtime` keys ballots by sender alone (`quorum.rs:42`); this SDK's `QuorumProjection` keys by `requestId → sender` (a nested map). The two agree on every conforming transcript today because RFC-MACP-0011 §5 rule 1 caps a session at one `ApprovalRequest`, so within a session there is only ever one `requestId` to key on.
- **Chose:** Keep the existing `requestId → sender` structure rather than flattening it to match the runtime. It is more defensive (scoped duplicate detection survives a hypothetical multi-`ApprovalRequest` session) and changing it is a real structural edit with no behavioral upside under the current cardinality rule.
- **Alternatives:** flatten to sender-only keying to mirror the runtime exactly (rejected — pure churn against a rule that forbids the divergent case; would also touch every call site in `quorum.ts` for zero observable behavior change).
- **Blast radius if wrong:** Divergence is only observable on a non-conforming multi-`ApprovalRequest` transcript, which RFC-MACP-0011 §5 rule 1 already forbids — so a conforming producer can never trigger it. Raised as a question, not a defect report, to `macp-runtime`: [macp-runtime#125](https://github.com/multiagentcoordinationprotocol/macp-runtime/issues/125).
- **Status:** UNCONFIRMED

## `seenMessageIds` is unbounded, deliberately
- **Plan:** `plans/rfc-0007-first-vote-stands.md` (Phase 2)
- **Assumed:** A `Set<string>` growing for the life of a projection instance is an acceptable memory tradeoff, not a leak that needs a cap or eviction policy.
- **Chose:** Leave it unbounded. The class already retains every full envelope (payload bytes included) in `transcript` for the same lifetime, so a set of id strings is strictly dominated by memory already held. `macp-runtime` itself keeps an unbounded per-message dedup set (`crates/macp-modes/src/step.rs:48,89`, field at `crates/macp-core/src/session.rs:69`), and sessions are TTL-bounded by protocol, so neither side accumulates unboundedly in practice.
- **Alternatives:** an LRU or size-capped set (rejected — adds a tuning knob and an eviction-correctness question for no observed problem, and would need to evict in the same order `transcript` never does, creating a second inconsistency); a periodic `clear()` hook (rejected — no safe point to call it exists without knowing the session is truly done).
- **Blast radius if wrong:** A long-lived projection instance across many sessions could grow this set without bound. Mitigated: projections are normally one-per-session and short-lived; a consumer holding one projection across many sessions is already accumulating an unbounded `transcript` too, so this is not the first or the worst unboundedness in the class.
- **Status:** UNCONFIRMED

## `ProjectionLike.anomalies` must stay optional
- **Plan:** `plans/rfc-0007-first-vote-stands.md` (Phase 3)
- **Assumed:** `src/agent/types.ts`'s `ProjectionLike` is a structural interface third parties can implement without extending any SDK base class, so tightening `anomalies` from optional to required would break any existing structural implementer that predates this feature.
- **Chose:** Keep `readonly anomalies?: readonly ProjectionAnomaly[]` optional, with a compile-guard in `src/agent/types.ts` (`_ProjectionLikeAnomaliesStaysOptional`) that fails the build if the member is ever tightened to required — it asserts `{ phase: string; transcript: Envelope[] }` (an object with no `anomalies` at all) still satisfies `ProjectionLike`, following the frozen-field-set precedent already established for `CommitmentPayload` (issue #47). The guard lives in `src/` deliberately — `tsconfig.json` only type-checks `src/**`, so an equivalent assertion in `tests/` compiles nothing and would silently stop enforcing anything.
- **Alternatives:** make it required now, since all six in-tree projections populate it (rejected — breaks any out-of-tree `ProjectionLike` implementer with no compile error to warn them, the same silent-breakage failure mode `has_blocking_objection`-style predicates were designed to avoid elsewhere in this plan).
- **Blast radius if wrong:** None observable without a maintainer manually deleting the `?` — the compile guard makes that change fail `npm run check` immediately, so the assumption is nearly self-enforcing. Because `src/agent/types.ts` is coverage-excluded, this change is invisible to `npm run test:coverage` by design (see `vitest.config.ts`'s comment) — the compile guard is the actual enforcement, not test coverage.
- **Status:** UNCONFIRMED
