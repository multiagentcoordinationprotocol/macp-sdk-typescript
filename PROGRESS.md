# PROGRESS — RFC-MACP-0013 canonical commitment hash (PR 5 of 5)

Plan (read-only, sibling repo): `../multiagentcoordinationprotocol/plans/cross-repo/macp-sdk-typescript-rfc-macp-0013.md`
Verified against `main` @ `ec51059` (plan's stated baseline).

## Repo map (relevant slice only)

- `src/types.ts:144-166` — `CommitmentRef` / `CommitmentPayload` interfaces (camelCase, no `?` except `policyVersion`, `outcomePositive`, `supersedes`).
- `src/envelope.ts:73-119` — `buildCommitmentRef` (:73-75, currently zero-validation pass-through), `buildCommitmentPayload` (:91-119, `supersedes` branch at :117).
- `src/proto-registry.ts:106-117` — prior art for the D2.2 proto3-bool-default trap (`Commitment.outcome_positive`), cite in PR body.
- `src/validation.ts` — existing validator idiom (`validateRequiredField`, `validateSessionId`) to extend in Phase 2.
- `src/index.ts` — wildcard barrel (`export * from './X'`), coverage-excluded.
- `vitest.config.ts` — coverage floors lines 94 / branches 88 / functions 90 / statements 94; `include: ['tests/**/*.test.ts']`, no config change needed for Phase 3.
- `Makefile` `verify-fixtures` — globs `tests/conformance/*.json` only (flat, non-recursive) against spec repo's `schemas/conformance/`; confirmed `tests/vectors/` is invisible to it, no Makefile change needed.
- `.prettierignore` — `dist/ proto/ coverage/ docs/ *.proto`; Phase 3 adds `tests/vectors/`.
- Spec vectors (source of truth for Phase 3): `../multiagentcoordinationprotocol/schemas/conformance/cmt-hash/*.json`, at spec commit `646c3dd`.

## Phase status

### Phase 1 — `src/commitment-hash.ts` — **Status: DONE**

- Verifier: Opus, 2 rounds (round 1: PASS-with-gaps → Sonnet fixer closed G1-G4/R1 → round 2: PASS, mutation-verified).
- Files touched: `src/commitment-hash.ts` (new), `tests/commitment-hash.test.ts` (new, 27 tests), `src/index.ts` (+1 barrel line).
- Commit: `ee131bc`. Verifier recommendation: accumulate toward the plan's closing PR rather than ship standalone, since `commitmentHash` becomes public API via the barrel before Phase 3 proves it against real spec vectors, and this repo's release-please workflow triggers on every push to `main`. (Accumulated as planned — shipped together with Phases 2-3 in the closing PR, see bottom of this file.)
- Informational (not blocking, logged to `ASSUMPTIONS.md`): `canonicalizeCommitmentPayload` is also barrel-exported (public API); `supersedes: null`/non-object hashes identically to an empty-string ref (out-of-contract input, D3-permitted).
- What's next: Phase 2.

### Phase 2 — validate `commitmentHash` in `buildCommitmentRef` + `buildCommitmentPayload`'s `supersedes` branch — **Status: DONE**

- Verifier: Opus, 2 rounds (round 1: GAPS on 1 real item (stale `docs/api/envelope.md` example) + 1 cosmetic → Sonnet fixer closed both → round 2: PASS).
- Files touched: `src/validation.ts` (+`validateCommitmentHash`), `src/envelope.ts` (both call sites wired, JSDoc updated), `docs/api/envelope.md`, `tests/unit/envelope.test.ts`, `tests/unit/validation.test.ts`.
- Commit: `6d83b9d` (`feat!:` — behavior break, callers passing an invalid `commitmentHash` string now get `MacpSessionError` instead of silent pass-through), same accumulate-toward-closing-PR reasoning as Phase 1, reinforced: this phase is itself a breaking change, so shipping it standalone ahead of Phase 3 would mean two breaking-ish releases where one suffices.
- Residual, out-of-phase-scope holes flagged by the verifier (not fixed, by design — logging for the closing PR body, not blocking Phase 3):
  - `ProtoRegistry.encodeKnownPayload` remains an unvalidated wire path for a hand-built `CommitmentPayload` that bypasses `buildCommitmentPayload` entirely (demonstrated live by `tests/unit/proto-registry.test.ts:132`'s `'abc123'` fixture, which is correctly untouched by this phase).
  - `buildCommitmentRef` validates `commitmentHash` but not `sessionId` (asymmetric; `validateSessionId` exists but isn't called here — plan only asked for the hash).
  - `src/envelope.ts:122`'s `if (input.supersedes)` is a truthy check, not `!== undefined`; `supersedes: null` (reachable only from JS/decoded payloads, not from TS) silently skips both validation and assignment in the builder, while `canonicalizeCommitmentPayload` (Phase 1) treats `null` as present via `!== undefined` — a builder/hasher inconsistency worth Phase 3 being aware of when building vector-runner payloads. _Fixed 2026-08-30 — see `DECISIONS.md`._
- What's next: Phase 3.

### Phase 3 — vector runner (`tests/vectors/cmt-hash/`, outside the `verify-fixtures` drift gate) — **Status: DONE**

- Verifier: Opus, 1 round PASS (2 non-blocking observations; independently re-derived vector 001 and 005 from RFC 8785 text via a from-scratch scratch implementation, and mutation-tested the runner twice — flipped a hash, flipped a payload field — confirming it isn't vacuous).
- Files touched: `tests/vectors/cmt-hash/*.json` (6 files, byte-identical to spec repo commit `646c3dd`), `tests/vectors/cmt-hash.test.ts` (23 tests), `.prettierignore`.
- Post-verify cleanup applied directly (cheap, safe, verifier-recommended, no need for another fixer round): narrowed `.prettierignore`'s `tests/vectors/` to `tests/vectors/cmt-hash/` (the plan's premise that this repo has no prettier config was wrong — `.prettierrc` exists and the vector JSON is already prettier-stable under it) and ran `npm run format` on the test file so it stays inside the CI `format:check` gate.
- Commit: `5b6d61c`.
- Full-suite regression after all 3 phases: 682 passed / 7 skipped (32 files), coverage 96.13/90.99/92.54/96.13 vs floors 94/88/90/94.
- What's next: **plan complete**, shipped as one PR — see "Ship" section below.

## Ship

- Ship-gate verifier (fresh Opus, full diff `ec51059...HEAD`): **PASS**, with 2 decisions and 4 trivial cleanups (no `src/` changes required). Decisions made and applied directly (not re-verified separately, both low-risk/reversible pre-1.0):
  - `release-please-config.json`: added `"bump-minor-pre-major": true` so the `feat!` commit bumps `0.6.0` → `0.7.0`, not `1.0.0` — the RFC itself is still a draft, an accidental major would misrepresent stability.
  - `src/index.ts`: narrowed the commitment-hash barrel export to `commitmentHash` only, dropping `canonicalizeCommitmentPayload` from the public surface — matches `macp-sdk-python`, which keeps its `canonical_projection` equivalent internal. Confirmed both test files already import it directly from `src/commitment-hash` rather than the barrel, so nothing broke.
  - Trivial cleanups applied in the same pass: this file's and `ASSUMPTIONS.md`'s "local only, not pushed" language, `docs/api/types.md`'s `CommitmentRef.commitmentHash` doc (now notes the enforced `sha256:<64 hex>` shape), and a stale path in `tests/vectors/cmt-hash.test.ts`'s top comment. `CLAUDE.md`'s Key Components/Test Structure lists were also updated with `commitment-hash.ts` + the two new test files, but `CLAUDE.md` is gitignored in this repo — that edit is local-only and not part of this PR's diff.
  - Non-blocking items for the PR body / follow-up: no compile-time frozen-field-set guard (vs. `macp-sdk-python`'s runtime `_check_frozen_field_set`) if `CommitmentPayload` ever grows a 10th field; validation is syntactic-only (checks shape, not that the hash was actually computed via `commitmentHash()`).

## Closing-PR plan

Land Phases 1-3 as **one PR** (public surface appears once, already vector-proven). PR body must call out, per the verifiers:

1. **Breaking change** (Phase 2, `feat!` commit `6d83b9d`): `buildCommitmentRef`/`buildCommitmentPayload({supersedes})` now throw `MacpSessionError` on a non-`sha256:<64 lowercase hex>` commitmentHash, where they previously passed anything through.
2. **No new dependency** (Phase 1): hand-written RFC 8785 serializer + `node:crypto`, no JCS library — the frozen 9-field projection has no JSON numbers/arrays so JCS's float-formatting requirement (its only dependency-justifying feature) is unreachable.
3. **`tests/conformance/` vs `tests/vectors/` split** (Phase 3): vectors live outside the `verify-fixtures` zero-drift gate by design (H13, matches `macp-sdk-python` PR 4 Phase 3) — vector drift is not machine-detected today, revisit if the pack grows. Source pinned at spec commit `646c3dd`.
4. **Public API surface**: `commitmentHash` is barrel-exported from `src/index.ts`; `canonicalizeCommitmentPayload` is deliberately NOT barrel-exported (importable from `./commitment-hash` directly, as both test suites do) — matches `macp-sdk-python`'s public surface, decided at the ship gate.
5. **Known residual holes, carried forward, not fixed** (all logged in Phase 2's entry above and in `ASSUMPTIONS.md`): `ProtoRegistry.encodeKnownPayload` remains an unvalidated wire path bypassing `buildCommitmentPayload`; `buildCommitmentRef` validates the hash but not `sessionId`; `src/envelope.ts`'s `if (input.supersedes)` truthy check vs. `canonicalizeCommitmentPayload`'s `!== undefined` check disagree on `supersedes: null` (reachable only from JS/decoded payloads). _The last item was fixed 2026-08-30 in the RFC-MACP-0013 `/reconcile` pass — see `DECISIONS.md`; the other two remain open._
6. **Lone-surrogate D3 consequence**: hashes identically to U+FFFD (Node's UTF-8 encoder substitutes before hashing) — documented in `src/commitment-hash.ts`, not a claimed cross-implementation guarantee.
7. Cite `src/proto-registry.ts:106-117` as prior art for why D2.2 (`??` materialization) is written the way it is — this codebase already found and fixed the identical proto3-bool-default trap once, on `Commitment.outcome_positive`.
8. **Release/versioning**: `feat!` commit `6d83b9d` intentionally ships as `0.7.0`, not `1.0.0` — `bump-minor-pre-major: true` added to `release-please-config.json` at the ship gate. `macp-sdk-python` shares the same config gap, unaddressed there.
9. **Migration note for consumers**: a legacy `commitmentHash` value replayed through `buildCommitmentRef`/`buildCommitmentPayload({supersedes})` now throws `MacpSessionError` — per RFC-MACP-0013 §9 this is a hard rejection with no dual-read period; a pre-0013 commitment chain must be re-issued through `commitmentHash()`. Decoding/reading existing sessions is unaffected.
10. **Frozen-field-set guard absent** (vs. `macp-sdk-python`'s runtime `_check_frozen_field_set`): if `CommitmentPayload` ever grows a 10th field, `canonicalizeCommitmentPayload` would silently keep hashing nine — recommend a follow-up issue for a compile-time `keyof CommitmentPayload` exhaustiveness assertion.

---

pushed feat/rfc-macp-0013-commitment-hash e261ec536f2404b80010baf294b8c6a73053137c

PR #45 opened: https://github.com/multiagentcoordinationprotocol/macp-sdk-typescript/pull/45

merged #45

## Reconcile follow-up (2026-08-30)

`/reconcile` ran over both `ASSUMPTIONS.md` entries left by this plan (see `DECISIONS.md`). One (public API surface) was CONFIRMED as-is, no code change. The other (`supersedes: null` builder/hasher divergence) was CHANGED — fixed on branch `fix/supersedes-null-reject`, shipped via a follow-on `/ship` pass. Two related, non-blocking follow-ups filed: [#47](https://github.com/multiagentcoordinationprotocol/macp-sdk-typescript/issues/47) (frozen-field-set guard), [#48](https://github.com/multiagentcoordinationprotocol/macp-sdk-typescript/issues/48) (empty-string `sessionId` bypasses validation, same truthy-check bug class, found during this fix's ship-gate verification).

pushed fix/supersedes-null-reject 0c522a7

PR #49 opened: https://github.com/multiagentcoordinationprotocol/macp-sdk-typescript/pull/49

merged #49 (squash, b4a68e3), CI green on Node 20/22/24 + verify-fixtures

## Gate cmt-hash vectors follow-up (2026-08-30)

[#50](https://github.com/multiagentcoordinationprotocol/macp-sdk-typescript/issues/50)
revisited the deferred cost recorded above (item 3 of "Closing-PR plan": "vector drift is
not machine-detected today, revisit if the pack grows") and closed it. Plan:
`plans/gate-cmt-hash-vectors.md`, on branch `feat/gate-cmt-hash-vectors`.

### Phase 1 — extend `verify-fixtures`/`sync-fixtures` to cover `tests/vectors/cmt-hash/` — **Status: DONE**

- Verifier: Opus, PASS in 1 round.
- Files touched: `Makefile` only — a canonical-subdirectory existence guard plus a second
  bidirectional diff/EXTRA loop pair (`$(SPEC_CONFORMANCE_DIR)/cmt-hash/*.json` ↔
  `tests/vectors/cmt-hash/`), mirroring the pre-existing flat `tests/conformance/` pair and
  feeding the same `drift` flag and exit.
- Commit: `553feb7`.
- No CI workflow change needed: `.github/workflows/conformance-fixtures.yml` already runs
  `make verify-fixtures` against `$GITHUB_WORKSPACE/_spec/schemas/conformance`, and
  `cmt-hash/` is a subdirectory of exactly that path.
- What's next: Phase 2.

### Phase 2 — provenance doc + sweep stale "outside the gate" claims — **Status: DONE**

- Commit: the `docs:` commit of this branch (it carries this entry, so it cannot cite its
  own sha; the squash sha is appended below on merge, as with #45 and #49).
- Files touched: `tests/vectors/cmt-hash/SOURCE.md` (new — records upstream path, source
  commit `646c3dd1ec6d2231fc8fc1dc9a570c2394bb3641`, copy date 2026-08-29, why the
  directory sits outside `tests/conformance/`, how `verify-fixtures`/`sync-fixtures` now
  keep it honest, and the one residual blind spot: only a purely *additive* deeper
  canonical tier — e.g. a `cmt-hash/v2/` alongside the existing flat files — is invisible
  to the gate's non-recursive `*.json` glob; a wholesale *move* of the vectors into a
  subdirectory goes red, since the canonical-side glob then matches nothing);
  `tests/vectors/cmt-hash.test.ts` (top docblock, "deliberately outside the drift gate" →
  now covered); `CLAUDE.md` (Test Structure entry, plus two new Build Commands lines for
  `make verify-fixtures`/`sync-fixtures` — local-only, gitignored, not part of this PR's
  diff); this file (this section).
- The "vector drift is not machine-detected today" line in the Closing-PR plan section
  above, the Phase 3 heading's "outside the `verify-fixtures` drift gate" wording, and the
  "Repo map" bullet's "`tests/vectors/` is invisible to it, no Makefile change needed"
  claim (line 14) were all left as-is — they were true when written and are shipped
  history. This section supersedes all three: as of `553feb7`, drift in
  `tests/vectors/cmt-hash/` is machine-detected, and the Makefile was changed to do it.
- `macp-sdk-python` still carries the original, ungated version of this cost on its
  committed `main` — a fix is in flight there on `fix/38-gate-cmt-hash-vectors`, using a
  data-driven `FIXTURE_DIR_PAIRS` loop rather than this repo's duplicated loop pair.
  Judged an acceptable divergence at the ship gate: that repo's Makefile already has a
  `help:` target and `##` self-documenting conventions the pair-loop form fits; this one
  is 88 lines of plain recipes where duplicating a two-loop pattern once is the local
  idiom. Issue #50's "same shape" is met where it asked — both gate bidirectionally, both
  carry a `SOURCE.md`, both need no workflow edit, both print the same `DRIFT:`/`EXTRA:`
  vocabulary. Revisit if a third fixture directory ever appears.

### Ship gate — **Opus, GAPS → fixed → shippable**

Six findings, none breaking; all closed before the PR opened.

- `PROGRESS.md` shipped the over-broad "a deeper canonical layout would go quiet" wording
  that `SOURCE.md` had already corrected, in the same commit that corrected it. Fixed.
- Phase 2's entry carried no commit sha. Fixed.
- `sync-fixtures` copies but never deletes, so after an upstream rename the printed
  remediation left the gate red and reprinted itself. Both the `Makefile` failure message
  and `SOURCE.md`'s recipe now say the orphan must be removed by hand.
- The directory guard covered a *missing* canonical `cmt-hash/` but not a present-but-empty
  one, which still expanded the glob literally. `[ -e "$f" ] || continue` added to all six
  loops, flat ones included. Verified this did not convert a real failure into a silent
  pass — the empty case still goes red via `EXTRA:`.
- `docs/guides/testing.md` — advertised by `docs/index.md` as the conformance-fixture
  reference — had never mentioned the Makefile targets and its `tests/` tree omitted
  `tests/vectors/` entirely. Documented both fixture sets, CI enforcement, and the
  deletion caveat; refreshed the stale coverage table.
- The gate itself had no test. Added `tests/unit/fixture-drift-gate.test.ts` (12 cases,
  commit `af806c0`), driving the real recipes against synthetic trees. The ship verifier
  called this a follow-up; taken now instead, since an untested drift gate is the same
  failure class this issue was filed about. Proven non-vacuous by six Makefile mutations
  — one of which exposed that the `sync-fixtures` guard was uncovered, so a twelfth case
  was added for it — plus three more run independently at the ship gate (neutering the
  pre-existing flat DRIFT loop, breaking its accumulation with an early `exit`, and
  mis-targeting `sync-fixtures`' copy destination), each killed by exactly the case that
  should catch it.

Final: 699 passed / 7 skipped (33 files), coverage 96.14/91.02/92.54/96.14 vs floors
94/88/90/94; `check`/`lint`/`format:check`/`verify-fixtures` all exit 0.
- What's next: none — issue #50 closed by this PR.
