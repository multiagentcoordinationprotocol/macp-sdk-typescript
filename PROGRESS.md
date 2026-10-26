# PROGRESS — Receipt client methods (W5 S1)

Plan: `plans/receipt-client-methods.md`. Previous PROGRESS content (W3-era docs port, shipped) is in git history (`git log -- PROGRESS.md`).

## Repo map (relevant slice)

- `src/client.ts`
  - `requireAuth` :363 and `metadata` (auth fallback) :369.
  - `unary()` :380.
  - `getSession` :482 is the auth-required pattern; `getManifest` :563 is the transport-auth-only pattern.
  - `serverCapabilities` getter :321.
  - `whatIfReplay` ~:705-750 holds the only capability gate, to be factored out.
- `src/receipt.ts`
  - Browser-safe (no node:crypto/Buffer): `verifyReceipt` :430 (never throws, `hasOwnProperty` kid lookup :409) and `isRecord` :229.
  - Exported by name from `src/index.ts:36-54` and as the `./receipt` subpath (`package.json` exports).
- `src/types.ts`: `PolicyRegistryCapability` and `WhatIfReplayResult` sit near :100-180. `DecisionReceiptCapability` goes next to them.
- `src/constants.ts`: error codes. `HISTORY_UNAVAILABLE` follows `AGENT_NOT_FOUND`.
- Tests:
  - `tests/unit/client-unary.test.ts`: `describe('MacpClient.whatIfReplay')` is the template; `stubUnary` is in `tests/unit/helpers/grpc-stub.ts`.
  - `tests/unit/receipt.test.ts` and `tests/vectors/receipt.test.ts`: receipt tests. Vector `receipt_010_wire_match.json` has `trusted_keys` `{example-1: TDVz…}`.
  - `tests/unit/public-api-snapshot.json`: the runtime export list, sorted.
  - `tests/parity/contract.test.ts`: the permanent error-code map. RECEIPT_UNAVAILABLE stays out of it because it's provisional.
- `tests/integration/runtime.test.ts` and `.github/workflows/integration.yml`: the blocking job pins runtime 0.9.0; the canary runs `:latest`, continue-on-error.
- Spec (read-only):
  - `../multiagentcoordinationprotocol/rfcs/RFC-MACP-0013-commitment-hash.md` §13
  - `examples/discovery/receipt_keys.json`
  - `schemas/json/macp-receipt-keys.schema.json`
- Gotchas:
  - Never run `prettier --write` over the vendored `tests/conformance` / `tests/vectors` (memory).
  - Docs-only edits outside the root package go in `docs:` commits.
  - `.npmrc` points the scoped registry at GitHub Packages, so installs need a `gh auth token` userconfig.

PR strategy: Phases 1, 2 and 2b in one `feat:` PR (one SDK release with the S1 surface plus the otel vendoring that check-sdk-sync now expects). Phase 3 goes in a later PR, because it is BLOCKED-ON runtime R1.

## Phase log

- **2026-10-26: Phase 1 PASS (Opus verifier, complex: public types plus a trust-boundary helper; 2 rounds).**
  - Round 1 PASS with notes.
  - Round 2 re-checked the duplicate-kid change made at Python's request (any entry counts). It found GAPS in two stale doc lines, README and plan; both are fixed.
  - Files: Makefile, package.json/lock (proto 0.1.13), src/{constants,types,receipt,index}.ts, tests/fixtures/*, tests/unit/{receipt-keys,fixture-drift-gate}.test.ts, public-api-snapshot.json, README, docs/api/constants.md.
  - Next: Phase 2.
- **2026-10-26: Phase 2 PASS (Opus verifier, complex: public client RPCs plus a concurrency memo; 2 rounds).**
  - Round 1 PASS with 3 gaps:
    - the RECEIPT_UNAVAILABLE wording was too narrow (error-handling.md said to retry always)
    - the missing `cause` was undocumented
    - deadline and explicit-auth tests were missing
  - All three are closed.
  - Files: src/client.ts, tests/unit/client-unary.test.ts, README.md, docs/api/{client,errors}.md, docs/guides/error-handling.md, CLAUDE.md (local).
  - Next: Phase 2b.
- **2026-10-26: Phase 2b PASS (Opus verifier, simple; 1 round).**
  - Generalized `FIXTURE_FILES`/`SPEC_EXAMPLES_DIR` into `VENDORED_FILES`/`SPEC_ROOT`/`VENDORED_DIRS`, and vendored `tests/otel/macp-semconv.json` (spec 0f77753).
  - The verifier's notes (a colon-less entry guard, and the stale testing.md drift-gate section) were applied.
  - Also added a `signed`-only gate case to client-unary at macp-sdk-python's request.
  - Files: Makefile, tests/otel/*, tests/fixtures/SOURCE.md, tests/unit/{fixture-drift-gate,client-unary}.test.ts, docs/guides/testing.md, CLAUDE.md (local).
  - Next: finalization (§4), then ship.
