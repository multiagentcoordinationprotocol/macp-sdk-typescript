# Source

`multi_round_contribute_decode.json` is a byte-identical copy of
`tests/fixtures/multi_round_contribute_decode.json` in macp-sdk-python, commit `b567694` (its
PR #216), copied on 2026-11-01. It holds 460 Contribute payloads. Each `value` is what
macp-runtime's `parse_contribute_value(payload, 3)` (runtime `f93fd74`) returns for `hex`, and
`null` means the runtime refuses the payload. Python's oracle produced it; this SDK's oracle
(a scratch crate linking `macp-modes`) agrees on every case.

The spec repo doesn't own this corpus, so `make verify-fixtures` doesn't gate it (it isn't in the
Makefile's `VECTOR_DIRS`). Never edit it here, and don't run `prettier --write` on it. Refresh it
by copying the Python file again, then update the commit above.
