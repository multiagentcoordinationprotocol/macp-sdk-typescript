# Decisions

Durable record of `/reconcile` outcomes — one entry per `ASSUMPTIONS.md` entry resolved.
`/ship` and any later reconciliation pass read this file instead of replaying the
conversation that produced it.

## 2026-08-30 — commitmentHash / canonicalizeCommitmentPayload exported as public API

- **Assumption:** `ASSUMPTIONS.md` — "commitmentHash / canonicalizeCommitmentPayload exported as public API in Phase 1" (originally logged during Phase 1 of the RFC-MACP-0013 plan; resolved once already at the PR #45 ship gate, which narrowed the barrel export).
- **Recommending agent:** Fable (public API contract = genuine one-way door under semver).
- **Recommendation:** CONFIRM. `package.json`'s `exports` map (`"."` and `"./package.json"` only) already blocks external deep-imports of `canonicalizeCommitmentPayload` — it's more private than the assumption's own "reachable via deep import" caveat suggested, so the ship-gate split (barrel-export `commitmentHash` only) is the strongest reversible starting point. Cross-SDK symmetry with `macp-sdk-python` (which keeps its `canonical_projection` equivalent fully internal) is the right goal: exporting `canonicalizeCommitmentPayload` later is a purely additive minor; exporting now and retracting is a breaking change. Non-blocking follow-up: no compile-time frozen-field-set exhaustiveness guard on `CommitmentPayload` (vs. python-sdk's runtime `_check_frozen_field_set`) — cheap (~3 lines), doesn't change API or runtime behavior, tracked separately.
- **My verdict:** Confirm as-is.
- **Resulting status:** `CONFIRMED (2026-08-30)`. Follow-up: [#47](https://github.com/multiagentcoordinationprotocol/macp-sdk-typescript/issues/47) opened for the frozen-field-set exhaustiveness guard (non-blocking, no shipping impact).

## 2026-08-30 — supersedes: null / non-object collides with a legitimate empty-string CommitmentRef

- **Assumption:** `ASSUMPTIONS.md` — "supersedes: null / non-object collides with a legitimate empty-string CommitmentRef" (Phase 1, D3; residual inconsistency between the hasher's `!== undefined` check and the builder's truthy check, flagged by the Phase 2 verifier and carried forward unfixed to this reconcile pass).
- **Recommending agent:** Opus (low blast radius, internal defensive-coercion edge case).
- **Recommendation:** CHANGE. `buildCommitmentPayload`'s `if (input.supersedes)` truthy check silently dropped `supersedes: null` instead of validating/rejecting it — a real (if narrow) "same intent, different hash" trap between the builder path and the hasher path, and inconsistent with the builder's own established behavior of throwing on a malformed `commitmentHash` string. Recommended fix: treat any non-`undefined` `supersedes` as present, throw `MacpSessionError` on `null`/non-object before calling `validateCommitmentHash`, add a unit test for `supersedes: null`.
- **My verdict:** Change per recommendation.
- **Resulting status:** `CHANGED (2026-08-30)` — fix applied directly in this reconcile pass. `src/envelope.ts`'s `buildCommitmentPayload` now checks `input.supersedes !== undefined`, then throws `MacpSessionError` if the value isn't a non-null object, before validating the hash. Unit tests added to `tests/unit/envelope.test.ts` covering `null`, a non-object primitive, a bigint, an array, and an empty object. Full regression: 687 passed / 7 skipped (32 files), coverage unaffected vs floors 94/88/90/94. Does not close the hasher-side `supersedes: null` / empty-string-ref collision in `commitmentHash()` itself — that stays open by design (D3); see the ASSUMPTIONS.md entry's resolution note. A related but distinct bug was found during verification and filed separately, not fixed here: `if (someOptionalField)` truthy-check guards on `sessionId` in `base-session.ts`/`decision.ts`/`proposal.ts`/`task.ts`/`handoff.ts`/`quorum.ts` let an empty-string `sessionId` bypass `validateSessionId` entirely (worse than this bug — an invalid id reaches the wire instead of being dropped). Filed as [#48](https://github.com/multiagentcoordinationprotocol/macp-sdk-typescript/issues/48).
