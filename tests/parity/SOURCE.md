# Source

`contract.json` is a point-in-time copy of:

```
schemas/parity/contract.json
```

from the spec repo (`multiagentcoordinationprotocol/multiagentcoordinationprotocol`),
commit `4f15b96cac6e39d62925a5baa1ef80a42c2f818d` ("tooling(parity): add
schemas/parity/contract.json and hold it to its sources (#134) (#138)",
2026-09-20), copied on 2026-09-25 as part of `plans/sdk-parity-typescript.md`
Phase 5. `contract_version` at copy time: `1.0.0`.

## Why this directory lives outside `tests/conformance/`

Same reasoning as `tests/vectors/cmt-hash/SOURCE.md`: `tests/conformance/` is
covered by the flat, non-recursive `verify-fixtures` gate, which diffs every
`*.json` directly inside `tests/conformance/` against the spec repo's flat
`schemas/conformance/*.json`. `contract.json` lives at `schemas/parity/contract.json`
in the spec repo — a different top-level directory entirely, not a
subdirectory of `schemas/conformance/`. Folding it into `tests/conformance/`
would make `verify-fixtures` flag it `EXTRA:` (no flat canonical counterpart
under `schemas/conformance/`). So it gets its own directory, `tests/parity/`,
gated by its own `Makefile` targets (`sync-parity`/`verify-parity`) mirroring
`sync-fixtures`/`verify-fixtures` but scoped to this one file.

## How the copy is kept honest

`make verify-parity` (`Makefile`) does a single-file `diff -q` against
`$(SPEC_PARITY_DIR)/contract.json` — a canonical file that differs from (or
is missing against) the vendored copy fails the gate with a clear error, the
same guard style as `verify-fixtures`. `make sync-parity` refreshes the
vendored copy from canonical in one step. CI runs the gate on every push to
`main` and every PR via `.github/workflows/conformance-fixtures.yml`, which
already checks the spec repo out to `_spec` for `verify-fixtures` and adds
one more step reusing that same checkout:
`make verify-parity SPEC_PARITY_DIR="$GITHUB_WORKSPACE/_spec/schemas/parity"`.

`tests/parity/contract.test.ts` asserts this SDK's actual runtime values
against every section of the vendored manifest whose `applies_to` names
`macp-sdk-typescript` — see that file's own header for the full list. This
is a parity-specific test; it does not replace the hand-picked unit tests in
`tests/commitment-hash.test.ts` or `tests/unit/projections/anomalies.test.ts`.

**Do not hand-edit `contract.json`.** Refresh it with `make sync-parity` and
commit the result, then re-run `make verify-parity` to confirm zero drift.

## Non-normative

`contract.json` is explicitly non-normative — see its own `$comment` field
and `schemas/parity/README.md` in the spec repo. Each section names its real
normative home (an RFC, a registry, a proto file) or says plainly that none
exists yet. This SDK's own docs must never cite `contract.json` itself as a
source of truth; cite the named RFC/registry/proto instead.

## Open items (from the spec repo's README, not resolved by this SDK)

- `contribute_payload` decode behavior on non-canonical inputs (leading
  whitespace, non-string `value`, empty payload) is deliberately not pinned
  — the three implementations don't yet agree off the canonical vectors.
- `contribute_acceptance` (`applies_to: [macp-runtime]` only) — whether this
  SDK should reject an empty `Contribute` payload is an open cross-SDK
  question. No assertion in `contract.test.ts` for this section; do not add
  one until `applies_to` actually names `macp-sdk-typescript` (a MINOR bump
  upstream).
