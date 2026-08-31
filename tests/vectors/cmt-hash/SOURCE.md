# Source

These `cmt_hash_*.json` vectors (and `vector-schema.json`) are a point-in-time copy of:

```
schemas/conformance/cmt-hash/
```

from the spec repo (`multiagentcoordinationprotocol/multiagentcoordinationprotocol`),
commit `646c3dd1ec6d2231fc8fc1dc9a570c2394bb3641` ("rfcs: add RFC-MACP-0013 (Canonical
Commitment Hash) (#67)", 2026-08-29), copied on 2026-08-29 as part of the RFC-MACP-0013
rollout. For the original copy, see `PROGRESS.md` Phase 3; for the gate that now covers
this directory, see the later "Gate cmt-hash vectors follow-up" section (Phase 3's own
"outside the drift gate" wording is superseded there).

## Why this directory lives outside `tests/conformance/`

`tests/conformance/` is under this repo's zero-drift gate (`make verify-fixtures`), which
diffs every `*.json` file directly inside `tests/conformance/` (non-recursive) against the
spec repo's **flat** `schemas/conformance/*.json`. The spec repo keeps the RFC-MACP-0013
vectors in a `schemas/conformance/cmt-hash/` *subdirectory*, not flat:

- Dropping them directly into `tests/conformance/` would make `verify-fixtures` flag them
  as `EXTRA:` (no flat canonical counterpart, since canonical keeps them in a
  subdirectory).
- Dropping them into a `tests/conformance/cmt-hash/` subdirectory would be invisible to
  `verify-fixtures`'s non-recursive glob — nothing would ever check them for drift,
  silently, forever.

So they live here, in `tests/vectors/cmt-hash/`, entirely outside `tests/conformance/`,
exercised instead by `tests/vectors/cmt-hash.test.ts` — collected by `vitest.config.ts`'s
`include: ['tests/**/*.test.ts']`, which is recursive.

## How the copy is kept honest

Unlike a plain manual snapshot, this directory **is** covered by the zero-drift gate:
`make verify-fixtures` (`Makefile`) checks it bidirectionally against
`$(SPEC_CONFORMANCE_DIR)/cmt-hash/` — a canonical file that differs from (or is missing
against) the vendored copy reports `DRIFT:`, and a vendored file with no canonical source
reports `EXTRA:` — alongside its pre-existing flat `tests/conformance/` checks, in the same
invocation. `make sync-fixtures` refreshes both fixture sets from canonical in one pass.
CI runs the gate on every push to `main` and every PR via
`.github/workflows/conformance-fixtures.yml`, which checks the spec repo out to `_spec` and
invokes `make verify-fixtures SPEC_CONFORMANCE_DIR="$GITHUB_WORKSPACE/_spec/schemas/conformance"`.

This closes the gap that the `macp-sdk-python` sibling still carries: its
`tests/vectors/cmt-hash/SOURCE.md` documents the same directory as a manual, ungated
snapshot ("nothing automatically diffs this copy against the spec repo"). That gap was
tracked here as [#50](https://github.com/multiagentcoordinationprotocol/macp-sdk-typescript/issues/50)
and closed by extending `verify-fixtures`/`sync-fixtures` to cover this directory; the
Python SDK's equivalent gap remains open on its committed `main` as of this writing
(a fix is reportedly in flight there), tracked separately.

**Residual blind spot:** the gate's globs are `*.json` and non-recursive. If the spec repo
ever added a deeper tier under this directory — say a `cmt-hash/v2/` holding new vectors
alongside the existing flat ones — the gate would go quiet rather than red, the same
invisibility problem this directory's own placement was designed to avoid, one level down.
Only that purely additive case is invisible: if the vectors were *moved* wholesale into a
subdirectory, the canonical-side glob would match nothing, and the gate goes red on the
resulting mismatch (verified).

This is deliberate, but the reason is narrower than "the glob has to stay non-recursive".
Both `cmt-hash` loops key on `basename` — the canonical-to-vendored loop diffs each
canonical file against `tests/vectors/cmt-hash/$b`, and the vendored-to-canonical loop
tests each vendored file for a `$(SPEC_CONFORMANCE_DIR)/cmt-hash/$b`. Recursing would let
two same-named files in different subdirectories collide, so it means reworking both loops
to key on the path relative to `cmt-hash/` rather than the bare filename. The canonical
directory has never gone that deep, so that rework is left as documented risk rather than
done now.

## Contents

Five vectors (`cmt_hash_001_minimal.json` through `cmt_hash_005_escapes.json`) plus
`vector-schema.json`. Do not hand-edit any file in this directory — refresh it with
`make sync-fixtures` and commit the result, then re-run `make verify-fixtures` to confirm
zero drift. Note: `make sync-fixtures` copies but never deletes — if a canonical vector is
renamed or removed upstream, `make verify-fixtures` still reports the orphaned local file
as `EXTRA:` after the sync; remove it by hand before re-running the gate.
