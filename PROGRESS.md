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

pushed feat/gate-cmt-hash-vectors fd7aedd98c99297bdcb89380489b9e9dc38a31a8
PR #51 opened: https://github.com/multiagentcoordinationprotocol/macp-sdk-typescript/pull/51

merged #51 (squash, a6f6ffa), CI green on Node 20/22/24 + verify-fixtures

## Backlog wrap (2026-08-31)

Closed out everything still open on the tracker: the two issues the RFC-MACP-0013
`/reconcile` pass had filed but not fixed, and both stale Dependabot PRs.

### #48 — empty-string `sessionId` bypassed validation — **Status: DONE** (`5e4dc25`, PR #52)

`if (options.sessionId)` was a truthy check, so an explicit `''` skipped
`validateSessionId` — and `'' ?? newSessionId()` is `''`, not a fresh id, because
empty string is not nullish. An invalid session id reached the wire. All six
sites now guard on `!== undefined`, converging on the form `base-session.ts:92`
already used for `maxSuspendMs` rather than inventing a new one. Audited for
siblings first: those six were the only truthy-guarded validation calls in `src/`.

### #47 — frozen-field-set guard for `CommitmentPayload` — **Status: DONE** (`5e4dc25`, PR #52)

A type alias that fails `tsc` in both directions — a field added to
`CommitmentPayload` but not projected, or removed from it while the projection
still emits it. Zero runtime cost; parity with macp-sdk-python's runtime
`_check_frozen_field_set`. The docblock pins the intended workflow when it goes
red (project the field, publish new vectors, *then* widen the union — never
widen the union alone), because the tempting fix is the wrong one.

Testing a type alias needs the compiler, not the runtime, so
`tests/unit/commitment-hash-frozen-fields.test.ts` runs the real `tsc` over
mutated copies of the real `src/types.ts`. Only the two-file closure is copied
(`types.ts` has no imports), so the temp project needs no `node_modules` beside
it — `typeRoots` points back at this repo. Three `tsc` runs, ~0.7s.

Both files proven non-vacuous before the PR opened: reintroducing the truthy
guard fails exactly the six empty-string cases and nothing else; deleting the
type alias kills both mutation cases while the control still passes.

### Dependabot #42 (actions) — **Status: MERGED** (`9b5fdc8`)

Green as filed, only stale — needed `gh pr update-branch` against a base that had
moved four commits, then merged as-is.

### Dependabot #44 (dev-dep majors) — **Status: CLOSED, superseded by PR #54** (`95f6274`)

Red on all three Node legs since 2026-08-01, and could never have gone green: the
group bumped `typescript` to `^7.0.2` while leaving `@typescript-eslint/*` at
`^8`, whose peer range is `typescript >=4.8.4 <6.1.0`. `npm ci` died on ERESOLVE
before a test ran. The failure was in the group's own composition, not here.

No stable typescript-eslint supports TypeScript 7 (8.68.0 is latest, same peer
range), so #54 took `typescript` to `^6.0.3` — the highest the linter can peer
against — with eslint ^10.9.1, vitest + coverage-v8 ^4.1.11, @types/node ^26.4.0,
and the `@typescript-eslint/*` floor raised to ^8.68.0 for eslint 10. Revisit 7.x
when typescript-eslint widens the range.

Two real breakages, both fixed rather than suppressed:

- `src/watchers.ts` — TS 6 + @types/node 26 pull in `lib.esnext.disposable`,
  making `AsyncGenerator` extend `AsyncDisposable`. Native `async function*`
  generators get that free; the hand-rolled iterator from
  `serverStreamToAsyncGenerator` did not. Implemented `[Symbol.asyncDispose]`
  (cancels the gRPC stream, same as `return()`) instead of casting the error
  away — watcher streams now also work under `await using`.
- **Coverage floors moved DOWN, and that is not rot.** Vitest 4 rewrote the v8
  provider to remap through a rolldown AST instead of `v8-to-istanbul` and
  deleted `ignoreEmptyLines`; there is no flag that restores the v3 numbers (I
  checked the installed package — the option is gone). The same 726 tests measure
  93.13/83.87/92.28/94.60 where v3 read 96.14/91.02/92.54/96.14, because the new
  mapping counts branches the old one missed: optional chaining, default
  parameters, logical short-circuits. Floors recalibrated to 91/81/90/92 on the
  documented measured-minus-2pp convention. Since a lowered floor in a diff is
  indistinguishable from a real regression, both `vitest.config.ts` and a new
  "The v3 → v4 measurement break" section in `docs/guides/testing.md` state
  outright that v3 and v4 percentages are different rulers and the old figures
  must not be recovered by widening `exclude`.

Also took `npm audit fix` while the lockfile was already being rewritten
(brace-expansion 5.0.7 → 5.0.9, GHSA-mh99-v99m-4gvg / GHSA-rgw5-rvv9-x895, via
eslint 10 → minimatch 10; dev-only). `npm audit` is clean at 0. Lockfile
regenerated with npm 11.19.0.

### Known follow-up, deliberately deferred

Vitest 4 warns that `vitest.config.ts` uses ESM syntax in a file loaded as
CommonJS and that Vite's `configLoader: 'native'` will become the default in a
future major. The fix is renaming to `.mts`, which touches eight references
across `package.json`, `README.md`, `docs/`, and two test docblocks — too wide to
bury in a dependency bump, and harmless until Vite flips the default.

Final: 726 passed / 7 skipped (35 files); `check`/`lint`/`format:check`/
`verify-fixtures`/`build` all exit 0; CI green on Node 20/22/24 for both PRs.
- What's next: tracker is empty. Release PR #53 (0.7.1) is open and NOT merged —
  merging it cuts a GitHub release and publishes to npm, which is the user's call.

### Release 0.7.1 — **Status: PUBLISHED** (2026-08-31)

Supersedes the "What's next" line above: PR #53 was merged on the user's explicit
instruction. It was `BEHIND` (cut before #54 landed), so the branch was updated
against the new toolchain first and CI re-run — green on Node 20/22/24 — rather
than merging on stale checks. Its diff was version bumps plus CHANGELOG only, so
it could not have reverted the dependency work.

Merged as `c19c8b8`; release-please cut tag `v0.7.1`; the publish workflow ran
`prepublishOnly` (check + lint + format:check + test + build) against the exact
published tree and `npm publish --provenance --access public` succeeded.
`macp-sdk-typescript@0.7.1` is live on npmjs.org, and `sdk-released` dispatched
to macp-playground. (`npm view` lagged a few minutes on 0.7.0 before propagating.)
- What's next: none. No open issues, no open PRs.

### `app-id` deprecation + action re-pin — **Status: DONE** (`d752176`, PR #56)

Every run of the three token-minting workflows was printing an
`actions/create-github-app-token` deprecation annotation for the `app-id` input.

Behaviour-neutral by inspection of the action at the pinned commit, not by
inference from the annotation text: `main.js` does
`core.getInput("client-id") || core.getInput("app-id")` and hands the result to
`createAppAuth({appId: ...})`, so both inputs are one code path. GitHub accepts
the numeric App ID or the Client ID as the JWT issuer, so `MACP_BOT_APP_ID` keeps
its value and no secret was rotated. Each of the three sites carries a comment
saying so — `client-id: ${{ secrets.MACP_BOT_APP_ID }}` otherwise reads as a
copy-paste error.

Also re-pinned the action to `bcd2ba4` (v3.2.0). Dependabot's #42 had moved it
from `@v2` to `@v3`, a floating tag, breaking this repo's convention that all
third-party actions are SHA-pinned; it was the last unpinned one. The two
`macp-ci` reusable workflows stay on `@v1` — first-party, out of scope.

Verified end to end rather than assumed: `release-please.yml` fires on every push
to `main`, so the merge itself exercised one call site. Run `33413547575` resolved
the action by SHA, logged `client-id: ***`, minted the token, and completed with
**zero annotations**.
- What's next: issue #55 (filed by the spec-repo session — Decision/Quorum
  projections are last-vote-wins where RFC-MACP-0007 §5.3 now says first stands).
  Not started; surfaced to the user.

## Issue #55 — first vote stands (RFC-MACP-0007 §5.3 / RFC-MACP-0011 §5)

Plan: `plans/rfc-0007-first-vote-stands.md` (7 phases), branch `fix/55-first-vote-stands`.
Phases accumulate into ONE PR — shipping first-wins without the anomalies surface
would release a tally change with no way to observe it.

### Planning — three passes, each found real defects in the one before

- **v1** found the second pinned test (`quorum.test.ts:102`, which with
  `requiredApprovals: 1` lets a duplicate ballot FABRICATE QUORUM), three doc
  passages documenting last-wins, and that spec PR #79's own commit message argues
  against citing it as compelling this change.
- **v2** dropped the `first-wins.ts` seam as pure indirection once the API was
  decided, found the conformance harness's own shadowed `ProjectionLike`
  (`conformance.test.ts:70`, structurally distinct from `src/agent/types.ts`'s
  despite the identical name), and inverted its own stderr acceptance criterion
  after actually reading `logging.ts`.
- **Adversarial reverify** returned GAPS with **25 items**, including a code path I
  had cited that the plan itself contradicts two paragraphs away, two doc-cleanup
  greps that would pass green while the misleading prose survived, and a predicate
  that would have re-run the entire conformance suite inside a unit test file.

### The finding that reordered the plan

Issue #55 is about vote cardinality. Verifying a peer's at-least-once argument
turned up that **redelivery is live on the standard happy path today**: each mode
session's `sendAndTrack` applies on ACK, then `GrpcTransportAdapter.start()`
subscribes with full history replay, and `Participant.processMessage` applies the
same `message_id` to the SAME projection instance. Every initiator envelope is
applied twice on `main`.

Map-keyed records mask it. **Seven accumulate-on-apply sites do not** — Decision
`evaluations`/`objections`, Proposal `accepts`/`rejections`, Task
`updates`/`completions`/`failures`. Task is the mode nobody in the issue thread
looked at, which is the argument for a base-level dedup guard rather than seven
per-site patches.

Consequence: had first-wins + anomalies shipped without `message_id` dedup, the
initiator's own vote would be flagged `duplicate_vote` with a WARNING on the flow
every agent uses. Dedup became Phase 2, ahead of all detection.

This finding went upstream and is now the recorded justification for
RFC-MACP-0006 §3.2's new **Redelivery** subsection (spec PR #80, `110add2`,
1.4.0-draft) — on the stronger grounds that RFC-MACP-0006 §3.2 sanctions the echo
and no conforming runtime can prevent it, so this was never one SDK's ordering
quirk. `:136` now names our seven sites almost literally; `:135` makes "the anomaly
must not fire on redelivery" a citable clause rather than a design preference.

### Cross-SDK coordination

Ran against `macp-sdk-python` throughout. Independent analyses converged on the
same observability shape (passive `anomalies` array + warn log, no callback, no
strict mode) and the same dedup placement. The seven-field record is a frozen
cross-SDK contract. Their count correction (2 → 7 sites) fixed my undercount; my
fixture count (17, not 18) fixed theirs. Divergence documented rather than
smoothed: our `Participant` and mode session share ONE projection instance, theirs
are two instances on two paths that never meet — so their protection is accidental
and ours is now stated intent.

### Phase 1 — accepted-only input contract — **Status: DONE** (`3fa2346`)

Verifier: Opus, 2 rounds. Round 1 GAPS (7 items), round 2 PASS.

Round-1 gaps, all closed: `BaseSession.sendAndTrack` misattributed as the mode
sessions' send path in the one canonical docblock the other five defer to (none of
the five extends it); a doc paragraph that would have become false inside its own
PR; `file.ts:NNN` citations baked into shipped source, one of them scheduled to
rot in this same PR; a design-intent section that stated a position then retracted
it; an ext-mode assertion that only checked constructor defaults; and a committed
test whose `describe` title referenced a gitignored plan in CI output.

The `BaseSession` misattribution is the same error I made twice before. Root cause:
the plan-edit pass corrected the Context section but left Phase 1's Approach step
carrying the stale citation, so the plan contradicted itself and the executor
followed the half it was pointed at. **Fixed at the source with an explicit
"do not cite this" warning so the remaining six phases cannot inherit it.**
Correcting a fact in one place in a 949-line plan is not correcting it.

Deliberate divergences from the plan, both recorded rather than silently taken:
- Plan Approach step 1 instructs citing `conformance.test.ts:213` etc. literally;
  symbol references were used instead, to satisfy the "citations will rot" gap.
  `grep -rn '\.ts:[0-9]' src/` went 3 → 0, so the fragile practice is gone rather
  than corrected in place.
- The `feat!` semver `ASSUMPTIONS.md` entry is Phase 7 content that landed in
  Phase 1's diff. Left in place — it is logged where `/reconcile` will find it and
  moving it gains nothing.

Known cosmetic item deferred to Phase 4's docs pass: the five mode docblocks and
the `describe` title use bare "§5.3", but RFC-MACP-0007 has no literal `### 5.3`
heading (it is item 3 under §5). `base.ts` explains this; the others do not.

Coverage unchanged at 93.13/83.87/92.28/94.60 with byte-identical absolute counts
— correct for a comment-only phase, with the consequence worth naming that
**nothing in CI guards those six docblocks**; delete all six and the suite stays
green. Enforced by review, not by tests.

729 passed / 7 skipped (36 files); check/lint/format:check/verify-fixtures/build
all exit 0.
- What's next: Phase 2 — `message_id` dedup at all six entry points, gating
  `transcript`. First real behavior change; fixes the seven double-counting sites.
