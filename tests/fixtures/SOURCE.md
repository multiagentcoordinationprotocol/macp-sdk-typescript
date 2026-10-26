# Source

`receipt_keys.json` is a byte-identical copy of `examples/discovery/receipt_keys.json` in the
spec repo (`multiagentcoordinationprotocol/multiagentcoordinationprotocol`), commit `6bb4426`
("rfc(0013): optional runtime receipt issuance — GetDecisionReceipt, GetReceiptKeys", spec PR
#230), copied on 2026-10-26 for W5 S1. It is the JWK Set of the RFC-MACP-0013 A.5 example key
(`kid` `example-1`), i.e. what `GetReceiptKeys` returns from a runtime signing with that key.
macp-sdk-python vendors the same file at the same path.

Never edit it here; refresh it with `make sync-fixtures`. `make verify-fixtures` compares every
pair in the Makefile's `VENDORED_FILES` against its source under `SPEC_ROOT` byte for byte, and
flags any other `tests/fixtures/*.json` as EXTRA.
