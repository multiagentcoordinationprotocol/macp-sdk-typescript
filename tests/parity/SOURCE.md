# Source

`contract.json` is a point-in-time copy of:

```
schemas/parity/contract.json
```

from the spec repo (`multiagentcoordinationprotocol/multiagentcoordinationprotocol`),
commit `aaac582a54ac53f46042e14e6dc72d7fdb039f33` (spec-repo PR
[#151](https://github.com/multiagentcoordinationprotocol/multiagentcoordinationprotocol/pull/151),
bumping `contract_version` to add four `collision_*` `contribute_payload` vectors),
last re-synced 2026-09-27 as part of fixing this repo's issue #107 (PR #118), whose
`verify-fixtures` CI check went red against `main` for this unrelated, repo-wide
drift. Originally copied on 2026-09-25 as part of `plans/sdk-parity-typescript.md`
Phase 5, at `contract_version` `1.0.0`. `contract_version` at last sync: `1.1.0`.

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

- `contribute_payload` — the canonical-proto/legacy-JSON length-collision band is now
  pinned by the four `collision_*` vectors, and empty-payload gating is settled (see
  the `contribute_acceptance` bullet below). What remains genuinely unpinned is
  narrower than it was at 1.0.0: what a decoder does with valid legacy JSON whose
  `value` is not a string. `macp-sdk-typescript` coerces it (`String(parsed.value ??
  '')`), `macp-sdk-python` passes it through uninterpreted, and `macp-runtime`
  declines it outright (its legacy-JSON reader requires a string `value`) — no two of
  the three agree, so no value is seeded here. Tracked upstream as spec-repo issue
  #142 (`schemas/parity/README.md` "Open items").
- `contribute_acceptance` (`applies_to: [macp-runtime]` only) — **settled, not
  pending an upstream bump.** Whether this SDK should reject an empty `Contribute`
  payload was an open cross-SDK question at 1.0.0 vendoring time; the spec repo has
  since decided `applies_to` stays `[macp-runtime]` permanently.
  `macp-runtime` is the sole acceptance gate for this mode (`parse_contribute_value`);
  both SDKs deliberately decode without raising instead of gating — this SDK's decode
  layer is observational rather than an acceptance gate, decoding zero bytes to `{}`
  under proto3 defaults (which gives `ContributePayload.value` no field presence, so
  an explicitly-empty payload and an absent one are the same zero bytes on the wire
  regardless). No assertion belongs in `contract.test.ts` for this section, and none
  should be added later expecting a MINOR bump that names `macp-sdk-typescript` —
  there isn't one coming.
