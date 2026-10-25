# Source

These `receipt_*.json` vectors (and `vector-schema.json`) are a point-in-time copy of:

```
schemas/conformance/receipt/
```

from the spec repo (`multiagentcoordinationprotocol/multiagentcoordinationprotocol`),
commit `0756067` ("schemas(conformance): decision-receipt vectors and a stdlib reference
verifier (RFC-MACP-0013 1.3.0-draft)", spec PR #217), copied on 2026-10-25 for W3.10
(decision receipts, `src/receipt.ts`). Never edit them here; refresh them with
`make sync-fixtures`.

They sit outside `tests/conformance/` for the same reason as `tests/vectors/cmt-hash/`
(see its `SOURCE.md`): upstream keeps them in a subdirectory. `make verify-fixtures` and
`make sync-fixtures` cover this directory bidirectionally through the Makefile's
`VECTOR_DIRS` list.

`tests/vectors/receipt.test.ts` asserts that `verifyReceipt(receipt, trusted_keys)` returns
exactly each vector's `expected`. It also rebuilds `receipt_001_attested`, the Appendix A
example, with `buildReceipt` and the A.5 key, and checks that the result is the same
receipt, key order included.
